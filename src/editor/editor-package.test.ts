import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BibliographyStatus,
  EditorDocumentChange,
  MountEditorOptions,
  MountedEditor,
  PandocCursorContext,
  SaveHandler,
  StatusEvents,
} from "../../editor";
import * as editorEntry from "../../editor";

interface PackageExport {
  readonly import?: string;
  readonly types?: string;
}

interface PackageManifest {
  readonly exports?: Record<string, PackageExport | string>;
  readonly files?: readonly string[];
}

function packageManifest(): PackageManifest {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
  ) as PackageManifest;
}

describe("package editor export", () => {
  it("exposes one CST-backed editable surface", () => {
    expect(editorEntry).toHaveProperty("mountEditor");
    expect(editorEntry).toHaveProperty("createEditor");
    expect(editorEntry).not.toHaveProperty("setEditorMode");
    expect(editorEntry).not.toHaveProperty("formatUploadedAssetMarkdown");

    type PublicOptions = MountEditorOptions;
    type PublicMounted = MountedEditor;
    type PublicChange = EditorDocumentChange;
    type PublicCursor = PandocCursorContext;
    type PublicSave = SaveHandler;
    type PublicEvents = StatusEvents;
    const _typecheck: [
      PublicOptions["parent"],
      PublicMounted["getCst"],
      PublicChange["tree"],
      PublicCursor["block"],
      PublicSave | undefined,
      PublicEvents | undefined,
      BibliographyStatus | undefined,
      PublicOptions["readTextResource"],
    ] | null = null;
    expect(_typecheck).toBeNull();
  });

  it("does not publish Reader, readonly, projection, or test-only entries", () => {
    const keys = Object.keys(packageManifest().exports ?? {});
    expect(keys).toContain(".");
    expect(keys).toContain("./style.css");
    expect(keys).not.toContain("./reader");
    expect(keys).not.toContain("./reader/worker");
    expect(keys).not.toContain("./rich-readonly");
    expect(keys).not.toContain("./inline-render");
    expect(keys).not.toContain("./parse");
    expect(keys).not.toContain("./test-utils");
    expect(keys).not.toContain("./browser-test-utils");
  });

  it("publishes the editor from generated dist output", () => {
    expect(packageManifest().exports?.["."]).toEqual({
      types: "./dist/editor.d.ts",
      import: "./dist/editor.mjs",
    });
    expect(packageManifest().files).toContain("dist");
  });
});
