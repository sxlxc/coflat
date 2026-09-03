import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EDITOR_BUNDLED_DEPENDENCIES,
  EDITOR_EXTERNAL_DEPENDENCIES,
  EDITOR_FORBIDDEN_EXTERNAL_DEPENDENCIES,
  isEditorBuildDependency,
  isEditorBundledDependency,
  isEditorExternalDependency,
  packageNameFromSpecifier,
} from "./editor-package-manifest.mjs";

describe("editor package dependency manifest", () => {
  it("extracts package names from bare imports, subpaths, and Vite query imports", () => {
    expect(packageNameFromSpecifier("react")).toBe("react");
    expect(packageNameFromSpecifier("@codemirror/view")).toBe("@codemirror/view");
    expect(packageNameFromSpecifier("pdfjs-dist/build/pdf.worker.min.mjs?url")).toBe(
      "pdfjs-dist",
    );
    expect(packageNameFromSpecifier("./local-module.js")).toBeNull();
  });

  it("allowlists only standalone editor runtime dependencies", () => {
    expect(isEditorExternalDependency("@codemirror/view")).toBe(true);
    expect(isEditorExternalDependency("@codemirror/view/subpath")).toBe(true);
    expect(isEditorExternalDependency("react/jsx-runtime")).toBe(false);
    expect(isEditorExternalDependency("pandocmd-cst")).toBe(false);
    expect(isEditorExternalDependency("@tauri-apps/api/core")).toBe(false);
    expect(isEditorExternalDependency("@radix-ui/react-dialog")).toBe(false);
    expect(isEditorExternalDependency("@overleaf/codemirror-tree-view")).toBe(false);
  });

  it("allows explicit bundled build dependencies without exposing them as package externals", () => {
    expect(isEditorBundledDependency("@overleaf/codemirror-tree-view")).toBe(false);
    expect(isEditorBundledDependency("@lezer/common")).toBe(true);
    expect(isEditorBundledDependency("pandocmd-cst")).toBe(true);
    expect(isEditorBuildDependency("pandocmd-cst")).toBe(true);
    expect(isEditorBuildDependency("@overleaf/codemirror-tree-view")).toBe(false);
    expect(isEditorBuildDependency("markdown-it")).toBe(false);
  });

  it("keeps app-only dependencies out of the editor build manifest", () => {
    const allowed = new Set([
      ...EDITOR_EXTERNAL_DEPENDENCIES,
      ...EDITOR_BUNDLED_DEPENDENCIES,
    ]);
    const accidentalOverlap = EDITOR_FORBIDDEN_EXTERNAL_DEPENDENCIES.filter((dependency) =>
      allowed.has(dependency),
    );

    expect(accidentalOverlap).toEqual([]);
  });

  it("keeps the published peer set equal to the editor external set", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    );

    expect(Object.keys(packageJson.peerDependencies ?? {}).sort()).toEqual(
      [...EDITOR_EXTERNAL_DEPENDENCIES].sort(),
    );
  });
});
