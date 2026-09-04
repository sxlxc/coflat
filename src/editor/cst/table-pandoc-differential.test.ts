import { spawnSync } from "node:child_process";
import {
  canonicalizePandocJson,
  PandocParser,
  PANDOCMD_READER_FORMAT,
  projectPandocJson,
} from "pandocmd-cst";
import { describe, expect, it } from "vitest";

const hasPandoc = spawnSync("pandoc", ["--version"], { encoding: "utf8" }).status === 0;

function pandocJson(source: string): unknown {
  const result = spawnSync(
    "pandoc",
    [`--from=${PANDOCMD_READER_FORMAT}`, "--to=json"],
    { encoding: "utf8", input: source },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `pandoc exited ${result.status}`);
  }
  return JSON.parse(result.stdout) as unknown;
}

describe("pipe-table Pandoc differential", () => {
  it.skipIf(!hasPandoc)("matches cells containing escaped, code, math, and empty pipes", () => {
    const source = [
      "| Name | Code | Dollar | Single | Double | Display | Literal |",
      "| --- | :---: | ---: | --- | --- | --- | --- |",
      "| Row | `a|b` | $O(|E|)$ | \\(a|b\\) | \\\\(c|d\\\\) | $$e|f$$ | a\\|b |",
      "| Next || 2 |||| tail |",
      "",
    ].join("\n");
    const projected = projectPandocJson(new PandocParser().parse(source));

    expect(canonicalizePandocJson(projected)).toEqual(
      canonicalizePandocJson(pandocJson(source)),
    );
  });
});
