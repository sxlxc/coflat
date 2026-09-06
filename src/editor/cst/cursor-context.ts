import { type EditorState, StateField } from "@codemirror/state";
import type { NodeKind, ResolveBias, SyntaxNode, SyntaxTree } from "pandocmd-cst";
import { getPandocTree } from "./pandoc-cst-field";

const INLINE_KINDS: ReadonlySet<NodeKind> = new Set([
  "Emphasis",
  "Strong",
  "Strikeout",
  "Superscript",
  "Subscript",
  "Quoted",
  "Code",
  "Math",
  "RawInline",
  "Link",
  "Image",
  "AutoLink",
  "ReferenceCandidate",
  "ImageReferenceCandidate",
  "Citation",
  "CitationItem",
  "FootnoteReference",
  "ExampleReference",
  "InlineNote",
  "Span",
  "NativeHtmlSpan",
]);

const BLOCK_KINDS: ReadonlySet<NodeKind> = new Set([
  "BlankLines",
  "YamlMetadata",
  "PandocTitleBlock",
  "Paragraph",
  "Plain",
  "AtxHeading",
  "SetextHeading",
  "HorizontalRule",
  "BlockQuote",
  "BulletList",
  "OrderedList",
  "DefinitionList",
  "ListItem",
  "DefinitionTerm",
  "DefinitionBody",
  "LineBlock",
  "LineBlockLine",
  "IndentedCodeBlock",
  "FencedCodeBlock",
  "RawBlock",
  "FencedDiv",
  "NativeHtmlDiv",
  "ReferenceDefinition",
  "FootnoteDefinition",
  "PipeTable",
  "SimpleTable",
  "MultilineTable",
  "GridTable",
  "TableCaption",
  "TableHead",
  "TableBody",
  "TableFoot",
  "TableRow",
  "TableCell",
]);

export interface PandocCursorNode {
  readonly kind: NodeKind;
  readonly from: number;
  readonly to: number;
}

export interface PandocCursorContext {
  readonly cstVersion: number;
  readonly position: number;
  readonly inline: PandocCursorNode | null;
  readonly block: PandocCursorNode | null;
  /** Structural ancestry from the document root to the resolved leaf. */
  readonly path: readonly PandocCursorNode[];
}

function snapshotNode(node: SyntaxNode): PandocCursorNode {
  return Object.freeze({
    kind: node.kind,
    from: node.from,
    to: node.to,
  });
}

function nearest(
  path: readonly SyntaxNode[],
  kinds: ReadonlySet<NodeKind>,
): PandocCursorNode | null {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const node = path[index];
    if (node && kinds.has(node.kind)) return snapshotNode(node);
  }
  return null;
}

/** Resolve through the CST's indexed range walk without enumerating root siblings. */
export function resolvePandocNode(
  tree: SyntaxTree,
  position: number,
  bias: ResolveBias = "right",
): SyntaxNode {
  if (!Number.isInteger(position) || position < 0 || position > tree.length) {
    throw new RangeError(`Offset ${position} is outside 0..${tree.length}`);
  }
  const from = Math.max(0, Math.min(
    tree.length - 1,
    position - (bias === "left" ? 1 : 0),
  ));
  let resolved = tree.root;
  tree.iterate((node) => {
    resolved = node;
  }, { from, to: Math.min(from + 1, tree.length) });
  return resolved;
}

export function resolvePandocCursorContext(
  tree: SyntaxTree,
  position: number,
): PandocCursorContext {
  const clamped = Math.max(0, Math.min(tree.length, position));
  const path: SyntaxNode[] = [];
  let node: SyntaxNode | null = resolvePandocNode(tree, clamped);
  while (node) {
    path.push(node);
    node = node.parent;
  }
  path.reverse();

  return Object.freeze({
    cstVersion: tree.version,
    position: clamped,
    inline: nearest(path, INLINE_KINDS),
    block: nearest(path, BLOCK_KINDS),
    path: Object.freeze(path.map(snapshotNode)),
  });
}

export const pandocCursorContextField = StateField.define<PandocCursorContext>({
  create(state) {
    return resolvePandocCursorContext(
      getPandocTree(state),
      state.selection.main.head,
    );
  },

  update(value, transaction) {
    if (
      !transaction.docChanged
      && transaction.state.selection.main.head === value.position
    ) return value;
    return resolvePandocCursorContext(
      getPandocTree(transaction.state),
      transaction.state.selection.main.head,
    );
  },
});

export function getPandocCursorContext(state: EditorState): PandocCursorContext {
  return state.field(pandocCursorContextField, false)
    ?? resolvePandocCursorContext(getPandocTree(state), state.selection.main.head);
}
