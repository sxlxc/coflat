import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { documentAnalysisField } from "../state/document-analysis";
import { getPandocTree, pandocCstField } from ".";

function stateFor(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [pandocCstField, documentAnalysisField],
  });
}

describe("fixed Pandoc dialect integration", () => {
  it("projects supported syntax and version-bound semantics from one CST", () => {
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
    const analysis = state.field(documentAnalysisField);
    const kinds = new Set<string>();
    cst.iterate(node => { kinds.add(node.kind); });

    expect(cst.text).toBe(state.doc.toString());
    expect(analysis.cstVersion).toBe(cst.version);
    for (const kind of [
      "YamlMetadata", "AtxHeading", "FencedDiv", "Strong", "Strikeout",
      "Math", "Citation", "FootnoteReference", "FootnoteDefinition", "PipeTable",
    ]) expect(kinds.has(kind)).toBe(true);
    expect(analysis.headings.map(heading => heading.id)).toEqual(["sec:heading"]);
    expect(analysis.fencedDivs.map(div => div.id)).toEqual(["thm:main"]);
    expect(analysis.mathRegions).toHaveLength(1);
    expect(analysis.references.map(reference => reference.ids)).toEqual([["doe"]]);
    expect([...analysis.footnotes.defs]).toHaveLength(1);
  });

  it("keeps disabled Coflat-only forms literal", () => {
    const cst = getPandocTree(stateFor("==highlight==\n\n::: {.algo}\nline\n:::\n"));
    const kinds = new Set<string>();
    cst.iterate(node => { kinds.add(node.kind); });

    expect(kinds.has("Highlight")).toBe(false);
    expect(kinds.has("AlgoLine")).toBe(false);
  });
});
