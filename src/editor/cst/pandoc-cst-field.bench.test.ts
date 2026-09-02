import { type ChangeSpec, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
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
      changes: (iteration) => iteration % 2 === 0
        ? { from: targetFrom, insert: "tiny" }
        : { from: targetFrom, to: targetFrom + 4 },
    },
    {
      name: "replace inside math body",
      changes: (iteration) => ({
        from: mathFrom,
        to: mathFrom + 4,
        insert: iteration % 2 === 0 ? "BODY" : "MATH",
      }),
    },
    {
      name: "paired emphasis markup",
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
      changes: (iteration) => ({
        from: theoremFrom,
        to: theoremFrom + 5,
        insert: iteration % 2 === 0 ? "lemma" : "axiom",
      }),
    },
    {
      name: "paste/delete short multiline fragment",
      changes: (iteration) => iteration % 2 === 0
        ? { from: pasteFrom, insert: pasted }
        : { from: pasteFrom, to: pasteFrom + pasted.length },
    },
    {
      name: "multi-change autocorrect",
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
        process.stdout.write(`\n${JSON.stringify(result)}\n`);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    process.stdout.write(`\n${JSON.stringify(results, null, 2)}\n`);
  });
});
