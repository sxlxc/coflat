import { EditorState } from "@codemirror/state";
import fc from "fast-check";
import type { SyntaxNode } from "pandocmd-cst";
import { describe, expect, it, vi } from "vitest";
import {
  getPandocInvalidations,
  getPandocTree,
  pandocCstField,
} from "../cst/pandoc-cst-field";
import { collectCitationClusters, updateCitationClusters } from "./citation-model";

describe("incremental citation collection", () => {
  it("keeps fenced-div child traversal linear when collecting title and body citations", () => {
    const paragraphCount = 200;
    const opener = '::: {.theorem title="中文 😀 Result [@title]"}';
    const doc = `${opener}\n${"Body [@smith2024].\n\n".repeat(paragraphCount)}:::`;
    const state = EditorState.create({ doc, extensions: [pandocCstField] });
    const tree = getPandocTree(state);
    const prototype: Pick<SyntaxNode, "children"> = Object.getPrototypeOf(tree.root);
    const children = prototype.children;
    let visited = 0;
    const spy = vi.spyOn(prototype, "children").mockImplementation(function* (this: SyntaxNode) {
      for (const child of children.call(this)) {
        if (this.kind === "FencedDiv") visited += 1;
        yield child;
      }
    });
    try {
      const clusters = collectCitationClusters(tree);
      expect(clusters).toHaveLength(paragraphCount + 1);
      expect(clusters[0].opener).toEqual({ from: 0, to: opener.length });
      expect(clusters.slice(1).every((cluster) => cluster.opener === undefined)).toBe(true);
      expect(visited).toBeLessThan(paragraphCount * 20);

      const transaction = state.update({ changes: { from: doc.indexOf("Body") + 1, insert: "中文 😀" } });
      visited = 0;
      const updated = updateCitationClusters(transaction, clusters);
      expect(visited).toBeLessThan(paragraphCount * 20);
      expect(updated).toEqual(collectCitationClusters(getPandocTree(transaction.state)));
      expect(getPandocTree(transaction.state).text).toBe(transaction.newDoc.toString());
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps citation collection bounded after a localized prose edit", () => {
    const state = EditorState.create({
      doc: `${"中文 😀 Ordinary *prose*.\n\n".repeat(1_000)}TARGET.\n\nSee [@smith2024].`,
      extensions: [pandocCstField],
    });
    const previous = collectCitationClusters(getPandocTree(state));
    const transaction = state.update({
      changes: { from: state.doc.toString().indexOf("TARGET") + 1, insert: "More " },
    });
    expect(getPandocInvalidations(transaction.state).fullReparse).toBe(false);
    const tree = getPandocTree(transaction.state);
    const iterate = tree.iterate.bind(tree);
    let visited = 0;
    const spy = vi.spyOn(tree, "iterate").mockImplementation((visitor, range) => {
      iterate({
        enter(node) {
          visited += 1;
          return typeof visitor === "function" ? visitor(node) : visitor.enter?.(node);
        },
        ...(typeof visitor !== "function" ? { leave: visitor.leave } : {}),
      }, range);
    });
    const updated = updateCitationClusters(transaction, previous);
    const incrementalVisits = visited;
    const expected = collectCitationClusters(tree);
    expect(incrementalVisits).toBeLessThan(50);
    expect(visited - incrementalVisits).toBeGreaterThan(incrementalVisits * 100);
    spy.mockRestore();
    expect(updated).toEqual(expected);
    expect(updated[0].from).toBe(previous[0].from + 5);
    expect(tree.text).toBe(transaction.newDoc.toString());
  });

  it("recollects citations split at the end of a structural invalidation", () => {
    const state = EditorState.create({
      doc: "before [@first].\n\n:::: {.theorem #thm:a}\nBody [@inside].\n\n::: {.equation #eq:a}\n$$x$$\n:::\n\n::::\n\n# Title\n\nA|B\n---|---\nx|y\n\nAfter [@last].\n",
      extensions: [pandocCstField],
    });
    const previous = collectCitationClusters(getPandocTree(state));
    const transaction = state.update({ changes: { from: 119, to: 130, insert: "\n\n" } });
    const tree = getPandocTree(transaction.state);
    const updated = updateCitationClusters(transaction, previous);
    expect(updated).toEqual(collectCitationClusters(tree));
    expect(updated.at(-1)?.raw).toBe("@last");
  });

  it("matches full collection across syntax, Unicode, and remote example-resolution edits", () => {
    const doc = [
      "中文 😀 Prose [see @smith2024, pp. 2–3; @jones2020].",
      "",
      "::: {.lemma #smith2024}",
      "Narrative @jones2020 and *[@smith2024]*.",
      ":::",
      "",
      "(@smith2024) Example.",
      "",
      "See (@smith2024).",
      "",
      "`[@literal]` and [@last].",
    ].join("\n");
    fc.assert(fc.property(
      fc.integer({ min: 0, max: doc.length }),
      fc.integer({ min: 0, max: doc.length }),
      fc.constantFrom("", "😀", "\n", "[@new]", "`", "::: ", "(@smith2024)"),
      (left, right, insert) => {
        const state = EditorState.create({ doc, extensions: [pandocCstField] });
        const previous = collectCitationClusters(getPandocTree(state));
        const transaction = state.update({
          changes: { from: Math.min(left, right), to: Math.max(left, right), insert },
        });
        const tree = getPandocTree(transaction.state);
        expect(updateCitationClusters(transaction, previous)).toEqual(collectCitationClusters(tree));
      },
    ), { numRuns: 150, seed: 2317 });
  });
});
