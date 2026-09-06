import { undo } from "@codemirror/commands";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CSS } from "../core/constants/css-classes";
import {
  type EditorDocumentChange,
  type MountedEditor,
  type SaveHandler,
  mountEditor,
} from "../../editor";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function mountWithCapturedView(options: {
  readonly doc: string;
  readonly onChange?: (doc: string) => void;
  readonly onDocumentChange?: (change: EditorDocumentChange) => void;
  readonly saveHandler?: SaveHandler;
}): { readonly editor: MountedEditor; readonly view: () => EditorView } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  let capturedView: EditorView | null = null;
  const editor = mountEditor({
    parent,
    doc: options.doc,
    onChange: options.onChange,
    onDocumentChange: options.onDocumentChange,
    saveHandler: options.saveHandler,
    extensions: [
      ViewPlugin.define((view) => {
        capturedView = view;
        return {};
      }),
    ],
  });
  cleanups.push(() => {
    editor.unmount();
    parent.remove();
  });
  return {
    editor,
    view() {
      if (!capturedView) throw new Error("view was not captured");
      return capturedView;
    },
  };
}

describe("mountEditor document change callbacks", () => {
  it("emits CodeMirror change metadata without requiring onChange", () => {
    const changes: EditorDocumentChange[] = [];
    const onChange = vi.fn();
    const { view } = mountWithCapturedView({
      doc: "alpha",
      onChange,
      onDocumentChange(change) {
        changes.push(change);
      },
    });

    view().dispatch({ changes: { from: 5, insert: " beta" } });

    expect(changes).toHaveLength(1);
    expect(changes[0].changes.empty).toBe(false);
    expect(onChange).toHaveBeenCalledWith("alpha beta");
  });

  it("supports incremental document changes without an onChange handler", () => {
    const changes: EditorDocumentChange[] = [];
    const { editor, view } = mountWithCapturedView({
      doc: "alpha",
      onDocumentChange(change) {
        changes.push(change);
      },
    });

    view().dispatch({ changes: { from: 5, insert: " beta" } });

    expect(changes).toHaveLength(1);
    expect(changes[0].changes.empty).toBe(false);
    expect(editor.getDoc()).toBe("alpha beta");
  });

  it("does not emit document callbacks for programmatic setDoc", () => {
    const onChange = vi.fn();
    const onDocumentChange = vi.fn();
    const { editor } = mountWithCapturedView({
      doc: "alpha",
      onChange,
      onDocumentChange,
    });

    editor.setDoc("programmatic");

    expect(onChange).not.toHaveBeenCalled();
    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  it("keeps delayed document snapshots tied to each change", () => {
    const changes: EditorDocumentChange[] = [];
    const { editor, view } = mountWithCapturedView({
      doc: "a",
      onDocumentChange(change) {
        changes.push(change);
      },
    });

    view().dispatch({ changes: { from: 1, insert: "b" } });
    view().dispatch({ changes: { from: 2, insert: "c" } });

    expect(changes).toHaveLength(2);
    expect(changes[0].changes.empty).toBe(false);
    expect(changes[1].changes.empty).toBe(false);
    expect(editor.getDoc()).toBe("abc");
  });

  it("reuses the synchronized CST source for host updates and reads", () => {
    const onChange = vi.fn();
    const { editor, view } = mountWithCapturedView({ doc: "数学 😀\r\nBody", onChange });
    const transaction = view().state.update({ changes: { from: 2, insert: " notes" } });
    const nextState = transaction.state;
    const serialize = vi.spyOn(nextState.doc, "toString");
    try {
      view().update([transaction]);
      expect(editor.getDoc()).toBe("数学 notes 😀\nBody");
      expect(editor.getCst()?.text).toBe(editor.getDoc());
      expect(onChange).toHaveBeenCalledWith(editor.getDoc());
      editor.setDoc(editor.getDoc());
      expect(serialize).not.toHaveBeenCalled();
    } finally {
      serialize.mockRestore();
    }
  });

  it("saves a stable source snapshot while further typing remains dirty", async () => {
    let finishSave: () => void = () => { throw new Error("Save has not started"); };
    const save = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
      finishSave = () => resolve({ ok: true });
    }));
    const { editor, view } = mountWithCapturedView({ doc: "数学 😀", saveHandler: { save } });
    const pending = editor.triggerSave();
    view().dispatch({ changes: { from: 2, insert: " notes" }, userEvent: "input" });
    finishSave();
    await pending;
    expect(save).toHaveBeenCalledWith({ source: "数学 😀", reason: "manual" });
    expect(editor.isSaved()).toBe(false);
    expect(undo(view())).toBe(true);
    expect(editor.getDoc()).toBe("数学 😀");
    expect(editor.isSaved()).toBe(true);
  });

  it("replaces the live document when setDoc receives a different value", () => {
    const { editor, view } = mountWithCapturedView({
      doc: "alpha",
    });
    view().dispatch({ changes: { from: 5, insert: " beta" } });

    editor.setDoc("short");

    expect(editor.getDoc()).toBe("short");
  });

  it.each([
    ["abcdef", "aXYZf", 2, 4],
    ["abcdef", "aXYZf", 4, 2],
    ["中文 😀 abcdef", "中文 😀 aXYZf", 8, 10],
  ] as const)("replaces %s while mapping an enclosed selection", (doc, replacement, anchor, head) => {
    const { editor, view } = mountWithCapturedView({ doc });
    view().dispatch({ selection: { anchor, head } });

    editor.setDoc(replacement);

    expect(editor.getDoc()).toBe(replacement);
    expect(editor.getCst()?.text).toBe(replacement);
    expect(view().state.selection.main.from).toBe(replacement.indexOf("XYZ"));
    expect(view().state.selection.main.to).toBe(replacement.indexOf("XYZ") + 3);
    editor.insertText("done");
    expect(editor.getDoc()).toBe(replacement.replace("XYZ", "done"));
    expect(editor.getCst()?.text).toBe(editor.getDoc());
  });

  it("keeps newly loaded YAML metadata collapsed at a visible caret boundary", () => {
    const { editor, view } = mountWithCapturedView({ doc: "alpha" });
    const doc = "---\ntitle: Loaded Title\n---\nBody";

    editor.setDoc(doc);

    const metadata = editor.getCst()?.topLevelBlocks()[0];
    expect(metadata?.kind).toBe("YamlMetadata");
    expect(view().state.selection.main.head).toBe(metadata?.to);
    expect(view().dom.querySelectorAll(`.cm-line.${CSS.yamlHidden}`)).toHaveLength(3);
    expect(view().dom.querySelector(".cf-doc-title")?.textContent)
      .toBe("Loaded Title");
  });

  it("inserts text at the current selection as a normal editor change", () => {
    const onChange = vi.fn();
    const changes: EditorDocumentChange[] = [];
    const { editor, view } = mountWithCapturedView({
      doc: "alpha omega",
      onChange,
      onDocumentChange(change) {
        changes.push(change);
      },
    });
    view().dispatch({ selection: { anchor: 5 } });

    editor.insertText(" beta");

    expect(editor.getDoc()).toBe("alpha beta omega");
    expect(onChange).toHaveBeenCalledWith("alpha beta omega");
    expect(changes).toHaveLength(1);
    expect(changes[0].changes.empty).toBe(false);
  });

  it("replaces the current selection when inserting text", () => {
    const { editor, view } = mountWithCapturedView({
      doc: "alpha TODO omega",
    });
    const from = "alpha ".length;
    const to = from + "TODO".length;
    view().dispatch({ selection: { anchor: from, head: to } });

    editor.insertText("done");

    expect(editor.getDoc()).toBe("alpha done omega");
  });

  it("inserts text at an explicit source position without replacing the current selection", () => {
    const { editor, view } = mountWithCapturedView({
      doc: "alpha TODO omega",
    });
    const from = "alpha ".length;
    const to = from + "TODO".length;
    view().dispatch({ selection: { anchor: from, head: to } });

    editor.insertText(" beta", { position: "alpha TODO".length });

    expect(editor.getDoc()).toBe("alpha TODO beta omega");
  });

});
