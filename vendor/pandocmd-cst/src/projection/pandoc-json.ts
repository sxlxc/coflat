import {
  citationMode, fenceInfo, headingLevel, listTight, mathDisplay, normalizedCitationKey,
  orderedListDelimiter, orderedListStart, orderedListStyle, rawFormat,
  tableAlignments, tableColumnCount, taskChecked,
} from "../nodes.js";
import type { SyntaxNode, SyntaxTree } from "../tree.js";

type PandocValue = null | boolean | number | string | PandocValue[] | { [key: string]: PandocValue };
type PandocNode = { t: string; c?: PandocValue };
type Attr = [string, string[], [string, string][]];

function attributes(source: string): Attr {
  const match = /\{([^}]*)\}\s*$/.exec(source);
  if (!match) return ["", [], []];
  let id = "";
  const classes: string[] = [], pairs: [string, string][] = [];
  for (const token of match[1]!.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
    if (token.startsWith("#")) id = token.slice(1);
    else if (token.startsWith(".")) classes.push(token.slice(1));
    else {
      const equal = token.indexOf("=");
      if (equal > 0) pairs.push([token.slice(0, equal), token.slice(equal + 1).replace(/^(?:"|')|(?:"|')$/g, "")]);
    }
  }
  return [id, classes, pairs];
}

function nodeAttributes(node: SyntaxNode): Attr {
  const attribute = [...node.children()].find(child => child.kind === "AttributeList");
  return attributes(attribute?.text() ?? node.text());
}

function htmlAttributes(source: string): Attr {
  const opener = /^\s*<[A-Za-z][A-Za-z0-9-]*\b([^>]*)>/.exec(source);
  if (!opener) return ["", [], []];
  let id = "";
  const classes: string[] = [];
  const pairs: [string, string][] = [];
  for (const match of opener[1]!.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const name = match[1]!.toLocaleLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name === "id") id = value;
    else if (name === "class") classes.push(...value.split(/\s+/).filter(Boolean));
    else pairs.push([name, value]);
  }
  return [id, classes, pairs];
}

function decodeEntity(source: string): string {
  if (/^&#x/i.test(source)) return String.fromCodePoint(Number.parseInt(source.slice(3, -1), 16));
  if (source.startsWith("&#")) return String.fromCodePoint(Number.parseInt(source.slice(2, -1), 10));
  return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" } as Record<string, string>)[source.slice(1, -1)] ?? source;
}

function inlineChildren(node: SyntaxNode, tree: SyntaxTree): PandocNode[] {
  const result: PandocNode[] = [];
  for (const child of node.children()) result.push(...inline(child, tree));
  return result;
}

function mathBody(node: SyntaxNode, tree: SyntaxTree, body: string): string {
  if (!node.prop(mathDisplay)) return body;
  let ancestor = node.parent;
  while (ancestor && ancestor.kind !== "ListItem") ancestor = ancestor.parent;
  if (!ancestor) return body;

  // Pandoc removes the list-continuation prefix from every physical line in a
  // display-math body. The CST keeps those bytes so snapshots remain lossless;
  // normalize only the semantic projection.
  const line = tree.lines.lineAt(node.from);
  const prefix = tree.text.slice(tree.lines.lineStart(line), node.from);
  if (!/^[ \t]+$/.test(prefix)) return body;
  return body.replace(/(\r?\n)([ \t]*)/g, (_match, ending: string, whitespace: string) =>
    ending + (whitespace.startsWith(prefix) ? whitespace.slice(prefix.length) : whitespace));
}

function contentBetweenBrackets(node: SyntaxNode, tree: SyntaxTree): PandocNode[] {
  const result: PandocNode[] = [];
  let opened = false;
  for (const child of node.children()) {
    if (child.kind === "BracketMark") {
      if (opened) break;
      opened = true; continue;
    }
    if (opened) result.push(...inline(child, tree));
  }
  return result;
}

function trimFinalBreak(values: PandocNode[]): PandocNode[] {
  while (values.at(-1)?.t === "SoftBreak" || values.at(-1)?.t === "Space") values.pop();
  return values;
}

function trimInlineSpace(values: PandocNode[]): PandocNode[] {
  while (values[0]?.t === "Space" || values[0]?.t === "SoftBreak") values.shift();
  return trimFinalBreak(values);
}

function citationAffix(values: PandocNode[]): PandocNode[] {
  trimInlineSpace(values);
  for (let index = 0; index + 2 < values.length; index++) {
    const locator = values[index];
    const separator = values[index + 1];
    const value = values[index + 2];
    if (
      locator?.t === "Str"
      && typeof locator.c === "string"
      && /^(?:p|pp)\.$/i.test(locator.c)
      && separator?.t === "Space"
      && value?.t === "Str"
      && typeof value.c === "string"
    ) {
      values.splice(index, 3, { t: "Str", c: `${locator.c}\u00a0${value.c}` });
    }
  }
  return values;
}

function superSubscriptInlines(values: PandocNode[]): PandocNode[] {
  for (let index = 0; index + 2 < values.length; index++) {
    const left = values[index];
    const space = values[index + 1];
    const right = values[index + 2];
    if (
      left?.t === "Str" && typeof left.c === "string" && left.c.endsWith("\\")
      && space?.t === "Space"
      && right?.t === "Str" && typeof right.c === "string"
    ) {
      values.splice(index, 3, {
        t: "Str",
        c: `${left.c.slice(0, -1)}\u00a0${right.c}`,
      });
    }
  }
  return values;
}

function literalInlines(source: string): PandocNode[] {
  const result: PandocNode[] = [];
  for (const part of source.split(/([ \t]+|\r?\n)/)) {
    if (!part) continue;
    if (/^[ \t]+$/.test(part)) result.push({ t: "Space" });
    else if (/^\r?\n$/.test(part)) result.push({ t: "SoftBreak" });
    else result.push({ t: "Str", c: part });
  }
  return result;
}

function citationNoteNumber(node: SyntaxNode, tree: SyntaxTree): number {
  let number = 0;
  tree.iterate(candidate => {
    const unresolvedExampleCitation = candidate.kind === "ExampleReference" && tree.semantics.example(candidate).status === "unresolved";
    if ((candidate.kind === "Citation" || unresolvedExampleCitation) && candidate.from <= node.from) number++;
  }, { from: 0, to: node.to });
  return number;
}

function inline(node: SyntaxNode, tree: SyntaxTree): PandocNode[] {
  switch (node.kind) {
    case "InlineText": return [{
      t: "Str",
      c: node.text().replace(/(?<=[\p{L}\p{N}])'(?=[\p{L}\p{N}])/gu, "’"),
    }];
    case "Space": return [{ t: "Space" }];
    case "SoftBreak": return [{ t: "SoftBreak" }];
    case "LineBreak": return [{ t: "LineBreak" }];
    case "Escape": return [{ t: "Str", c: node.text().slice(1) }];
    case "Entity": return [{ t: "Str", c: decodeEntity(node.text()) }];
    case "SmartSequence": {
      const replacement = node.text() === "..." ? "…" : node.text() === "---" ? "—" : "–";
      return [{ t: "Str", c: replacement }];
    }
    case "Emphasis": return [{ t: "Emph", c: inlineChildren(node, tree) }];
    case "Strong": return [{ t: "Strong", c: inlineChildren(node, tree) }];
    case "Strikeout": return [{ t: "Strikeout", c: inlineChildren(node, tree) }];
    case "Superscript": return [{ t: "Superscript", c: superSubscriptInlines(inlineChildren(node, tree)) }];
    case "Subscript": return [{ t: "Subscript", c: superSubscriptInlines(inlineChildren(node, tree)) }];
    case "Quoted": return [{ t: "Quoted", c: [{ t: node.text().startsWith("\"") ? "DoubleQuote" : "SingleQuote" }, inlineChildren(node, tree)] }];
    case "Code": {
      const body = [...node.children()].find(child => child.kind === "OpaqueBody")?.text() ?? "";
      return [{ t: "Code", c: [nodeAttributes(node), body] }];
    }
    case "Math": {
      const body = [...node.children()].find(child => child.kind === "OpaqueBody")?.text() ?? "";
      return [{ t: "Math", c: [{ t: node.prop(mathDisplay) ? "DisplayMath" : "InlineMath" }, mathBody(node, tree, body)] }];
    }
    case "RawInline": {
      const codeBody = [...node.children()].some(child => child.kind === "CodeMark")
        ? [...node.children()].find(child => child.kind === "OpaqueBody")?.text() ?? ""
        : node.text().replace(/(?:\r?\n)$/, "");
      return [{ t: "RawInline", c: [node.prop(rawFormat) ?? "", codeBody] }];
    }
    case "AutoLink": {
      const target = node.text().slice(1, -1), label = target.replace(/^mailto:/, "");
      const email = target.includes("@") && !/^https?:/i.test(target);
      return [{ t: "Link", c: [["", [email ? "email" : "uri"], []], [{ t: "Str", c: label }], [email && !target.startsWith("mailto:") ? `mailto:${target}` : target, ""]] }];
    }
    case "Link":
    case "Image": {
      const destination = ([...node.children()].find(child => child.kind === "LinkDestination")?.text().replace(/^<|>$/g, "") ?? "").replace(/ /g, "%20");
      const title = [...node.children()].find(child => child.kind === "LinkTitle")?.text().trim().replace(/^(?:"|'|\()|(?:"|'|\))$/g, "") ?? "";
      return [{ t: node.kind, c: [nodeAttributes(node), contentBetweenBrackets(node, tree), [destination, title]] }];
    }
    case "ReferenceCandidate":
    case "ImageReferenceCandidate": {
      const resolution = tree.semantics.reference(node);
      if (resolution.status === "unresolved") return [{ t: "Str", c: node.text() }];
      return [{ t: node.kind === "ImageReferenceCandidate" ? "Image" : "Link", c: [["", [], []], contentBetweenBrackets(node, tree), [resolution.destination ?? "", resolution.title ?? ""]] }];
    }
    case "Span": return [{ t: "Span", c: [nodeAttributes(node), contentBetweenBrackets(node, tree)] }];
    case "NativeHtmlSpan": return [{ t: "Span", c: [htmlAttributes(node.text()), inlineChildren(node, tree)] }];
    case "Citation": {
      const note = citationNoteNumber(node, tree);
      const records = [...node.children()].filter(child => child.kind === "CitationItem").map(item => {
        const key = [...item.children()].find(child => child.kind === "CitationKey");
        const prefix = [...item.children()].find(child => child.kind === "CitationPrefix");
        const suffix = [...item.children()].find(child => child.kind === "CitationSuffix");
        const mode = item.prop(citationMode) ?? "normal";
        return {
          citationId: key?.text() ?? item.prop(normalizedCitationKey) ?? "",
          citationPrefix: prefix ? citationAffix(inlineChildren(prefix, tree)) : [],
          citationSuffix: suffix ? citationAffix(inlineChildren(suffix, tree)) : [],
          citationMode: { t: mode === "suppress-author" ? "SuppressAuthor" : mode === "author-in-text" ? "AuthorInText" : "NormalCitation" },
          citationNoteNum: note, citationHash: 0,
        };
      });
      const literalSource = node.text().startsWith("-@")
        ? node.text().slice(1)
        : node.text();
      return [{ t: "Cite", c: [records, literalInlines(literalSource)] }];
    }
    case "ExampleReference": {
      const resolution = tree.semantics.example(node);
      if (resolution.status === "resolved") return [{ t: "Str", c: node.text().startsWith("(") ? `(${resolution.number})` : `${resolution.number}` }];
      const parenthesized = node.text().startsWith("("), citationSource = parenthesized ? node.text().slice(1, -1) : node.text();
      const cite: PandocNode = { t: "Cite", c: [[{
        citationId: node.prop(normalizedCitationKey) ?? node.text().slice(1), citationPrefix: [], citationSuffix: [],
        citationMode: { t: "AuthorInText" }, citationNoteNum: citationNoteNumber(node, tree), citationHash: 0,
      }], literalInlines(citationSource)] };
      return parenthesized ? [{ t: "Str", c: "(" }, cite, { t: "Str", c: ")" }] : [cite];
    }
    case "InlineNote": return [{ t: "Note", c: [{ t: "Para", c: trimFinalBreak(inlineChildren(node, tree)) }] }];
    case "FootnoteReference": {
      const resolution = tree.semantics.footnote(node);
      if (resolution.status === "unresolved" || !resolution.definition) return [{ t: "Str", c: node.text() }];
      return [{ t: "Note", c: [{ t: "Para", c: trimFinalBreak(inlineChildren(resolution.definition, tree)) }] }];
    }
    case "Text": return [{ t: "Str", c: node.text() }];
    default:
      if (node.childCount && !/Mark$/.test(node.kind) && node.kind !== "AttributeList" && node.kind !== "LinkDestination" && node.kind !== "LinkTitle") return inlineChildren(node, tree);
      return [];
  }
}

function block(node: SyntaxNode, tree: SyntaxTree): PandocNode[] {
  switch (node.kind) {
    case "BlankLines": case "ReferenceDefinition": case "FootnoteDefinition": case "YamlMetadata": case "TableCaption": return [];
    case "Paragraph": {
      const content = trimInlineSpace(inlineChildren(node, tree));
      if (content.length === 1 && content[0]?.t === "Image") {
        const image = content[0];
        const imageContent = Array.isArray(image.c) ? image.c : [];
        const imageAttributes = Array.isArray(imageContent[0]) ? imageContent[0] as PandocValue[] : ["", [], []];
        const figureAttributes = [imageAttributes[0] ?? "", [], []];
        const caption = Array.isArray(imageContent[1]) ? imageContent[1] : [];
        const figureImage = {
          ...image,
          c: [["", imageAttributes[1] ?? [], imageAttributes[2] ?? []], imageContent[1] ?? [], imageContent[2] ?? ["", ""]],
        };
        return [{
          t: "Figure",
          c: [
            figureAttributes,
            [null, [{ t: "Plain", c: caption }]],
            [{ t: "Plain", c: [figureImage] }],
          ],
        }];
      }
      const htmlNeighbor = [node.previousSibling(), node.nextSibling()].some(sibling =>
        sibling?.kind === "RawBlock" && sibling.prop(rawFormat) === "html"
      );
      return [{ t: htmlNeighbor ? "Plain" : "Para", c: content }];
    }
    case "Plain": return [{ t: "Plain", c: trimFinalBreak(inlineChildren(node, tree)) }];
    case "AtxHeading": case "SetextHeading": {
      const info = tree.semantics.heading(node);
      return [{ t: "Header", c: [node.prop(headingLevel) ?? 1, [info.identifier, nodeAttributes(node)[1], nodeAttributes(node)[2]], trimFinalBreak(inlineChildren(node, tree))] }];
    }
    case "HorizontalRule": return [{ t: "HorizontalRule" }];
    case "FencedCodeBlock": case "IndentedCodeBlock": {
      let body: string;
      if (node.kind === "IndentedCodeBlock") body = node.text().replace(/^(?: {4}|\t)/gm, "").replace(/(?:\r?\n)$/, "");
      else {
        const children = [...node.children()];
        const openerEnd = children.findIndex(child => child.kind === "LineEnding");
        const closer = children.findIndex((child, index) => index > openerEnd && child.kind === "FenceMark");
        body = children.slice(openerEnd + 1, closer < 0 ? undefined : closer).map(child => child.text()).join("").replace(/(?:\r?\n)$/, "");
      }
      let attrs = attributes(node.text().split(/\r?\n/, 1)[0] ?? "");
      if (node.kind === "FencedCodeBlock" && attrs[0] === "" && attrs[1].length === 0 && attrs[2].length === 0) {
        const info = node.prop(fenceInfo)?.trim() ?? "";
        if (info) attrs = ["", [info.split(/[ \t]+/, 1)[0]!], []];
      }
      return [{ t: "CodeBlock", c: [attrs, body] }];
    }
    case "RawBlock": return [{ t: "RawBlock", c: [node.prop(rawFormat) ?? "", node.text().replace(/(?:\r?\n)$/, "")] }];
    case "BlockQuote": return [{ t: "BlockQuote", c: [...node.children()].flatMap(child => block(child, tree)) }];
    case "BulletList": return [{ t: "BulletList", c: [...node.children()].map(item => listItemBlocks(item, tree, node.prop(listTight) ?? true)) }];
    case "OrderedList": {
      const style = node.prop(orderedListStyle) ?? "decimal", delimiter = node.prop(orderedListDelimiter) ?? ".";
      const styleName = ({ decimal: "Decimal", "lower-alpha": "LowerAlpha", "upper-alpha": "UpperAlpha", "lower-roman": "LowerRoman", "upper-roman": "UpperRoman", example: "Example", default: "DefaultStyle" } as Record<string, string>)[style] ?? "DefaultStyle";
      const delimiterName = style === "example" ? "TwoParens" : style === "default" ? "DefaultDelim" : delimiter === ")" ? "OneParen" : "Period";
      return [{ t: "OrderedList", c: [[node.prop(orderedListStart) ?? 1, { t: styleName }, { t: delimiterName }], [...node.children()].map(item => listItemBlocks(item, tree, node.prop(listTight) ?? true))] }];
    }
    case "DefinitionList": {
      const entries: PandocValue[] = [];
      let current: [PandocValue, PandocValue[]] | null = null;
      for (const child of node.children()) {
        if (child.kind === "DefinitionTerm") {
          current = [trimFinalBreak(inlineChildren(child, tree)), []];
          entries.push(current);
        } else if (child.kind === "DefinitionBody" && current) {
          current[1].push([{ t: "Plain", c: trimFinalBreak(inlineChildren(child, tree)) }]);
        }
      }
      return [{ t: "DefinitionList", c: entries }];
    }
    case "LineBlock": return [{
      t: "LineBlock",
      c: [...node.children()].filter(child => child.kind === "LineBlockLine").map(child => trimFinalBreak(inlineChildren(child, tree))),
    }];
    case "PipeTable": case "SimpleTable": case "MultilineTable": case "GridTable":
      return [pandocTable(node, tree)];
    case "FencedDiv": case "NativeHtmlDiv": {
      const blockKinds = new Set([
        "Paragraph", "Plain", "AtxHeading", "SetextHeading", "HorizontalRule",
        "BlockQuote", "BulletList", "OrderedList", "DefinitionList", "LineBlock",
        "IndentedCodeBlock", "FencedCodeBlock", "RawBlock", "FencedDiv",
        "NativeHtmlDiv", "PipeTable", "SimpleTable", "MultilineTable", "GridTable",
      ]);
      return [{
        t: "Div",
        c: [
          node.kind === "NativeHtmlDiv"
            ? htmlAttributes(node.text().split(/\r?\n/, 1)[0] ?? "")
            : attributes(node.text().split(/\r?\n/, 1)[0] ?? ""),
          [...node.children()].filter(child => blockKinds.has(child.kind)).flatMap(child => block(child, tree)),
        ],
      }];
    }
    case "PandocTitleBlock": return [];
    default: return [{ t: "RawBlock", c: ["markdown", node.text().replace(/(?:\r?\n)$/, "")] }];
  }
}

function listItemBlocks(item: SyntaxNode, tree: SyntaxTree, tight: boolean): PandocNode[] {
  const result: PandocNode[] = [];
  const checked = item.prop(taskChecked);
  let pending: PandocNode[] = checked === undefined
    ? []
    : [{ t: "Str", c: checked ? "☒" : "☐" }, { t: "Space" }];
  const structural = new Set([
    "Paragraph", "Plain", "BlockQuote", "BulletList", "OrderedList",
    "DefinitionList", "LineBlock", "IndentedCodeBlock", "FencedCodeBlock",
    "RawBlock", "FencedDiv", "NativeHtmlDiv", "PipeTable", "SimpleTable",
    "MultilineTable", "GridTable",
  ]);
  const flush = (): void => {
    trimFinalBreak(pending);
    if (pending.length) result.push({ t: tight ? "Plain" : "Para", c: pending });
    pending = [];
  };
  for (const child of item.children()) {
    if (structural.has(child.kind)) {
      flush();
      result.push(...block(child, tree));
    } else {
      pending.push(...inline(child, tree));
    }
  }
  flush();
  return result;
}

function tableCell(cell: SyntaxNode, tree: SyntaxTree): PandocValue {
  return [
    ["", [], []],
    { t: "AlignDefault" },
    1,
    1,
    [{ t: "Plain", c: trimInlineSpace(inlineChildren(cell, tree)) }],
  ];
}

function tableRow(row: SyntaxNode, tree: SyntaxTree): PandocValue {
  return [
    ["", [], []],
    [...row.children()].filter(child => child.kind === "TableCell").map(cell => tableCell(cell, tree)),
  ];
}

function contentTableRows(section: SyntaxNode | undefined): SyntaxNode[] {
  if (!section) return [];
  return [...section.children()].filter(row =>
    row.kind === "TableRow" && [...row.children()].some(child => child.kind === "TableCell")
      && !/^\s*\|?\s*:?-{3,}/.test(row.text())
  );
}

function tableWidths(node: SyntaxNode, columns: number): PandocValue[] {
  if (node.kind === "SimpleTable" || node.kind === "PipeTable") {
    return Array.from({ length: columns }, () => ({ t: "ColWidthDefault" }));
  }
  const firstLine = node.text().split(/\r?\n/, 1)[0] ?? "";
  let widths: number[] = [];
  if (node.kind === "GridTable") {
    widths = [...firstLine.matchAll(/[^+]+/g)].map(match => match[0].length + 1);
  } else {
    const segments = [...firstLine.matchAll(/-{3,}/g)];
    widths = segments.map((match, index) => {
      const next = segments[index + 1];
      return next ? next.index! - match.index! : firstLine.length - match.index! + 1;
    });
  }
  return Array.from({ length: columns }, (_, index) => ({
    t: "ColWidth",
    c: (widths[index] ?? widths.at(-1) ?? 0) / 72,
  }));
}

function pandocTable(node: SyntaxNode, tree: SyntaxTree): PandocNode {
  const columns = node.prop(tableColumnCount) ?? 0;
  const alignments = node.prop(tableAlignments) ?? Array.from({ length: columns }, () => "default" as const);
  const widths = tableWidths(node, columns);
  const colspecs = Array.from({ length: columns }, (_, index) => [
    { t: `Align${(alignments[index] ?? "default").replace(/^./, value => value.toLocaleUpperCase())}` },
    widths[index]!,
  ]);
  const head = [...node.children()].find(child => child.kind === "TableHead");
  const body = [...node.children()].find(child => child.kind === "TableBody");
  const headRows = contentTableRows(head).map(row => tableRow(row, tree));
  const bodyRows = contentTableRows(body).map(row => tableRow(row, tree));
  const adjacentCaption = (direction: "previous" | "next"): SyntaxNode | null => {
    let sibling = direction === "previous" ? node.previousSibling() : node.nextSibling();
    if (sibling?.kind === "BlankLines") {
      sibling = direction === "previous" ? sibling.previousSibling() : sibling.nextSibling();
    }
    return sibling?.kind === "TableCaption" ? sibling : null;
  };
  const caption = adjacentCaption("previous") ?? adjacentCaption("next");
  return {
    t: "Table",
    c: [
      caption ? nodeAttributes(caption) : ["", [], []],
      [null, caption ? [{ t: "Plain", c: trimFinalBreak(inlineChildren(caption, tree)) }] : []],
      colspecs,
      [["", [], []], headRows],
      [[["", [], []], 0, [], bodyRows]],
      [["", [], []], []],
    ],
  };
}

/** Project syntax and intrinsic semantics to a Pandoc-shaped JSON document. */
export function projectPandocJson(tree: SyntaxTree): { "pandoc-api-version": number[]; meta: Record<string, never>; blocks: PandocNode[] } {
  return {
    "pandoc-api-version": [1, 23, 1, 2],
    meta: {},
    blocks: tree.topLevelBlocks().flatMap(node => block(node, tree)),
  };
}
