import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { getPandocTree, pandocCstField } from "./pandoc-cst-field";

function stateFor(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [pandocCstField],
  });
}

describe("fixed Pandoc dialect integration", () => {
  it("parses supported syntax and version-bound semantics in one CST", () => {
    const doc = [
      "---",
      "title: CST integration",
      "---",
      "",
      "# Heading {#sec:heading}",
      "",
      "::: {.theorem #thm:main}",
      "Body with **strong**, ~~strike~~, $x$, [@doe], and [^note].",
      ":::",
      "",
      "[^note]: Footnote body.",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
    ].join("\n");
    const state = stateFor(doc);
    const cst = getPandocTree(state);
    const kinds = new Set<string>();
    cst.iterate(node => { kinds.add(node.kind); });

    expect(cst.text).toBe(state.doc.toString());
    expect(cst.semantics).toBeDefined();
    for (const kind of [
      "YamlMetadata", "AtxHeading", "FencedDiv", "Strong", "Strikeout",
      "Math", "Citation", "FootnoteReference", "FootnoteDefinition", "PipeTable",
    ]) expect(kinds.has(kind)).toBe(true);
    cst.checkInvariants();
  });

  it("keeps disabled Coflat-only forms literal", () => {
    const cst = getPandocTree(stateFor("==highlight==\n\n::: {.algo}\nline\n:::\n"));
    const kinds = new Set<string>();
    cst.iterate(node => { kinds.add(node.kind); });

    expect(kinds.has("Highlight")).toBe(false);
    expect(kinds.has("AlgoLine")).toBe(false);
  });
});
