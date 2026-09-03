#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  EDITOR_EXTERNAL_DEPENDENCIES,
  packageNameFromSpecifier,
} from "./editor-package-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(root, "dist");
const ENTRYPOINTS = Object.freeze([
  "editor.mjs",
  "numeric.mjs",
  "latex.mjs",
]);
const STATIC_IMPORT_RE =
  /(?:^|[\n;])\s*(?:import\s+(?:[^"'();]*?\s+from\s*)?|export\s+(?:[^"']*?\s+from\s*))["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /import\(\s*["']([^"']+)["']\s*\)/g;

const EDITOR_FORBIDDEN_STATIC_PACKAGES = Object.freeze([
  /^@citation-js\//,
  /^@codemirror\/autocomplete$/,
  /^@codemirror\/lang-/,
  /^@radix-ui\//,
  /^@lezer\/markdown$/,
  /^cmdk$/,
  /^pdfjs-dist$/,
  /^react$/,
  /^react-dom$/,
]);
const EDITOR_FORBIDDEN_STATIC_FILES = Object.freeze([
  /(?:^|\/)reader-/,
  /(?:^|\/)rich-readonly-/,
  /(?:^|\/)pandoc-syntax-tree-/,
  /^shared\/block-type-picker-/,
  /^shared\/context-menu-/,
  /^shared\/editor-mode-state-/,
]);

function readDistFile(relativePath) {
  return readFileSync(resolve(distRoot, relativePath), "utf8");
}

function normalizeDistPath(filePath) {
  return relative(distRoot, filePath).split(sep).join("/");
}

function fileSize(relativePath) {
  const absolutePath = resolve(distRoot, relativePath);
  const source = readFileSync(absolutePath);
  return {
    gzipBytes: gzipSync(source).byteLength,
    rawBytes: statSync(absolutePath).size,
  };
}

function collectMatches(source, pattern) {
  const matches = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

function resolveStaticImport(fromRelativePath, specifier) {
  if (!specifier.startsWith(".")) return null;
  const resolved = resolve(distRoot, dirname(fromRelativePath), specifier);
  if (!resolved.startsWith(distRoot)) {
    throw new Error(`dist import escaped dist/: ${fromRelativePath} -> ${specifier}`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`dist import target is missing: ${fromRelativePath} -> ${specifier}`);
  }
  return normalizeDistPath(resolved);
}

export function measurePackageGraph(entrypoints = ENTRYPOINTS) {
  const entries = {};
  for (const entry of entrypoints) {
    const seen = new Set();
    const pending = [entry];
    const staticExternalPackages = new Set();
    const staticExternalSpecifiers = new Set();
    const dynamicSpecifiers = new Set();

    while (pending.length > 0) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);

      const source = readDistFile(file);
      for (const specifier of collectMatches(source, STATIC_IMPORT_RE)) {
        const distPath = resolveStaticImport(file, specifier);
        if (distPath) {
          pending.push(distPath);
          continue;
        }
        staticExternalSpecifiers.add(specifier);
        const packageName = packageNameFromSpecifier(specifier);
        if (packageName) staticExternalPackages.add(packageName);
      }
      for (const specifier of collectMatches(source, DYNAMIC_IMPORT_RE)) {
        dynamicSpecifiers.add(specifier);
      }
    }

    let rawBytes = 0;
    let gzipBytes = 0;
    for (const file of seen) {
      const size = fileSize(file);
      rawBytes += size.rawBytes;
      gzipBytes += size.gzipBytes;
    }

    entries[entry] = {
      dynamicSpecifiers: [...dynamicSpecifiers].sort(),
      files: [...seen].sort(),
      gzipBytes,
      rawBytes,
      staticExternalPackages: [...staticExternalPackages].sort(),
      staticExternalSpecifiers: [...staticExternalSpecifiers].sort(),
    };
  }
  return { entries };
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function assertEntryBoundary(graph, entry, rules) {
  const measured = graph.entries[entry];
  if (!measured) throw new Error(`missing package graph entry ${entry}`);

  const forbiddenPackages = measured.staticExternalPackages.filter((specifier) =>
    matchesAny(specifier, rules.staticPackages),
  );
  if (forbiddenPackages.length > 0) {
    throw new Error(
      `${entry} statically imports forbidden package(s): ${forbiddenPackages.join(", ")}`,
    );
  }

  const forbiddenFiles = measured.files.filter((file) =>
    file !== entry && matchesAny(file, rules.staticFiles),
  );
  if (forbiddenFiles.length > 0) {
    throw new Error(
      `${entry} statically imports forbidden dist module(s): ${forbiddenFiles.join(", ")}`,
    );
  }
}

export function assertPackageGraphBoundaries(graph) {
  assertEntryBoundary(graph, "editor.mjs", {
    staticFiles: EDITOR_FORBIDDEN_STATIC_FILES,
    staticPackages: EDITOR_FORBIDDEN_STATIC_PACKAGES,
  });

  const editor = graph.entries["editor.mjs"];
  if (!editor) throw new Error("missing package graph entry editor.mjs");
  const allowed = new Set(EDITOR_EXTERNAL_DEPENDENCIES);
  const unexpected = editor.staticExternalPackages.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`editor.mjs imports undeclared package(s): ${unexpected.join(", ")}`);
  }
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

export function formatPackageGraphReport(graph) {
  const lines = ["coflat package static module graph:"];
  for (const entry of ENTRYPOINTS) {
    const measured = graph.entries[entry];
    if (!measured) continue;
    lines.push(
      `- ${entry}: ${measured.files.length} files, ${formatBytes(measured.rawBytes)} raw / ${formatBytes(measured.gzipBytes)} gzip`,
    );
    lines.push(
      `  static external packages: ${measured.staticExternalPackages.join(", ") || "(none)"}`,
    );
    lines.push(
      `  dynamic imports: ${measured.dynamicSpecifiers.join(", ") || "(none)"}`,
    );
  }
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const graph = measurePackageGraph();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(graph, null, 2));
  } else {
    console.log(formatPackageGraphReport(graph));
  }
  if (process.argv.includes("--assert")) {
    assertPackageGraphBoundaries(graph);
  }
}
