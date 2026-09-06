import type { EditorState, Transaction } from "@codemirror/state";
import type { ChangedRange, SourceRange } from "pandocmd-cst";
import { getPandocInvalidations, getPandocTree } from "./pandoc-cst-field";

interface ChangedBlockRanges {
  readonly oldRanges: readonly SourceRange[];
  readonly newRanges: readonly SourceRange[];
}

/** CM6 can reverse stored selection bounds when mapping across a replacement. */
export function selectionSourceRanges(state: EditorState): readonly SourceRange[] {
  return state.selection.ranges.map((range) => ({
    from: Math.min(range.from, range.to),
    to: Math.max(range.from, range.to),
  }));
}

function containingBlockRanges(
  state: EditorState,
  ranges: readonly SourceRange[],
  includeBoundaryLines = false,
): SourceRange[] {
  const tree = getPandocTree(state);
  const expanded = [...ranges];
  for (const range of ranges) {
    tree.iterate((node) => {
      if (node.parent?.kind !== "Document") return;
      expanded.push({ from: node.from, to: node.to });
      return false;
    }, includeBoundaryLines ? {
      from: state.doc.lineAt(Math.max(0, range.from - 1)).from,
      to: state.doc.lineAt(Math.min(tree.length, range.to + 1)).to,
    } : range);
  }
  const merged: SourceRange[] = [];
  for (const range of expanded.sort((left, right) => left.from - right.from)) {
    const last = merged.at(-1);
    if (last && range.from <= last.to) {
      merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, range.to) };
    } else merged.push(range);
  }
  return merged;
}

function sameRanges(left: readonly SourceRange[], right: readonly SourceRange[]): boolean {
  return left.length === right.length && left.every((range, index) => (
    range.from === right[index].from && range.to === right[index].to
  ));
}

/** Include both source owners when an edit splits, merges, or changes a block. */
export function changedBlockRanges(
  transaction: Transaction,
  additionalInvalidations: readonly ChangedRange[] = [],
): ChangedBlockRanges {
  if (!transaction.docChanged) return { oldRanges: [], newRanges: [] };
  const { changedRanges, fullReparse } = getPandocInvalidations(transaction.state);
  if (fullReparse || changedRanges.length === 0) {
    return {
      oldRanges: [{ from: 0, to: transaction.startState.doc.length }],
      newRanges: [{ from: 0, to: transaction.newDoc.length }],
    };
  }
  const invalidations = [...changedRanges, ...additionalInvalidations];
  const inverse = transaction.changes.invertedDesc;
  let oldRanges = containingBlockRanges(transaction.startState, invalidations.map((range) => ({
    from: Math.min(range.oldFrom, inverse.mapPos(range.newFrom, -1)),
    to: Math.max(range.oldTo, inverse.mapPos(range.newTo, 1)),
  })), true);
  let newRanges = containingBlockRanges(transaction.state, invalidations.map((range) => ({
    from: Math.min(range.newFrom, transaction.changes.mapPos(range.oldFrom, -1)),
    to: Math.max(range.newTo, transaction.changes.mapPos(range.oldTo, 1)),
  })), true);
  // A new code/math block can absorb old siblings beyond the reported range.
  // Expand mapped owners to a fixed point, without adding adjacent blocks.
  for (;;) {
    const oldExpanded = containingBlockRanges(transaction.startState, [
      ...oldRanges,
      ...newRanges.map((range) => ({
        from: inverse.mapPos(range.from, -1),
        to: inverse.mapPos(range.to, 1),
      })),
    ]);
    const newExpanded = containingBlockRanges(transaction.state, [
      ...newRanges,
      ...oldExpanded.map((range) => ({
        from: transaction.changes.mapPos(range.from, -1),
        to: transaction.changes.mapPos(range.to, 1),
      })),
    ]);
    if (sameRanges(oldRanges, oldExpanded) && sameRanges(newRanges, newExpanded)) {
      return { oldRanges, newRanges };
    }
    oldRanges = oldExpanded;
    newRanges = newExpanded;
  }
}
