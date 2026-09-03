import { describe, expect, it } from "vitest";
import { mountEditor } from "./editor";

describe("@chaoxu/coflat", () => {
  it("mounts only the editable editor surface", () => {
    const parent = document.createElement("div");
    const editor = mountEditor({ parent, doc: "# Intro\n\nbody" });

    expect(parent.querySelector(".cm-editor")).not.toBeNull();
    expect(parent.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
    expect(editor.getDoc()).toBe("# Intro\n\nbody");
    expect(editor.getCst()?.text).toBe(editor.getDoc());
    expect("outline" in editor).toBe(false);
    expect("cursorContext" in editor).toBe(false);

    editor.unmount();
    expect(parent.querySelector(".cm-editor")).toBeNull();
  });

  it("keeps the source cursor stable for a localized setDoc update", () => {
    const parent = document.createElement("div");
    const editor = mountEditor({ parent, doc: "# Intro\n\nfirst\n\nsecond\n" });
    const cursor = "# Intro\n\nfirst\n\nsec".length;
    editor.scrollToPosition(cursor);

    editor.setDoc("# Intro\n\nfirst\n\nsecond\n\nthird\n");

    expect(editor.getCursorContext()?.position).toBe(cursor);
    expect(editor.getCst()?.text).toBe(editor.getDoc());
    editor.unmount();
  });

  it("supports host save without adding an editor mode", async () => {
    const parent = document.createElement("div");
    const saves: string[] = [];
    const editor = mountEditor({
      parent,
      doc: "draft",
      saveHandler: {
        async save({ source, reason }) {
          saves.push(`${reason}:${source}`);
          return { ok: true };
        },
      },
    });

    editor.insertText(" updated");
    expect(editor.isSaved()).toBe(false);
    await editor.triggerSave();

    expect(saves).toEqual(["manual: updateddraft"]);
    expect(editor.isSaved()).toBe(true);
    editor.unmount();
  });
});
