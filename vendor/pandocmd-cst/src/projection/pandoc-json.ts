import {
  citationMode, headingLevel, mathDisplay, normalizedCitationKey, orderedListDelimiter, orderedListStart, orderedListStyle, rawFormat,
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
    case "InlineText": return [{ t: "Str", c: node.text() }];
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
    case "Superscript": return [{ t: "Superscript", c: inlineChildren(node, tree) }];
    case "Subscript": return [{ t: "Subscript", c: inlineChildren(node, tree) }];
    case "Quoted": return [{ t: "Quoted", c: [{ t: node.text().startsWith("\"") ? "DoubleQuote" : "SingleQuote" }, inlineChildren(node, tree)] }];
    case "Code": {
      const body = [...node.children()].find(child => child.kind === "OpaqueBody")?.text() ?? "";
      return [{ t: "Code", c: [nodeAttributes(node), body] }];
    }
    case "Math": {
      const body = [...node.children()].find(child => child.kind === "OpaqueBody")?.text() ?? "";
      return [{ t: "Math", c: [{ t: node.prop(mathDisplay) ? "DisplayMath" : "InlineMath" }, body] }];
    }
    case "RawInline": {
      const body = [...node.children()].find(child => child.kind === "OpaqueBody")?.text() ?? node.text();
      return [{ t: "RawInline", c: [node.prop(rawFormat) ?? "", body] }];
    }
    case "AutoLink": {
      const target = node.text().slice(1, -1), label = target.replace(/^mailto:/, "");
      return [{ t: "Link", c: [["", [], []], [{ t: "Str", c: label }], [target.includes("@") && !target.startsWith("mailto:") ? `mailto:${target}` : target, ""]] }];
    }
    case "Link":
    case "Image": {
      const destination = [...node.children()].find(child => child.kind === "LinkDestination")?.text().replace(/^<|>$/g, "") ?? "";
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
    case "NativeHtmlSpan": return inlineChildren(node, tree);
    case "Citation": {
      const note = citationNoteNumber(node, tree);
      const records = [...node.children()].filter(child => child.kind === "CitationItem").map(item => {
        const key = [...item.children()].find(child => child.kind === "CitationKey");
        const prefix = [...item.children()].find(child => child.kind === "CitationPrefix");
        const suffix = [...item.children()].find(child => child.kind === "CitationSuffix");
        const mode = item.prop(citationMode) ?? "normal";
        return {
          citationId: key?.text() ?? item.prop(normalizedCitationKey) ?? "",
          citationPrefix: prefix ? trimInlineSpace(inlineChildren(prefix, tree)) : [],
          citationSuffix: suffix ? trimInlineSpace(inlineChildren(suffix, tree)) : [],
          citationMode: { t: mode === "suppress-author" ? "SuppressAuthor" : mode === "author-in-text" ? "AuthorInText" : "NormalCitation" },
          citationNoteNum: note, citationHash: 0,
        };
      });
      return [{ t: "Cite", c: [records, literalInlines(node.text())] }];
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
    case "FootnoteReference": return [{ t: "Str", c: node.text() }];
    case "Text": return [{ t: "Str", c: node.text() }];
    default:
      if (node.childCount && !/Mark$/.test(node.kind) && node.kind !== "AttributeList" && node.kind !== "LinkDestination" && node.kind !== "LinkTitle") return inlineChildren(node, tree);
      return [];
  }
}

function block(node: SyntaxNode, tree: SyntaxTree): PandocNode[] {
  switch (node.kind) {
    case "BlankLines": case "ReferenceDefinition": case "FootnoteDefinition": case "YamlMetadata": return [];
    case "Paragraph": return [{ t: "Para", c: trimFinalBreak(inlineChildren(node, tree)) }];
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
      return [{ t: "CodeBlock", c: [attributes(node.text().split(/\r?\n/, 1)[0] ?? ""), body] }];
    }
    case "RawBlock": return [{ t: "RawBlock", c: [node.prop(rawFormat) ?? "", node.text().replace(/(?:\r?\n)$/, "")] }];
    case "BlockQuote": return [{ t: "BlockQuote", c: [...node.children()].flatMap(child => block(child, tree)) }];
    case "BulletList": return [{ t: "BulletList", c: [...node.children()].map(item => [{ t: "Plain", c: trimFinalBreak(inlineChildren(item, tree)) }]) }];
    case "OrderedList": {
      const style = node.prop(orderedListStyle) ?? "decimal", delimiter = node.prop(orderedListDelimiter) ?? ".";
      const styleName = ({ decimal: "Decimal", "lower-alpha": "LowerAlpha", "upper-alpha": "UpperAlpha", "lower-roman": "LowerRoman", "upper-roman": "UpperRoman", example: "Example", default: "DefaultStyle" } as Record<string, string>)[style] ?? "DefaultStyle";
      const delimiterName = style === "example" ? "TwoParens" : style === "default" ? "DefaultDelim" : delimiter === ")" ? "OneParen" : "Period";
      return [{ t: "OrderedList", c: [[node.prop(orderedListStart) ?? 1, { t: styleName }, { t: delimiterName }], [...node.children()].map(item => [{ t: "Plain", c: trimFinalBreak(inlineChildren(item, tree)) }])] }];
    }
    case "FencedDiv": case "NativeHtmlDiv": return [{ t: "Div", c: [attributes(node.text().split(/\r?\n/, 1)[0] ?? ""), [...node.children()].flatMap(child => block(child, tree))] }];
    case "PandocTitleBlock": return [];
    default: return [{ t: "RawBlock", c: ["markdown", node.text().replace(/(?:\r?\n)$/, "")] }];
  }
}

/** Project syntax and intrinsic semantics to a Pandoc-shaped JSON document. */
export function projectPandocJson(tree: SyntaxTree): { "pandoc-api-version": number[]; meta: Record<string, never>; blocks: PandocNode[] } {
  return {
    "pandoc-api-version": [1, 23, 1, 2],
    meta: {},
    blocks: tree.topLevelBlocks().flatMap(node => block(node, tree)),
  };
}
