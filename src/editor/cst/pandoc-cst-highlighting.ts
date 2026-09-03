import type { Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "pandocmd-cst";
import { getPandocTree } from "./pandoc-cst-field";

function ancestorKind(node: SyntaxNode, kinds: ReadonlySet<string>): string | null {
  let current: SyntaxNode | null = node;
  while (current) {
    if (kinds.has(current.kind)) return current.kind;
    current = current.parent;
  }
  return null;
}

const styledAncestors = new Set([
  "AtxHeading", "SetextHeading", "Strong", "Emphasis", "Strikeout",
  "Code", "FencedCodeBlock", "IndentedCodeBlock", "Math", "RawInline", "RawBlock",
  "Link", "Image", "AutoLink", "ReferenceCandidate", "ImageReferenceCandidate",
  "Citation", "CitationItem", "AttributeList",
]);

function leafClass(node: SyntaxNode): string | null {
  switch (node.kind) {
    case "FenceMark": case "CodeMark": case "MathMark": case "ListMark": case "QuoteMark":
    case "BracketMark": case "ParenMark": case "TableDelimiter": case "Delimiter":
      return "tok-punctuation";
    case "LinkDestination": return "tok-url";
    case "CitationKey": case "AttributeName": case "AttributeValue": case "ClassName": case "Identifier":
      return "tok-meta";
  }

  const ancestor = ancestorKind(node, styledAncestors);
  switch (ancestor) {
    case "AtxHeading": case "SetextHeading": return "tok-heading";
    case "Strong": return "tok-strong";
    case "Emphasis": return "tok-emphasis";
    case "Strikeout": return "tok-strikethrough";
    case "Code": case "FencedCodeBlock": case "IndentedCodeBlock": return "tok-monospace";
    case "Math": case "RawInline": case "RawBlock": return "tok-string";
    case "Link": case "Image": case "AutoLink": case "ReferenceCandidate": case "ImageReferenceCandidate": return "tok-link";
    case "Citation": case "CitationItem": case "AttributeList": return "tok-meta";
    default: return null;
  }
}

function buildCstHighlighting(view: EditorView): DecorationSet {
  const tree = getPandocTree(view.state);
  const ranges: Range<Decoration>[] = [];
  for (const visible of view.visibleRanges) {
    tree.iterate(node => {
      if (node.childCount !== 0 || node.to <= visible.from || node.from >= visible.to) return;
      const className = leafClass(node);
      if (className && node.from < node.to && !/[\r\n]/.test(node.text())) {
        ranges.push(Decoration.mark({ class: className }).range(node.from, node.to));
      }
    }, visible);
  }
  return Decoration.set(ranges, true);
}

/** Viewport-scoped source highlighting derived only from the complete CST. */
export const pandocCstHighlighting = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildCstHighlighting(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildCstHighlighting(update.view);
    }
  }
}, { decorations: value => value.decorations });
