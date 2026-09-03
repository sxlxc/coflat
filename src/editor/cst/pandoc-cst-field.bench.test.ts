import { type ChangeSpec, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  clearFrontendPerf,
  disableFrontendPerf,
  getFrontendPerfSnapshot,
} from "../lib/perf";
import { containerAttributesPlugin } from "../render/container-attributes";
import {
  getPandocCstUpdateCountForTesting,
  getPandocTree,
  pandocCstField,
} from ".";

const benchmarkEnabled = process.env.COFLAT_CST_BENCHMARK === "1";
// Optional selectors make expensive fallback paths independently reproducible.
const sizeFilter = Number(process.env.COFLAT_CST_BENCHMARK_SIZE_KIB ?? 0);
const operationFilter = process.env.COFLAT_CST_BENCHMARK_OPERATION?.toLocaleLowerCase();
const warmupSamples = 100;
const measuredSamples = 1_000;

interface BenchmarkOperation {
  readonly name: string;
  /** Eligible for the M6 ordinary-localized-edit release gate. */
  readonly localized: boolean;
  changes(iteration: number): ChangeSpec;
}

interface BenchmarkResult {
  readonly sizeKiB: number;
  readonly operation: string;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

function generatedDocument(targetLength: number): string {
  const targetSection = [
    "",
    "# Transaction benchmark target",
    "",
    "Ordinary local TARGET prose remains in one small paragraph.",
    "",
    "Inline math stays delimited: $MATH$.",
    "",
    "Paired markup surrounds PAIRTARGET when active.",
    "",
    "::: {.theorem}",
    "The axiom holds for the benchmark statement.",
    ":::",
    "",
    "Paste PASTETARGET appears here.",
    "",
    "Autocorrect fixes teh token and a wierd spelling together.",
    "",
  ].join("\n");
  const filler = [
    "## Generated section",
    "",
    "This deterministic paragraph contains ordinary prose and $x + y$ for localized edits.",
    "",
  ].join("\n");
  const chunks: string[] = [];
  let length = targetSection.length;
  while (length + filler.length <= targetLength) {
    chunks.push(filler);
    length += filler.length;
  }
  if (length < targetLength) chunks.push("x".repeat(targetLength - length));
  chunks.push(targetSection);
  return chunks.join("");
}

function operationsFor(doc: string): readonly BenchmarkOperation[] {
  const targetFrom = doc.indexOf("TARGET");
  const mathFrom = doc.indexOf("MATH");
  const pairFrom = doc.indexOf("PAIRTARGET");
  const pairTo = pairFrom + "PAIRTARGET".length;
  const theoremFrom = doc.indexOf("axiom");
  const pasteFrom = doc.indexOf("PASTETARGET");
  const firstTypoFrom = doc.indexOf("teh");
  const secondTypoFrom = doc.indexOf("wierd");
  const pasted = "first pasted line\nsecond pasted line\n";

  return [
    {
      name: "insert 1-5 prose characters",
      localized: true,
      changes: (iteration) => iteration % 2 === 0
        ? { from: targetFrom, insert: "tiny" }
        : { from: targetFrom, to: targetFrom + 4 },
    },
    {
      name: "replace inside math body",
      localized: true,
      changes: (iteration) => ({
        from: mathFrom,
        to: mathFrom + 4,
        insert: iteration % 2 === 0 ? "BODY" : "MATH",
      }),
    },
    {
      name: "paired emphasis markup",
      localized: true,
      changes: (iteration) => iteration % 2 === 0
        ? [
          { from: pairFrom, insert: "**" },
          { from: pairTo, insert: "**" },
        ]
        : [
          { from: pairFrom, to: pairFrom + 2 },
          { from: pairTo + 2, to: pairTo + 4 },
        ],
    },
    {
      name: "replace theorem sentence text",
      localized: true,
      changes: (iteration) => ({
        from: theoremFrom,
        to: theoremFrom + 5,
        insert: iteration % 2 === 0 ? "lemma" : "axiom",
      }),
    },
    {
      name: "paste/delete short multiline fragment",
      localized: false,
      changes: (iteration) => iteration % 2 === 0
        ? { from: pasteFrom, insert: pasted }
        : { from: pasteFrom, to: pasteFrom + pasted.length },
    },
    {
      name: "multi-change autocorrect",
      localized: true,
      changes: (iteration) => [
        {
          from: firstTypoFrom,
          to: firstTypoFrom + 3,
          insert: iteration % 2 === 0 ? "the" : "teh",
        },
        {
          from: secondTypoFrom,
          to: secondTypoFrom + 5,
          insert: iteration % 2 === 0 ? "weird" : "wierd",
        },
      ],
    },
  ];
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

function benchmarkOperation(
  doc: string,
  sizeKiB: number,
  operation: BenchmarkOperation,
): BenchmarkResult {
  let state = EditorState.create({ doc, extensions: pandocCstField });
  for (let index = 0; index < warmupSamples; index++) {
    state = state.update({ changes: operation.changes(index) }).state;
  }

  const durations: number[] = [];
  for (let index = 0; index < measuredSamples; index++) {
    const start = performance.now();
    state = state.update({ changes: operation.changes(index) }).state;
    durations.push(performance.now() - start);
  }

  expect(getPandocTree(state).text).toBe(state.doc.toString());
  expect(getPandocCstUpdateCountForTesting(state)).toBe(
    warmupSamples + measuredSamples,
  );
  durations.sort((left, right) => left - right);
  return {
    sizeKiB,
    operation: operation.name,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: durations.at(-1) ?? 0,
  };
}

describe.skipIf(!benchmarkEnabled)("Pandoc CST CodeMirror transaction benchmark", () => {
  it("reports warmed full-state update latency for generated documents", {
    timeout: 60 * 60_000,
  }, async () => {
    const results: BenchmarkResult[] = [];
    for (const sizeKiB of [21, 100, 700]) {
      if (sizeFilter && sizeKiB !== sizeFilter) continue;
      const doc = generatedDocument(sizeKiB * 1_024);
      for (const operation of operationsFor(doc)) {
        if (
          operationFilter
          && !operation.name.toLocaleLowerCase().includes(operationFilter)
        ) {
          continue;
        }
        const result = benchmarkOperation(doc, sizeKiB, operation);
        results.push(result);
        if (sizeKiB === 700 && operation.localized) {
          expect(result.p95Ms).toBeLessThanOrEqual(8);
        }
        process.stdout.write(`\n${JSON.stringify(result)}\n`);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    process.stdout.write(`\n${JSON.stringify(results, null, 2)}\n`);
  });

  it("keeps viewport decoration work within one frame on 700 KiB", {
    timeout: 10 * 60_000,
  }, () => {
    const doc = generatedDocument(700 * 1_024);
    const targetFrom = doc.indexOf("This deterministic paragraph");
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [pandocCstField, containerAttributesPlugin],
      }),
    });

    const dispatchEdit = (iteration: number) => {
      view.dispatch({
        changes: {
          from: targetFrom,
          to: targetFrom + 1,
          insert: iteration % 2 === 0 ? "t" : "T",
        },
      });
    };

    try {
      disableFrontendPerf();
      for (let index = 0; index < 20; index++) dispatchEdit(index);
      clearFrontendPerf();
      for (let index = 0; index < 50; index++) dispatchEdit(index);

      const durations = getFrontendPerfSnapshot().recent
        .filter((record) => record.name === "cm6.containerAttributes.rebuild")
        .map((record) => record.durationMs)
        .sort((left, right) => left - right);
      const p95Ms = percentile(durations, 0.95);
      const result = {
        fixtureKiB: 700,
        operation: "viewport container decorations after localized edit",
        samples: durations.length,
        p95Ms,
        maxMs: durations.at(-1) ?? 0,
      };
      process.stdout.write(`\n${JSON.stringify(result)}\n`);

      expect(durations).toHaveLength(50);
      expect(p95Ms).toBeLessThanOrEqual(16.7);
    } finally {
      disableFrontendPerf();
      view.destroy();
      parent.remove();
    }
  });
});
