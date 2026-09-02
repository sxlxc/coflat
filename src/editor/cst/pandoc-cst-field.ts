import { type EditorState, StateField } from "@codemirror/state";
import {
  PandocParser,
  type ChangedRange,
  type DocumentSemantics,
  type SemanticChangedRange,
  type SyntaxTree,
  type TextChange,
} from "pandocmd-cst";

interface PandocCstFieldValue {
  readonly parser: PandocParser;
  readonly tree: SyntaxTree;
  readonly changedRanges: readonly ChangedRange[];
  readonly semanticChangedRanges: readonly SemanticChangedRange[];
  /** Test/debug instrumentation, not a document version. */
  readonly updateCount: number;
}

export interface PandocCstInvalidations {
  readonly changedRanges: readonly ChangedRange[];
  readonly semanticChangedRanges: readonly SemanticChangedRange[];
}

const noChangedRanges: readonly ChangedRange[] = Object.freeze([]);
const noSemanticChangedRanges: readonly SemanticChangedRange[] = Object.freeze([]);

function assertSynchronized(text: string, tree: SyntaxTree): void {
  if (tree.text !== text) {
    throw new Error(
      `Pandoc CST text is out of sync with the CodeMirror document (${tree.text.length} !== ${text.length})`,
    );
  }
}

function fieldValue(
  parser: PandocParser,
  tree: SyntaxTree,
  changedRanges: readonly ChangedRange[],
  semanticChangedRanges: readonly SemanticChangedRange[],
  updateCount: number,
): PandocCstFieldValue {
  return Object.freeze({
    parser,
    tree,
    changedRanges,
    semanticChangedRanges,
    updateCount,
  });
}

/**
 * M6-A transaction spine. Existing renderers continue to use Coflat's old
 * parser until their CST inputs have Pandoc-parity coverage and are migrated.
 */
export const pandocCstField = StateField.define<PandocCstFieldValue>({
  create(state) {
    const parser = new PandocParser();
    const text = state.doc.toString();
    const tree = parser.parse(text);
    assertSynchronized(text, tree);
    return fieldValue(parser, tree, noChangedRanges, noSemanticChangedRanges, 0);
  },

  update(value, transaction) {
    if (!transaction.docChanged) {
      if (
        value.changedRanges.length === 0
        && value.semanticChangedRanges.length === 0
      ) {
        return value;
      }
      return fieldValue(
        value.parser,
        value.tree,
        noChangedRanges,
        noSemanticChangedRanges,
        value.updateCount,
      );
    }

    const changes: TextChange[] = [];
    transaction.changes.iterChanges((oldFrom, oldTo, newFrom, newTo) => {
      changes.push({ oldFrom, oldTo, newFrom, newTo });
    });

    const newText = transaction.newDoc.toString();
    const result = value.parser.update(newText, value.tree, changes);
    assertSynchronized(newText, result.tree);
    return fieldValue(
      value.parser,
      result.tree,
      result.changedRanges,
      result.semanticChangedRanges,
      value.updateCount + 1,
    );
  },
});

export function getPandocTree(state: EditorState): SyntaxTree {
  return state.field(pandocCstField).tree;
}

export function getPandocSemantics(state: EditorState): DocumentSemantics {
  return getPandocTree(state).semantics;
}

export function getPandocInvalidations(state: EditorState): PandocCstInvalidations {
  const value = state.field(pandocCstField);
  return Object.freeze({
    changedRanges: value.changedRanges,
    semanticChangedRanges: value.semanticChangedRanges,
  });
}

/** Test/debug instrumentation; this count is not a CST document version. */
export function getPandocCstUpdateCountForTesting(state: EditorState): number {
  return state.field(pandocCstField).updateCount;
}
