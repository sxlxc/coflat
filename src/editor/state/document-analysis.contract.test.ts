import { describe, expect, it } from "vitest";
import { pandocCstField } from "../cst";
import { createEditorState } from "../test-utils";
import {
  documentAnalysisField,
  documentAnalysisFromSnapshot,
} from "./document-analysis";

describe("document analysis state contract", () => {
  it("publishes the shared semantic slices needed by renderers and crossrefs", () => {
    const doc = [
      "# Intro {#sec:intro}",
      "",
      "$$x^2$$ {#eq:one}",
      "",
      "See @sec:intro and [@eq:one].",
      "",
      "[^n]: note",
    ].join("\n");
    const state = createEditorState(doc, {
      extensions: [
        pandocCstField,
        documentAnalysisField,
      ],
    });
    const snapshot = state.field(documentAnalysisField);

    expect(documentAnalysisFromSnapshot(snapshot)).toBe(snapshot.analysis);
    expect(snapshot.headings).toHaveLength(1);
    // Equation labels were a Coflat-only extension. In the fixed Pandoc
    // dialect the trailing attribute is literal text, while the math itself
    // remains available to renderers.
    expect(snapshot.mathRegions).toHaveLength(1);
    expect(snapshot.equationById.get("eq:one")).toBeUndefined();
    expect(snapshot.referenceIndex.get("sec:intro")).toMatchObject({
      targetKind: "heading",
    });
    expect(snapshot.referenceIndex.get("eq:one")).toMatchObject({
      type: "citation",
      target: null,
    });
    expect(snapshot.footnotes.defs.get("n")?.content).toBe("note");
  });
});
