import { NodeType, Tree } from "@lezer/common";
import {
  PandocParser,
  headingLevel,
  listTight,
  mathDisplay,
  rawFormat,
  taskChecked,
  type SyntaxNode as PandocSyntaxNode,
  type SyntaxTree as PandocSyntaxTree,
} from "pandocmd-cst";
import { NODE } from "../constants/node-types.js";

/**
 * Temporary Lezer-shaped view over the authoritative Pandoc CST.
 *
 * A large part of Coflat's interaction/widget code accepts Lezer's public
 * `Tree`/`SyntaxNode` traversal surface. Rebuilding those consumers all at
 * once would throw away mature selection and geometry behavior, so M6 uses
 * this lossless, read-only projection while their inputs are converted. It
 * never parses Markdown: every node and range comes from one versioned
 * `pandocmd-cst` snapshot.
 */

const types = new Map<string, NodeType>();

function nodeType(name: string, top = false): NodeType {
  const key = `${top ? "top:" : "node:"}${name}`;
  let result = types.get(key);
  if (!result) {
    result = NodeType.define({ id: types.size, name, top });
    types.set(key, result);
  }
  return result;
}

function treeNode(
  name: string,
  from: number,
  to: number,
  children: readonly PositionedTree[] = [],
  top = false,
): PositionedTree {
  const ordered = [...children].sort((left, right) => left.from - right.from || left.tree.length - right.tree.length);
  return {
    from,
    tree: new Tree(
      nodeType(name, top),
      ordered.map(child => child.tree),
      ordered.map(child => child.from - from),
      to - from,
    ),
  };
}

interface PositionedTree {
  readonly from: number;
  readonly tree: Tree;
}

function children(node: PandocSyntaxNode, tree: PandocSyntaxTree): PositionedTree[] {
  return [...node.children()].flatMap(child => project(child, tree));
}

function firstChild(node: PandocSyntaxNode, kind: string): PandocSyntaxNode | null {
  for (const child of node.children()) if (child.kind === kind) return child;
  return null;
}

function allChildren(node: PandocSyntaxNode, kind: string): PandocSyntaxNode[] {
  return [...node.children()].filter(child => child.kind === kind);
}

function projectFencedCode(node: PandocSyntaxNode, tree: PandocSyntaxTree): PositionedTree[] {
  const fences = allChildren(node, "FenceMark");
  const opener = fences[0];
  const closer = fences.length > 1 ? fences.at(-1) : null;
  const info = firstChild(node, "CodeInfo");
  const lineEnding = [...node.children()].find(child => child.kind === "LineEnding" && child.from >= (info?.to ?? opener?.to ?? node.from));
  const projected: PositionedTree[] = [];
  if (opener) projected.push(treeNode(NODE.CodeMark, opener.from, opener.to));
  if (info) projected.push(treeNode(NODE.CodeInfo, info.from, info.to));
  const bodyFrom = lineEnding?.to ?? info?.to ?? opener?.to ?? node.from;
  let bodyTo = closer?.from ?? node.to;
  const beforeCloser = /(?:\r\n|\r|\n)$/.exec(tree.text.slice(bodyFrom, bodyTo));
  if (beforeCloser) bodyTo -= beforeCloser[0].length;
  if (bodyTo > bodyFrom) projected.push(treeNode(NODE.CodeText, bodyFrom, bodyTo));
  if (closer) projected.push(treeNode(NODE.CodeMark, closer.from, closer.to));
  return [treeNode(NODE.FencedCode, node.from, trimLineEnding(node, tree), projected)];
}

function projectFencedDiv(node: PandocSyntaxNode, tree: PandocSyntaxTree): PositionedTree[] {
  const fences = allChildren(node, "FenceMark");
  const opener = fences[0];
  const closer = fences.length > 1 ? fences.at(-1) : null;
  const projected: PositionedTree[] = [];
  if (opener) projected.push(treeNode(NODE.FencedDivFence, opener.from, opener.to));

  const openerEnd = tree.text.indexOf("\n", opener?.to ?? node.from);
  const infoTo = openerEnd < 0 || openerEnd > node.to ? node.to : openerEnd;
  const infoSource = tree.text.slice(opener?.to ?? node.from, infoTo);
  const leading = /^\s*/.exec(infoSource)?.[0].length ?? 0;
  const infoFrom = (opener?.to ?? node.from) + leading;
  if (infoFrom < infoTo) {
    const attribute = /^\{[^}\r\n]*\}/.exec(tree.text.slice(infoFrom, infoTo));
    if (attribute) {
      projected.push(treeNode(NODE.FencedDivAttributes, infoFrom, infoFrom + attribute[0].length));
      const titleFrom = infoFrom + attribute[0].length + (/^\s*/.exec(tree.text.slice(infoFrom + attribute[0].length, infoTo))?.[0].length ?? 0);
      if (titleFrom < infoTo) projected.push(treeNode(NODE.FencedDivTitle, titleFrom, infoTo));
    } else {
      projected.push(treeNode(NODE.FencedDivAttributes, infoFrom, infoTo));
    }
  }

  const bodyFrom = openerEnd < 0 ? node.to : openerEnd + 1;
  for (const child of node.children()) {
    if (child.from < bodyFrom || (closer && child.to > closer.from)) continue;
    projected.push(...project(child, tree));
  }
  if (closer) projected.push(treeNode(NODE.FencedDivFence, closer.from, closer.to));
  return [treeNode(NODE.FencedDiv, node.from, trimLineEnding(node, tree), projected)];
}

function projectListItem(node: PandocSyntaxNode, tree: PandocSyntaxTree): PositionedTree[] {
  const sourceChildren = [...node.children()];
  const markerIndex = sourceChildren.findIndex(child => child.kind === "ListMark");
  const marker = markerIndex >= 0 ? sourceChildren[markerIndex] : undefined;
  const blockKinds = new Set(["Paragraph", "Plain", "BulletList", "OrderedList", "BlockQuote", "FencedCodeBlock", "IndentedCodeBlock", "FencedDiv", "PipeTable", "SimpleTable", "MultilineTable", "GridTable"]);
  let blockIndex = sourceChildren.findIndex((child, index) =>
    index > markerIndex
    && (
      blockKinds.has(child.kind)
      || child.kind === "Math" && child.prop(mathDisplay) === true
    )
  );
  if (blockIndex < 0) blockIndex = sourceChildren.length;

  const projected: PositionedTree[] = [];
  if (marker) projected.push(treeNode(NODE.ListMark, marker.from, marker.to));
  const inline = sourceChildren.slice(markerIndex + 1, blockIndex);
  const meaningfulInline = inline.filter(child => child.kind !== "Whitespace" && child.kind !== "LineEnding" && child.kind !== "SoftBreak");
  const taskMarker = node.prop(taskChecked) !== undefined
    ? inline.find(child => child.kind === "BracketMark")
    : undefined;
  const inlineTo = trimTrailingBlankLines(
    meaningfulInline.at(-1)?.to ?? marker?.to ?? node.from,
    tree.text,
  );

  if (taskMarker) {
    const loose = node.parent?.prop(listTight) === false;
    const firstLineEnd = tree.text.indexOf("\n", taskMarker.to);
    const taskTo = loose && firstLineEnd >= 0 && firstLineEnd < inlineTo
      ? firstLineEnd
      : inlineTo;
    const taskChildren = [
      treeNode(NODE.TaskMarker, taskMarker.from, taskMarker.to),
      ...inline.flatMap(child => child === taskMarker ? [] : project(child, tree)),
    ];
    projected.push(treeNode(NODE.Task, taskMarker.from, taskTo, taskChildren.filter(child => child.from + child.tree.length <= taskTo)));
    if (taskTo < inlineTo) {
      let continuationFrom = taskTo;
      while (continuationFrom < inlineTo && /[\s]/.test(tree.text[continuationFrom] ?? "")) continuationFrom++;
      if (continuationFrom < inlineTo) {
        projected.push(treeNode(NODE.Paragraph, continuationFrom, inlineTo));
      }
    }
  } else if (meaningfulInline.length > 0) {
    const contentFrom = meaningfulInline[0]?.from ?? node.from;
    const inlineChildren = inline.flatMap(child => project(child, tree));
    projected.push(treeNode(NODE.Paragraph, contentFrom, inlineTo, inlineChildren.filter(child => child.from + child.tree.length <= inlineTo)));
  }

  for (const child of sourceChildren.slice(blockIndex)) projected.push(...project(child, tree));
  const to = trimTrailingBlankLines(node.to, tree.text);
  return [treeNode(NODE.ListItem, marker?.from ?? node.from, to, projected.filter(child => child.from + child.tree.length <= to))];
}

function trimTrailingBlankLines(to: number, text: string): number {
  const ending = /(?:[ \t]*(?:\r\n|\r|\n))+$/.exec(text.slice(0, to));
  return to - (ending?.[0].length ?? 0);
}

function trimLineEnding(node: PandocSyntaxNode, tree: PandocSyntaxTree): number {
  const ending = /(?:\r\n|\r|\n)$/.exec(tree.text.slice(node.from, node.to));
  return node.to - (ending?.[0].length ?? 0);
}

function projectList(node: PandocSyntaxNode, tree: PandocSyntaxTree, name: string): PositionedTree[] {
  const projected = children(node, tree);
  const from = projected[0]?.from ?? node.from;
  const to = trimLineEnding(node, tree);
  return [treeNode(name, from, to, projected.filter(child => child.from + child.tree.length <= to))];
}

function projectInlineCode(node: PandocSyntaxNode): PositionedTree[] {
  const projected: PositionedTree[] = [];
  for (const child of node.children()) {
    if (child.kind === "CodeMark") projected.push(treeNode(NODE.CodeMark, child.from, child.to));
    else if (child.kind === "OpaqueBody") projected.push(treeNode(NODE.CodeText, child.from, child.to));
  }
  return [treeNode(NODE.InlineCode, node.from, node.to, projected)];
}

function projectDelimited(
  node: PandocSyntaxNode,
  tree: PandocSyntaxTree,
  name: string,
  markName: string,
): PositionedTree[] {
  const projected: PositionedTree[] = [];
  for (const child of node.children()) {
    if (child.kind === "Delimiter") projected.push(treeNode(markName, child.from, child.to));
    else projected.push(...project(child, tree));
  }
  return [treeNode(name, node.from, node.to, projected)];
}

function projectHeading(
  node: PandocSyntaxNode,
  tree: PandocSyntaxTree,
  name: string,
): PositionedTree[] {
  const projected: PositionedTree[] = [];
  for (const child of node.children()) {
    if (child.kind === "Delimiter") {
      projected.push(treeNode(NODE.HeaderMark, child.from, child.to));
    } else {
      projected.push(...project(child, tree));
    }
  }
  const to = trimLineEnding(node, tree);
  return [treeNode(name, node.from, to, projected.filter(child => child.from + child.tree.length <= to))];
}

function projectBlockQuote(node: PandocSyntaxNode, tree: PandocSyntaxTree): PositionedTree[] {
  const projected: PositionedTree[] = [];
  const collectQuoteMarks = (candidate: PandocSyntaxNode): void => {
    if (candidate.kind === "QuoteMark") {
      projected.push(treeNode("QuoteMark", candidate.from, candidate.to));
      return;
    }
    for (const child of candidate.children()) collectQuoteMarks(child);
  };
  collectQuoteMarks(node);
  projected.push(...children(node, tree));
  const to = trimLineEnding(node, tree);
  return [treeNode(NODE.Blockquote, node.from, to, projected.filter(child => child.from + child.tree.length <= to))];
}

function projectMath(node: PandocSyntaxNode): PositionedTree[] {
  const display = node.prop(mathDisplay) ?? false;
  const name = display ? NODE.DisplayMath : NODE.InlineMath;
  const markName = display ? "DisplayMathMark" : "InlineMathMark";
  const projected = [...node.children()]
    .filter(child => child.kind === "MathMark")
    .map(child => treeNode(markName, child.from, child.to));
  return [treeNode(name, node.from, node.to, projected)];
}

function projectTable(node: PandocSyntaxNode, tree: PandocSyntaxTree): PositionedTree[] {
  const projected: PositionedTree[] = [];
  for (const child of node.children()) {
    if (child.kind === "TableHead") {
      const rows = allChildren(child, "TableRow");
      const header = rows.find(row => allChildren(row, "TableCell").length > 0);
      if (header) {
        const to = trimLineEnding(header, tree);
        projected.push(treeNode(
          NODE.TableHeader,
          header.from,
          to,
          children(header, tree).filter(item => item.from + item.tree.length <= to),
        ));
      }
      for (const row of rows) {
        if (row === header) continue;
        projected.push(treeNode(NODE.TableDelimiter, row.from, trimLineEnding(row, tree)));
      }
    } else if (child.kind === "TableBody" || child.kind === "TableFoot") {
      for (const row of allChildren(child, "TableRow")) {
        const to = trimLineEnding(row, tree);
        if (allChildren(row, "TableCell").length > 0) {
          projected.push(treeNode(
            NODE.TableRow,
            row.from,
            to,
            children(row, tree).filter(item => item.from + item.tree.length <= to),
          ));
        } else {
          projected.push(treeNode(NODE.TableDelimiter, row.from, to));
        }
      }
    } else {
      projected.push(...project(child, tree));
    }
  }
  return [treeNode(NODE.Table, node.from, trimLineEnding(node, tree), projected.filter(child => child.from + child.tree.length <= trimLineEnding(node, tree)))];
}

function projectTableCell(node: PandocSyntaxNode, tree: PandocSyntaxTree): PositionedTree[] {
  let from = node.from;
  let to = node.to;
  while (from < to && /[ \t]/.test(tree.text[from] ?? "")) from++;
  while (to > from && /[ \t]/.test(tree.text[to - 1] ?? "")) to--;
  return [treeNode(
    NODE.TableCell,
    from,
    to,
    children(node, tree).filter(child => child.from >= from && child.from + child.tree.length <= to),
  )];
}

function projectFootnoteDefinition(node: PandocSyntaxNode, tree: PandocSyntaxTree): PositionedTree[] {
  const labelClose = tree.text.indexOf("]:", node.from);
  const labelEnd = labelClose >= node.from ? labelClose + 2 : node.from;
  const projected = labelEnd > node.from
    ? [treeNode(NODE.FootnoteDefLabel, node.from, labelEnd), ...children(node, tree)]
    : children(node, tree);
  return [treeNode(NODE.FootnoteDef, node.from, trimLineEnding(node, tree), projected.filter(child => child.from + child.tree.length <= trimLineEnding(node, tree)))];
}

function paragraphFrom(node: PandocSyntaxNode): number {
  for (const child of node.children()) {
    if (child.kind !== "QuoteMark" && child.kind !== "Whitespace" && child.kind !== "Space") return child.from;
  }
  return node.from;
}

function soleDisplayMath(node: PandocSyntaxNode): PandocSyntaxNode | null {
  const meaningful = [...node.children()].filter(child =>
    child.kind !== "Whitespace"
    && child.kind !== "Space"
    && child.kind !== "SoftBreak"
    && child.kind !== "LineEnding"
    && child.kind !== "QuoteMark"
  );
  const only = meaningful.length === 1 ? meaningful[0] : undefined;
  return only?.kind === "Math" && only.prop(mathDisplay) === true ? only : null;
}

function projectParagraph(node: PandocSyntaxNode, tree: PandocSyntaxTree): PositionedTree[] {
  const sourceChildren = [...node.children()];
  const displayIndexes = sourceChildren.flatMap((child, index) =>
    child.kind === "Math" && child.prop(mathDisplay) === true ? [index] : []
  );
  if (displayIndexes.length === 0) {
    return [treeNode(
      NODE.Paragraph,
      paragraphFrom(node),
      trimLineEnding(node, tree),
      children(node, tree),
    )];
  }

  const projected: PositionedTree[] = [];
  const ignorable = new Set(["Whitespace", "Space", "SoftBreak", "LineEnding", "QuoteMark"]);
  const appendInlineSegment = (fromIndex: number, toIndex: number): void => {
    const segment = sourceChildren.slice(fromIndex, toIndex);
    const first = segment.find((child) => !ignorable.has(child.kind));
    let last: PandocSyntaxNode | undefined;
    for (let index = segment.length - 1; index >= 0; index -= 1) {
      const candidate = segment[index];
      if (candidate && !ignorable.has(candidate.kind)) {
        last = candidate;
        break;
      }
    }
    if (!first || !last) return;
    const segmentChildren = segment.flatMap((child) => project(child, tree));
    projected.push(treeNode(
      NODE.Paragraph,
      first.from,
      last.to,
      segmentChildren.filter((child) =>
        child.from >= first.from && child.from + child.tree.length <= last.to
      ),
    ));
  };

  let segmentFrom = 0;
  for (const displayIndex of displayIndexes) {
    appendInlineSegment(segmentFrom, displayIndex);
    const display = sourceChildren[displayIndex];
    if (display) projected.push(...projectMath(display));
    segmentFrom = displayIndex + 1;
  }
  appendInlineSegment(segmentFrom, sourceChildren.length);
  return projected;
}

function project(node: PandocSyntaxNode, tree: PandocSyntaxTree): PositionedTree[] {
  switch (node.kind) {
    case "Document": return [treeNode(NODE.Document, node.from, node.to, children(node, tree), true)];
    case "BlankLines": case "Space": case "SoftBreak": case "LineEnding": case "Whitespace":
    case "InlineText": case "Text": case "OpaqueBody": case "Attribute": case "AttributeName":
    case "AttributeValue": case "Identifier": case "ClassName": case "Delimiter": case "HtmlTag":
    case "ParenMark": case "BracketMark": case "FenceMark": case "MathMark": case "QuoteMark":
    case "ReferenceLabel": case "CitationKey": case "CitationPrefix": case "CitationSuffix":
    case "TableAlignment": case "SmartSequence": case "Entity":
      return [];
    case "AtxHeading": return projectHeading(node, tree, `ATXHeading${node.prop(headingLevel) ?? 1}`);
    case "SetextHeading": return projectHeading(node, tree, `SetextHeading${node.prop(headingLevel) ?? 1}`);
    case "FencedCodeBlock": return projectFencedCode(node, tree);
    case "IndentedCodeBlock": return [treeNode(NODE.CodeBlock, node.from, trimLineEnding(node, tree))];
    case "FencedDiv": return projectFencedDiv(node, tree);
    case "ListItem": return projectListItem(node, tree);
    case "Code": return projectInlineCode(node);
    case "Math": return projectMath(node);
    case "PipeTable": case "SimpleTable": case "MultilineTable": case "GridTable": return projectTable(node, tree);
    case "TableCell": return projectTableCell(node, tree);
    case "TableDelimiter": return [treeNode(NODE.TableDelimiter, node.from, node.to)];
    case "BlockQuote": return projectBlockQuote(node, tree);
    case "BulletList": return projectList(node, tree, NODE.BulletList);
    case "OrderedList": return projectList(node, tree, NODE.OrderedList);
    case "Paragraph": case "Plain": {
      const display = soleDisplayMath(node);
      return display ? projectMath(display) : projectParagraph(node, tree);
    }
    case "HorizontalRule": return [treeNode(NODE.HorizontalRule, node.from, trimLineEnding(node, tree))];
    case "Emphasis": return projectDelimited(node, tree, NODE.Emphasis, "EmphasisMark");
    case "Strong": return projectDelimited(node, tree, NODE.StrongEmphasis, "EmphasisMark");
    case "Strikeout": return projectDelimited(node, tree, NODE.Strikethrough, "StrikethroughMark");
    case "Superscript": return projectDelimited(node, tree, "Superscript", "SuperscriptMark");
    case "Subscript": return projectDelimited(node, tree, "Subscript", "SubscriptMark");
    case "Escape": return [treeNode(NODE.Escape, node.from, node.to)];
    case "LineBreak": return [treeNode(NODE.HardBreak, node.from, node.to)];
    case "Link": return [treeNode(NODE.Link, node.from, node.to, projectLinkChildren(node, tree))];
    case "Image": return [treeNode(NODE.Image, node.from, node.to, projectLinkChildren(node, tree))];
    case "AutoLink": return [treeNode("Autolink", node.from, node.to, [
      treeNode("URL", Math.min(node.to, node.from + 1), Math.max(node.from + 1, node.to - 1)),
    ])];
    case "ReferenceCandidate": {
      const resolved = tree.semantics.reference(node).status === "resolved";
      return resolved ? [treeNode(NODE.Link, node.from, node.to, projectLinkChildren(node, tree))] : [];
    }
    case "ImageReferenceCandidate": {
      const resolved = tree.semantics.reference(node).status === "resolved";
      return resolved ? [treeNode(NODE.Image, node.from, node.to, projectLinkChildren(node, tree))] : [];
    }
    case "Citation": case "ExampleReference":
      return [treeNode(NODE.Link, node.from, node.to, projectLinkChildren(node, tree))];
    case "LinkTitle": return [treeNode("LinkTitle", node.from, node.to)];
    case "ReferenceDefinition": return [treeNode("LinkReference", node.from, trimLineEnding(node, tree), [
      treeNode("LinkLabel", node.from, Math.max(node.from, tree.text.indexOf(":", node.from))),
    ])];
    case "FootnoteReference": return [treeNode(NODE.FootnoteRef, node.from, node.to)];
    case "FootnoteDefinition": return projectFootnoteDefinition(node, tree);
    case "YamlMetadata": return [treeNode(NODE.Frontmatter, node.from, trimLineEnding(node, tree))];
    case "RawBlock": {
      if (node.prop(rawFormat) !== "html") return [];
      const name = /^\s*<!--/.test(node.text()) ? NODE.CommentBlock : NODE.HTMLBlock;
      return [treeNode(name, node.from, trimLineEnding(node, tree))];
    }
    case "NativeHtmlDiv": return [treeNode(NODE.HTMLBlock, node.from, trimLineEnding(node, tree), children(node, tree))];
    default: return children(node, tree);
  }
}

function projectLinkChildren(node: PandocSyntaxNode, tree: PandocSyntaxTree): PositionedTree[] {
  const projected: PositionedTree[] = [];
  for (const child of node.children()) {
    if (child.kind === "BracketMark" || child.kind === "ParenMark") {
      projected.push(treeNode(NODE.LinkMark, child.from, child.to));
    } else if (child.kind === "LinkDestination") {
      projected.push(treeNode("URL", child.from, child.to));
    } else {
      projected.push(...project(child, tree));
    }
  }
  return projected;
}

/** Project one authoritative CST snapshot into Coflat's traversal shape. */
export function projectPandocSyntaxTree(syntax: PandocSyntaxTree): Tree {
  const document = project(syntax.root, syntax)[0];
  if (!document) throw new Error("CST projection did not produce a document root");
  return document.tree;
}

/** Parse a standalone string through the same CST used by the editor. */
export function parsePandocCstSource(source: string): Tree {
  return projectPandocSyntaxTree(new PandocParser().parse(source));
}
