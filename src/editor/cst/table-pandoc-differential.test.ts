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

  it.skipIf(!hasPandoc)("matches raw-inline and dollar-delimiter cell boundaries", () => {
    const sources = [
      "| \\foo{a|b} | z |\n---|---\nx|y\n",
      "| a <br title=\"x|y\"> b | z |\n---|---\nx|y\n",
      "| <span title=\"x|y\">a</span> | z |\n---|---\nx|y\n",
      "$a|b$1\n---|---\nx|y\n",
    ];
    for (const source of sources) {
      const projected = projectPandocJson(new PandocParser().parse(source));
      expect(canonicalizePandocJson(projected)).toEqual(
        canonicalizePandocJson(pandocJson(source)),
      );
    }
  });

  it.skipIf(!hasPandoc)("omits empty headers and retains empty body rows", () => {
    const source = "||\n---|---\n||\na|b\n";
    const projected = projectPandocJson(new PandocParser().parse(source));

    expect(canonicalizePandocJson(projected)).toEqual(
      canonicalizePandocJson(pandocJson(source)),
    );
  });
});
