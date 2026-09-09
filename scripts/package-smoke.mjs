#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPackageGraphBoundaries,
  formatPackageGraphReport,
  measurePackageGraph,
} from "./measure-package-graph.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function assertIncludes(value, needle, label) {
  if (!value.includes(needle)) {
    throw new Error(`${label} missing ${needle}`);
  }
}

function assertNotMatches(value, pattern, label) {
  if (pattern.test(value)) {
    throw new Error(`${label} matched forbidden pattern ${pattern}`);
  }
}

const css = read("dist/editor.css");
const surfaceCss = read("dist/document-surface.css");
const latexCsl = read("dist/latex/csl/ieee.csl");
const latexFilter = read("dist/latex/filter.lua");
const latexSyntaxManifest = read("dist/latex/syntax-manifest.lua");
const latexArticleTemplate = read("dist/latex/template/article.tex");
const jsExports = [
  "../dist/editor.mjs",
  "../dist/numeric.mjs",
  "../dist/latex.mjs",
];
for (const entry of jsExports) {
  await import(entry);
}
const packageExports = [
  "@chaoxu/coflat",
  "@chaoxu/coflat/numeric",
  "@chaoxu/coflat/latex",
];
for (const entry of packageExports) {
  await import(entry);
}

// Exercise the bundled renderer without asking a consuming app to patch KaTeX.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><div id='editor'></div>", { pretendToBeVisual: true });
const globals = ["window", "document", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame"];
const originals = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
let mounted;
try {
  for (const name of globals) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  const { mountEditor } = await import("@chaoxu/coflat");
  const parent = dom.window.document.getElementById("editor");
  mounted = mountEditor({ parent, doc: "Before.\n\n$x+1234$" });
  const digits = [...parent.querySelectorAll("[data-loc-start]")].find((element) => element.textContent === "1234");
  if (digits?.getAttribute("data-loc-start") !== "2" || digits.getAttribute("data-loc-end") !== "6") {
    throw new Error("Packaged math renderer lost its character source mappings");
  }
} finally {
  mounted?.unmount();
  dom.window.close();
  for (const [index, name] of globals.entries()) {
    if (originals[index]) Object.defineProperty(globalThis, name, originals[index]);
    else delete globalThis[name];
  }
}

for (const removed of [
  "reader.mjs",
  "reader-worker.mjs",
  "rich-readonly.mjs",
  "inline-render.mjs",
  "parse.mjs",
  "citeproc.mjs",
]) {
  if (existsSync(resolve(root, "dist", removed))) {
    throw new Error(`removed package surface was rebuilt: dist/${removed}`);
  }
}

assertIncludes(css, ".cm-editor", "dist/editor.css");
assertIncludes(css, ".cf-doc-surface", "dist/editor.css");
assertIncludes(surfaceCss, ".cf-doc-surface", "dist/document-surface.css");
assertIncludes(surfaceCss, ".cf-doc-display-math", "dist/document-surface.css");
assertIncludes(surfaceCss, ":root", "dist/document-surface.css");
assertIncludes(surfaceCss, ".katex-display", "dist/document-surface.css");
assertNotMatches(surfaceCss, /\.cm-/, "dist/document-surface.css");
assertNotMatches(css, /(^|})\s*\.font-mono\b/, "dist/editor.css");

const editorBundle = read("dist/editor.mjs");
assertNotMatches(
  editorBundle,
  /@codemirror\/lang-markdown|@lezer\/markdown|rich-readonly|reader mode|readonly mode/,
  "dist/editor.mjs",
);
const packageGraph = measurePackageGraph();
assertPackageGraphBoundaries(packageGraph);
console.log(formatPackageGraphReport(packageGraph));

assertIncludes(latexCsl, 'citation-format="numeric"', "dist/latex/csl/ieee.csl");
assertIncludes(latexFilter, "syntax-manifest.lua", "dist/latex/filter.lua");
assertIncludes(latexSyntaxManifest, "latex_kind_by_block", "dist/latex/syntax-manifest.lua");
assertIncludes(latexArticleTemplate, "\\documentclass[runningheads,envcountsame]{llncs}", "dist/latex/template/article.tex");

const latexSmoke = spawnSync(
  "pandoc",
  [
    "--from=markdown+fenced_divs",
    "--to=latex",
    "--lua-filter=dist/latex/filter.lua",
  ],
  {
    cwd: root,
    input: "::: {.theorem}\nA packaged filter smoke.\n:::\n",
    encoding: "utf8",
  },
);
if (latexSmoke.error && latexSmoke.error.code !== "ENOENT") {
  throw latexSmoke.error;
}
if (!latexSmoke.error) {
  if (latexSmoke.status !== 0) {
    throw new Error(`dist latex filter smoke failed:\n${latexSmoke.stderr}`);
  }
  assertIncludes(latexSmoke.stdout, "\\begin{theorem}", "dist latex filter smoke");
} else {
  console.log("skipped dist latex filter smoke: pandoc not found");
}

console.log("coflat package smoke passed");
