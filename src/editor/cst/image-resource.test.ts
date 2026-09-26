import { cursorCharRight } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountEditor, type MountedEditor } from "../../../editor";

describe("host image resources", () => {
  let editor: MountedEditor | undefined;
  let parent: HTMLElement;
  const createObjectURL = vi.fn(() => "blob:local-image");
  const revokeObjectURL = vi.fn();
  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
  });
  afterEach(() => {
    editor?.unmount();
    editor = undefined;
    parent.remove();
    vi.unstubAllGlobals();
  });

  it("loads decoded destinations without requesting or saving their source URLs", async () => {
    const doc = "Before.\n\n![Alt](assets/a&amp;b.png){width=100%}\n\nAfter.";
    const blob = new Blob(["image bytes"], { type: "image/png" });
    const reader = vi.fn(async () => blob);
    const save = vi.fn(async () => ({ ok: true as const }));
    editor = mountEditor({ parent, doc, readImageResource: reader, saveHandler: { save } });
    expect(parent.querySelector("img")?.getAttribute("src")).toBeNull();
    expect(reader).toHaveBeenCalledWith("assets/a&b.png");
    await vi.waitFor(() => expect(parent.querySelector("img")?.getAttribute("src")).toBe("blob:local-image"));
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(parent.querySelector("img")?.style.width).toBe("100%");
    expect(editor.getDoc()).toBe(doc);
    expect(editor.getCst()?.text).toBe(doc);
    await editor.triggerSave();
    expect(save).toHaveBeenCalledWith({ source: doc, reason: "manual" });
    editor.unmount();
    editor = undefined;
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-image");
  });

  it("leaves failures editable without falling back to a network URL", async () => {
    const doc = "Before.\n\n![Missing](missing.png)";
    editor = mountEditor({ parent, doc, readImageResource: async () => { throw new Error("Missing local file"); } });
    await vi.waitFor(() => expect(parent.querySelector("img")?.title).toContain("Missing local file"));
    expect(parent.querySelector("img")?.hasAttribute("src")).toBe(false);
    parent.querySelector("img")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(parent.querySelector(".cf-image-source")?.textContent).toBe("![Missing](missing.png)");
    expect(editor.getDoc()).toBe(doc);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ["figures.svg#detail", "figures.svg#detail", "#detail"],
    ["figures.svg?version=2#detail%20view", "figures.svg?version=2#detail%20view", "#detail%20view"],
    ["figures.svg&#35;detail", "figures.svg#detail", "#detail"],
    ["figures%23detail.svg", "figures%23detail.svg", ""],
  ])("preserves the destination fragment in blob URLs: %s", async (destination, decoded, fragment) => {
    const doc = `Before.\n\n![Detail](${destination})`;
    const reader = vi.fn(async () => new Blob(["<svg/>"], { type: "image/svg+xml" }));
    editor = mountEditor({ parent, doc, readImageResource: reader });
    expect(reader).toHaveBeenCalledExactlyOnceWith(decoded);
    await vi.waitFor(() => expect(parent.querySelector("img")?.getAttribute("src")).toBe(`blob:local-image${fragment}`));
    expect(editor.getDoc()).toBe(doc);
    expect(editor.getCst()?.text).toBe(doc);
    editor.unmount();
    editor = undefined;
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-image");
  });

  it.each([false, true])("reuses loaded image resources across position edits with source revealed: %s", async (revealed) => {
    const source = "![One](one.png)";
    const doc = `Before.\n\n${source}\n\nAfter.`;
    const reader = vi.fn(async () => new Blob());
    editor = mountEditor({ parent, doc, readImageResource: reader });
    const view = EditorView.findFromDOM(parent.querySelector(".cm-editor") ?? parent);
    if (!view) throw new Error("Missing editor view");
    if (revealed) editor.scrollToPosition(doc.indexOf("!["));
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const image = parent.querySelector("img");
    for (const prefix of ["中", "中文 😀\n\n", ""]) {
      const updatedDoc = prefix + doc;
      editor.setDoc(updatedDoc);
      expect(parent.querySelector("img")).toBe(image);
      expect(image?.getAttribute("src")).toBe("blob:local-image");
      expect(reader).toHaveBeenCalledTimes(1);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).not.toHaveBeenCalled();
      expect(editor.getDoc()).toBe(updatedDoc);
      expect(editor.getCst()?.text).toBe(updatedDoc);
      const from = updatedDoc.indexOf("![");
      image?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      expect(view.state.selection.main.head).toBe(from);
      expect(parent.querySelector(".cf-image-source")?.textContent).toBe(source);
      editor.scrollToPosition(from - 1);
      cursorCharRight(view);
      expect(view.state.selection.main.head).toBe(from);
      expect(parent.querySelector(".cf-image-source")?.textContent).toBe(source);
      if (!revealed) editor.scrollToPosition(0);
    }
    editor.setDoc("Before.\n\nAfter.");
    expect(parent.querySelector("img")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-image");
    editor.unmount();
    editor = undefined;
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending resource load alive across position-only edits", async () => {
    const releases: Array<(blob: Blob) => void> = [];
    const reader = vi.fn(() => new Promise<Blob>((resolve) => releases.push(resolve)));
    const doc = "Before.\n\n![One](one.png)\n\nAfter.";
    editor = mountEditor({ parent, doc, readImageResource: reader });
    const image = parent.querySelector("img");
    editor.insertText("中文 😀");
    editor.insertText(" more");
    expect(reader).toHaveBeenCalledTimes(1);
    expect(parent.querySelector("img")).toBe(image);
    releases[0](new Blob());
    await vi.waitFor(() => expect(image?.getAttribute("src")).toBe("blob:local-image"));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(editor.getDoc()).toBe(`中文 😀 more${doc}`);
    expect(editor.getCst()?.text).toBe(editor.getDoc());
    editor.unmount();
    editor = undefined;
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-image");
  });

  it("ignores pending results when an image changes and after unmounting", async () => {
    const releases: Array<(blob: Blob) => void> = [];
    const reader = vi.fn(() => new Promise<Blob>((resolve) => releases.push(resolve)));
    editor = mountEditor({ parent, doc: "Before.\n\n![One](one.png)", readImageResource: reader });
    const oldImage = parent.querySelector("img");
    editor.setDoc("Before.\n\n![Two](two.png)");
    expect(reader).toHaveBeenCalledTimes(2);
    releases[0](new Blob(["old"]));
    await Promise.resolve();
    expect(oldImage?.getAttribute("src")).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
    editor.unmount();
    editor = undefined;
    releases[1](new Blob(["new"]));
    await Promise.resolve();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("cleans up image DOM reused after unrelated document edits", async () => {
    const doc = "Before.\n\n![One](one.png)\n\nAfter.";
    editor = mountEditor({ parent, doc, readImageResource: async () => new Blob() });
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const image = parent.querySelector("img");
    editor.setDoc(`${doc} More.`);
    image?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(parent.querySelector("img")).toBe(image);
    editor.unmount();
    editor = undefined;
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-image");
  });

  it("revokes the previous URL when the source changes", async () => {
    editor = mountEditor({ parent, doc: "Before.\n\n![One](one.png)", readImageResource: async () => new Blob() });
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    editor.setDoc("Before.\n\n![Two](two.png)");
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-image");
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
  });
});
