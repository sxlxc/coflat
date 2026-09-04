import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { createSimpleEditor } from "../simple-editor";
import {
  getPandocCstUpdateCountForTesting,
  getPandocTree,
  pandocCstField,
} from "./pandoc-cst-field";

const benchmarkEnabled = process.env.COFLAT_CST_BENCHMARK === "1";
const warmupSamples = 20;
const measuredSamples = 50;

function generatedDocument(targetLength: number): string {
  const paragraph = "Ordinary prose with *emphasis*, [a link](doc.md), and $x+y$.\n\n";
  const chunks: string[] = [];
  let length = 0;
  while (length + paragraph.length < targetLength - 32) {
    chunks.push(paragraph);
    length += paragraph.length;
  }
  chunks.push("Localized TARGET paragraph.\n");
  return chunks.join("");
}

function generatedPipeTable(rowCount: number): string {
  return [
    "Name|Value",
    "---|---",
    ...Array.from(
      { length: rowCount },
      (_, index) => `row-${index}|${index}`,
    ),
    "",
  ].join("\n");
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

describe.skipIf(!benchmarkEnabled)("CST-backed CM6 transaction benchmark", () => {
  it("keeps a localized 700 KiB CST update below the M6 p95 target", {
    timeout: 10 * 60_000,
  }, () => {
    const doc = generatedDocument(700 * 1_024);
    const position = doc.indexOf("TARGET");
    let state = EditorState.create({ doc, extensions: [pandocCstField] });
    const durations: number[] = [];

    for (let index = 0; index < warmupSamples + measuredSamples; index += 1) {
      const start = performance.now();
      state = state.update({
        changes: {
          from: position,
          to: position + 1,
          insert: index % 2 === 0 ? "t" : "T",
        },
      }).state;
      if (index >= warmupSamples) durations.push(performance.now() - start);
    }

    expect(getPandocTree(state).text).toBe(state.doc.toString());
    expect(getPandocCstUpdateCountForTesting(state))
      .toBe(warmupSamples + measuredSamples);
    const p95Ms = percentile(durations, 0.95);
    process.stdout.write(`${JSON.stringify({
      operation: "700 KiB CST state transaction",
      p95Ms,
    })}\n`);
    expect(p95Ms).toBeLessThanOrEqual(8);
  });

  it("measures the complete editor transaction, including CST decorations", {
    timeout: 10 * 60_000,
  }, () => {
    const doc = generatedDocument(700 * 1_024);
    const position = doc.indexOf("TARGET");
    const parent = document.createElement("div");
    const view = createSimpleEditor({ parent, doc });
    const durations: number[] = [];

    try {
      for (let index = 0; index < warmupSamples + measuredSamples; index += 1) {
        const start = performance.now();
        view.dispatch({
          changes: {
            from: position,
            to: position + 1,
            insert: index % 2 === 0 ? "t" : "T",
          },
        });
        if (index >= warmupSamples) durations.push(performance.now() - start);
      }
      expect(getPandocTree(view.state).text).toBe(view.state.doc.toString());
      process.stdout.write(`${JSON.stringify({
        operation: "700 KiB complete editor transaction",
        p95Ms: percentile(durations, 0.95),
        visibleCodeUnits: view.visibleRanges.reduce(
          (total, range) => total + range.to - range.from,
          0,
        ),
      })}\n`);
    } finally {
      view.destroy();
    }
  });

  it("measures edits within a 1,000-row pipe table", {
    timeout: 10 * 60_000,
  }, () => {
    const doc = generatedPipeTable(1_000);
    const position = doc.indexOf("row-500");
    let state = EditorState.create({ doc, extensions: [pandocCstField] });
    const durations: number[] = [];

    for (let index = 0; index < warmupSamples + measuredSamples; index += 1) {
      const start = performance.now();
      state = state.update({
        changes: {
          from: position,
          to: position + 1,
          insert: index % 2 === 0 ? "R" : "r",
        },
      }).state;
      if (index >= warmupSamples) durations.push(performance.now() - start);
    }

    expect(getPandocTree(state).text).toBe(state.doc.toString());
    process.stdout.write(`${JSON.stringify({
      operation: "1,000-row pipe-table state transaction",
      p95Ms: percentile(durations, 0.95),
    })}\n`);
  });
});
