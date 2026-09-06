import { type EditorState, StateField } from "@codemirror/state";
import {
  type ChangedRange,
  type DocumentSemantics,
  PandocParser,
  type SemanticChangedRange,
  type SyntaxTree,
  type TextChange,
} from "pandocmd-cst";

interface PandocCstFieldValue extends PandocCstInvalidations {
  readonly parser: PandocParser;
  readonly tree: SyntaxTree;
  /** Test/debug instrumentation, not a document version. */
  readonly updateCount: number;
}

export interface PandocCstInvalidations {
  readonly changedRanges: readonly ChangedRange[];
  readonly semanticChangedRanges: readonly SemanticChangedRange[];
  /** Full fallbacks may change remote CST nodes outside the reported ranges. */
  readonly fullReparse: boolean;
}

const noChangedRanges: readonly ChangedRange[] = Object.freeze([]);
const noSemanticChangedRanges: readonly SemanticChangedRange[] = Object.freeze([]);
const detachedTrees = new WeakMap<object, SyntaxTree>();

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
  fullReparse = false,
): PandocCstFieldValue {
  return Object.freeze({
    parser,
    tree,
    changedRanges,
    semanticChangedRanges,
    updateCount,
    fullReparse,
  });
}

/** M6 transaction spine: the CST snapshot published with EditorState.doc. */
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
        && !value.fullReparse
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
      result.metrics.mode === "full-fallback",
    );
  },
});

export function getPandocTree(state: EditorState): SyntaxTree {
  const installed = state.field(pandocCstField, false);
  if (installed) return installed.tree;

  // Pure command/unit-test states sometimes install one feature in isolation.
  // Give those states the same CST semantics without requiring a CodeMirror
  // language parser. The shipped editor always installs pandocCstField, so
  // document-changing production transactions still perform exactly one
  // authoritative update through the field above.
  let tree = detachedTrees.get(state.doc as object);
  if (!tree) {
    tree = new PandocParser().parse(state.doc.toString());
    detachedTrees.set(state.doc as object, tree);
  }
  return tree;
}

export function getPandocSemantics(state: EditorState): DocumentSemantics {
  return getPandocTree(state).semantics;
}

export function getPandocInvalidations(state: EditorState): PandocCstInvalidations {
  const value = state.field(pandocCstField, false);
  if (!value) {
    return Object.freeze({
      changedRanges: noChangedRanges,
      semanticChangedRanges: noSemanticChangedRanges,
      fullReparse: false,
    });
  }
  return Object.freeze({
    changedRanges: value.changedRanges,
    semanticChangedRanges: value.semanticChangedRanges,
    fullReparse: value.fullReparse,
  });
}

/** Test/debug instrumentation; this count is not a CST document version. */
export function getPandocCstUpdateCountForTesting(state: EditorState): number {
  return state.field(pandocCstField).updateCount;
}
