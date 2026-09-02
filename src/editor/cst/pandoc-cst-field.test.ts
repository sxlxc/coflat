import { history, redo, undo } from "@codemirror/commands";
import { EditorState, type Extension, StateEffect, Text, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  PandocParser,
  serializeTree,
  type NodeKind,
  type SyntaxNode,
  type SyntaxTree,
} from "pandocmd-cst";
import { describe, expect, it } from "vitest";
import {
  getPandocCstUpdateCountForTesting,
  getPandocInvalidations,
  getPandocSemantics,
  getPandocTree,
  pandocCstField,
} from ".";

function createState(doc: string | Text, extensions: Extension = []): EditorState {
  return EditorState.create({
    doc,
    extensions: [pandocCstField, extensions],
  });
}

function firstNode(tree: SyntaxTree, kind: NodeKind): SyntaxNode {
  let result: SyntaxNode | undefined;
  tree.iterate((node) => {
    if (!result && node.kind === kind) result = node;
  });
  if (!result) throw new Error(`Missing ${kind}`);
  return result;
}

function expectFullParseEquivalence(state: EditorState): void {
  const tree = getPandocTree(state);
  expect(tree.text).toBe(state.doc.toString());
  tree.checkInvariants();
  expect(serializeTree(tree)).toEqual(
    serializeTree(new PandocParser().parse(state.doc.toString())),
  );
}

describe("pandocCstField", () => {
  it("parses and validates the initial document exactly once", () => {
    const doc = "# Heading\n\nText $x$.\n";
    const state = createState(doc);
    const tree = getPandocTree(state);

    expect(tree.text).toBe(doc);
    expect(tree.root.from).toBe(0);
    expect(tree.root.to).toBe(doc.length);
    expect(getPandocSemantics(state)).toBe(tree.semantics);
    expect(getPandocInvalidations(state)).toEqual({
      changedRanges: [],
      semanticChangedRanges: [],
    });
    expect(getPandocCstUpdateCountForTesting(state)).toBe(0);
    tree.checkInvariants();
  });

  it("publishes one immutable snapshot for an ordinary localized edit", () => {
    const doc = "# Heading\n\nText in a paragraph.\n";
    const state = createState(doc);
    const oldTree = getPandocTree(state);
    const from = doc.indexOf("Text");
    const next = state.update({
      changes: { from, to: from + 4, insert: "Prose" },
    }).state;
    const newTree = getPandocTree(next);

    expect(newTree).not.toBe(oldTree);
    expect(newTree.version).toBeGreaterThan(oldTree.version);
    expect(oldTree.text).toBe(doc);
    expect(getPandocCstUpdateCountForTesting(next)).toBe(1);
    expectFullParseEquivalence(next);
  });

  it("applies disjoint length-changing edits as one ordered update", () => {
    const doc = "# One\n\nalpha beta.\n\nomega end.\n";
    const state = createState(doc);
    const secondFrom = doc.indexOf("omega");
    const next = state.update({
      changes: [
        { from: 2, to: 5, insert: "Long heading" },
        { from: secondFrom, to: secondFrom + 5, insert: "last" },
      ],
    }).state;
    const invalidations = getPandocInvalidations(next);

    expect(next.doc.toString()).toBe("# Long heading\n\nalpha beta.\n\nlast end.\n");
    expect(getPandocCstUpdateCountForTesting(next)).toBe(1);
    expect(invalidations.changedRanges.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < invalidations.changedRanges.length; index++) {
      const previous = invalidations.changedRanges[index - 1];
      const current = invalidations.changedRanges[index];
      if (!previous || !current) throw new Error("Missing ordered invalidation pair");
      expect(previous.oldTo).toBeLessThanOrEqual(current.oldFrom);
      expect(previous.newTo).toBeLessThanOrEqual(current.newFrom);
    }
    expectFullParseEquivalence(next);
  });

  it("retains the tree and clears stale invalidations for non-document transactions", () => {
    const state = createState("alpha beta\n");
    const edited = state.update({
      changes: { from: 0, to: 5, insert: "gamma" },
    }).state;
    const editedTree = getPandocTree(edited);
    expect(getPandocInvalidations(edited).changedRanges.length).toBeGreaterThan(0);

    const selected = edited.update({ selection: { anchor: 2 } }).state;
    const benignEffect = StateEffect.define<boolean>();
    const effected = selected.update({ effects: benignEffect.of(true) }).state;

    expect(getPandocTree(selected)).toBe(editedTree);
    expect(getPandocTree(effected)).toBe(editedTree);
    expect(getPandocTree(effected).version).toBe(editedTree.version);
    expect(getPandocCstUpdateCountForTesting(effected)).toBe(1);
    expect(getPandocInvalidations(selected)).toEqual({
      changedRanges: [],
      semanticChangedRanges: [],
    });
    expect(getPandocInvalidations(effected)).toEqual({
      changedRanges: [],
      semanticChangedRanges: [],
    });
  });

  it("updates synchronously through undo and redo", () => {
    const view = new EditorView({
      state: createState("alpha\n", [history()]),
    });
    const initialVersion = getPandocTree(view.state).version;

    view.dispatch({ changes: { from: 0, to: 5, insert: "beta" } });
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(1);
    expect(getPandocTree(view.state).version).toBeGreaterThan(initialVersion);
    expectFullParseEquivalence(view.state);

    const editedVersion = getPandocTree(view.state).version;
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("alpha\n");
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(2);
    expect(getPandocTree(view.state).version).toBeGreaterThan(editedVersion);
    expectFullParseEquivalence(view.state);

    const undoneVersion = getPandocTree(view.state).version;
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("beta\n");
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(3);
    expect(getPandocTree(view.state).version).toBeGreaterThan(undoneVersion);
    expectFullParseEquivalence(view.state);
    view.destroy();
  });

  it("preserves CRLF and UTF-16 coordinates after astral and combining text", () => {
    const doc = "😀 e\u0301\r\nSecond line.\r\n";
    const state = createState(Text.of(["😀 e\u0301\r", "Second line.\r", ""]));
    const from = doc.indexOf("Second");
    const next = state.update({
      changes: { from, to: from + "Second".length, insert: "下一" },
    }).state;

    expect(next.doc.toString()).toBe("😀 e\u0301\r\n下一 line.\r\n");
    expect(getPandocTree(next).text).toContain("\r\n");
    expectFullParseEquivalence(next);
  });

  it("handles a composition-shaped multi-code-unit replacement", () => {
    const doc = "入力: かな end";
    const state = createState(doc);
    const from = doc.indexOf("かな");
    const next = state.update({
      changes: { from, to: from + "かな".length, insert: "漢字🙂" },
      annotations: Transaction.userEvent.of("input.type.compose"),
    }).state;

    expect(next.doc.toString()).toBe("入力: 漢字🙂 end");
    expect(getPandocCstUpdateCountForTesting(next)).toBe(1);
    expectFullParseEquivalence(next);
  });

  it("exposes semantic invalidation without rebuilding an unchanged reference candidate", () => {
    const doc = "See [manual].\n";
    const state = createState(doc);
    const oldTree = getPandocTree(state);
    const oldCandidate = firstNode(oldTree, "ReferenceCandidate");
    expect(oldTree.semantics.reference(oldCandidate).status).toBe("unresolved");

    const definition = "\n[manual]: guide.pdf\n";
    const next = state.update({
      changes: { from: doc.length, insert: definition },
    }).state;
    const newTree = getPandocTree(next);
    const newCandidate = firstNode(newTree, "ReferenceCandidate");
    const invalidations = getPandocInvalidations(next);

    expect(newTree.sameSubtree(oldCandidate, newCandidate)).toBe(true);
    expect(newTree.semantics.reference(newCandidate)).toMatchObject({
      status: "resolved",
      destination: "guide.pdf",
    });
    expect(invalidations.semanticChangedRanges).toContainEqual({
      oldFrom: oldCandidate.from,
      oldTo: oldCandidate.to,
      newFrom: newCandidate.from,
      newTo: newCandidate.to,
      kinds: ["reference-resolution"],
    });
    expectFullParseEquivalence(next);
  });

  it("keeps parser versions, update counts, and invalidations editor-local", () => {
    let first = createState("first\n");
    let second = createState("second\n");
    const firstInitialTree = getPandocTree(first);
    const secondInitialTree = getPandocTree(second);

    first = first.update({ changes: { from: 0, to: 5, insert: "one" } }).state;
    expect(getPandocTree(first).version).toBe(firstInitialTree.version + 1);
    expect(getPandocTree(second)).toBe(secondInitialTree);
    expect(getPandocCstUpdateCountForTesting(first)).toBe(1);
    expect(getPandocCstUpdateCountForTesting(second)).toBe(0);

    second = second.update({ changes: { from: 0, to: 6, insert: "two" } }).state;
    first = first.update({ changes: { from: 3, insert: "!" } }).state;
    expect(getPandocTree(first).version).toBe(firstInitialTree.version + 2);
    expect(getPandocTree(second).version).toBe(secondInitialTree.version + 1);
    expect(getPandocCstUpdateCountForTesting(first)).toBe(2);
    expect(getPandocCstUpdateCountForTesting(second)).toBe(1);
    expect(getPandocInvalidations(first)).not.toBe(getPandocInvalidations(second));
    expectFullParseEquivalence(first);
    expectFullParseEquivalence(second);
  });
});
