import { EditorState } from "@codemirror/state";
import { getPandocTree, pandocCstField } from "../src/editor/cst/pandoc-cst-field.ts";

const EDIT_COUNT = 10_000;
const DOCUMENT_BYTES = 700 * 1_024;
const MAX_RETAINED_TREES = 2;
const MAX_HEAP_GROWTH = 64 * 1_024 * 1_024;

function generatedDocument(targetLength: number): string {
  const unit = [
    "# Generated section",
    "",
    "Ordinary prose with $MATH$ and [@citation].",
    "",
    "::: {.note}",
    "Stable BODY text.",
    ":::",
    "",
  ].join("\n");
  let text = "";
  while (text.length + unit.length <= targetLength) text += unit;
  return text + "x".repeat(targetLength - text.length);
}

async function collectGarbage(): Promise<void> {
  Bun.gc(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  Bun.gc(true);
}

const doc = generatedDocument(DOCUMENT_BYTES);
let state = EditorState.create({ doc, extensions: pandocCstField });
const math = doc.indexOf("MATH");
const body = doc.indexOf("BODY");
const citation = doc.indexOf("citation");
const historicalTrees: Array<WeakRef<object>> = [];
const heapSamples: number[] = [];

await collectGarbage();
for (let iteration = 0; iteration < EDIT_COUNT; iteration += 1) {
  if (iteration % 100 === 0) {
    historicalTrees.push(new WeakRef(getPandocTree(state) as object));
  }
  const even = iteration % 2 === 0;
  const changes = iteration % 3 === 0
    ? { from: math, to: math + 4, insert: even ? "BODY" : "MATH" }
    : iteration % 3 === 1
      ? { from: body, to: body + 4, insert: even ? "TEXT" : "BODY" }
      : [
        { from: math, to: math + 4, insert: even ? "BODY" : "MATH" },
        { from: citation, to: citation + 8, insert: even ? "citati0n" : "citation" },
      ];
  state = state.update({ changes }).state;
  if ((iteration + 1) % 1_000 === 0) {
    await collectGarbage();
    heapSamples.push(process.memoryUsage().heapUsed);
  }
}

await collectGarbage();
const retainedHistoricalTrees = historicalTrees.filter((ref) => ref.deref()).length;
const baseline = heapSamples[0] ?? 0;
const maxGrowth = Math.max(...heapSamples) - baseline;
const result = {
  documentBytes: doc.length,
  edits: EDIT_COUNT,
  retainedHistoricalTrees,
  heapSamples,
  maxGrowth,
  maxAllowedGrowth: MAX_HEAP_GROWTH,
};

process.stdout.write(`COFLAT_CST_LONG_SESSION ${JSON.stringify(result)}\n`);

if (getPandocTree(state).text !== state.doc.toString()) {
  throw new Error("CST text diverged from EditorState.doc");
}
if (retainedHistoricalTrees > MAX_RETAINED_TREES) {
  throw new Error(
    `${retainedHistoricalTrees} historical CST trees remained after full collection`,
  );
}
if (maxGrowth > MAX_HEAP_GROWTH) {
  throw new Error(`heap grew by ${maxGrowth} bytes; limit is ${MAX_HEAP_GROWTH}`);
}
