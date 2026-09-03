import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { mountEditor } from "./editor";
import { DOCUMENT_SURFACE_CLASS } from "./src/core/document-surface-classes";

function mountedView(parent: HTMLElement): EditorView {
  const editor = parent.querySelector<HTMLElement>(".cm-editor");
  const view = editor ? EditorView.findFromDOM(editor) : null;
  if (!view) throw new Error("CodeMirror view was not mounted");
  return view;
}

describe("mountEditor", () => {
  it("mounts one editable CST-backed document surface", () => {
    const parent = document.createElement("div");
    const editor = mountEditor({ parent, doc: "# Title\n\nText." });

    expect(editor.getDoc()).toBe("# Title\n\nText.");
    expect(editor.getCst()?.text).toBe(editor.getDoc());
    expect(parent.querySelector(".cm-editor")?.classList.contains(
      DOCUMENT_SURFACE_CLASS.surface,
    )).toBe(true);
    expect(parent.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
    expect("getMode" in editor).toBe(false);
    expect("setMode" in editor).toBe(false);

    editor.unmount();
  });

  it("publishes the CST snapshot with every user document change", () => {
    const parent = document.createElement("div");
    const onDocumentChange = vi.fn();
    const editor = mountEditor({ parent, doc: "text", onDocumentChange });
    const before = editor.getCst();

    mountedView(parent).dispatch({ changes: { from: 4, insert: "!" } });

    expect(editor.getDoc()).toBe("text!");
    expect(editor.getCst()?.text).toBe("text!");
    expect(editor.getCst()?.version).toBeGreaterThan(before?.version ?? -1);
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    expect(onDocumentChange.mock.calls[0][0].tree).toBe(editor.getCst());
    editor.unmount();
  });

  it("derives inline and block cursor context directly from the CST", () => {
    const parent = document.createElement("div");
    const doc = "Paragraph with *emphasis* and $x^2$.";
    const editor = mountEditor({ parent, doc });
    const view = mountedView(parent);

    view.dispatch({ selection: { anchor: doc.indexOf("emphasis") + 2 } });
    expect(editor.getCursorContext()?.inline?.kind).toBe("Emphasis");
    expect(editor.getCursorContext()?.block?.kind).toBe("Paragraph");
    expect(view.contentDOM.dataset.cstInline).toBe("Emphasis");
    expect(view.contentDOM.dataset.cstBlock).toBe("Paragraph");

    view.dispatch({ selection: { anchor: doc.indexOf("x^2") + 1 } });
    expect(editor.getCursorContext()?.inline?.kind).toBe("Math");
    expect(view.contentDOM.dataset.cstInline).toBe("Math");
    editor.unmount();
  });

  it("renders every selection range as an inline text highlight", () => {
    const parent = document.createElement("div");
    const editor = mountEditor({ parent, doc: "alpha beta gamma" });
    const view = mountedView(parent);

    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 5),
        EditorSelection.range(11, 16),
      ]),
    });

    expect(parent.querySelectorAll(".cf-selection-range")).toHaveLength(2);
    editor.unmount();
  });

  it("reveals emphasis markup at the cursor and keeps it keyboard-editable", () => {
    const parent = document.createElement("div");
    const doc = "before *editable* after";
    const editor = mountEditor({ parent, doc });
    const view = mountedView(parent);

    expect(parent.querySelectorAll(".cf-source-delimiter")).toHaveLength(0);
    view.dispatch({ selection: { anchor: doc.indexOf("editable") + 1 } });
    expect(parent.querySelectorAll(".cf-source-delimiter")).toHaveLength(2);

    editor.insertText("X");
    expect(editor.getDoc()).toBe("before *eXditable* after");
    expect(editor.getCst()?.text).toBe(editor.getDoc());
    editor.unmount();
  });

  it("switches inline math between rendered math and source plus a live preview", () => {
    const parent = document.createElement("div");
    const doc = "before $x^2$ after";
    const editor = mountEditor({ parent, doc });

    const rendered = parent.querySelector<HTMLElement>(".cf-math-inline");
    expect(rendered).not.toBeNull();
    expect(parent.querySelector(".cf-math-source")).toBeNull();

    rendered?.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    }));
    expect(editor.getCursorContext()?.inline?.kind).toBe("Math");
    expect(parent.querySelector(".cf-math-source")).not.toBeNull();
    expect(parent.querySelector(".cf-cst-math-preview")).not.toBeNull();

    mountedView(parent).dispatch({ selection: { anchor: doc.indexOf("x^2") + 1 } });
    editor.insertText("+");
    expect(editor.getDoc()).toBe("before $x+^2$ after");
    expect(editor.getCst()?.text).toBe(editor.getDoc());
    editor.unmount();
  });

  it("renders display math and opens its source with a live preview popup", () => {
    const parent = document.createElement("div");
    const doc = "before\n\n$$x+y$$\n\nafter";
    const editor = mountEditor({ parent, doc });
    const view = mountedView(parent);

    const rendered = parent.querySelector<HTMLElement>(
      ".cf-math-display:not(.cf-cst-math-preview)",
    );
    expect(rendered?.querySelector(".katex-display")).not.toBeNull();
    expect(parent.querySelector(".cf-math-source")).toBeNull();

    rendered?.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      cancelable: true,
    }));

    expect(editor.getCursorContext()?.inline?.kind).toBe("Math");
    expect(parent.querySelector(".cf-math-source")).not.toBeNull();
    expect(parent.querySelector(".cf-cst-math-preview.cf-math-display"))
      .not.toBeNull();

    view.dispatch({ selection: { anchor: doc.indexOf("x+y") + 1 } });
    editor.insertText("z");
    expect(editor.getDoc()).toBe("before\n\n$$xz+y$$\n\nafter");
    expect(editor.getCst()?.text).toBe(editor.getDoc());
    editor.unmount();
  });

  it("keeps a mapped display-math click target tied to the live CST range", () => {
    const parent = document.createElement("div");
    const editor = mountEditor({ parent, doc: "$$x+y$$" });

    editor.insertText("preface\n\n", { position: 0 });
    const rendered = parent.querySelector<HTMLElement>(".cf-math-display");
    rendered?.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      cancelable: true,
    }));

    const liveMathFrom = editor.getDoc().indexOf("$$");
    expect(editor.getCursorContext()?.inline?.kind).toBe("Math");
    expect(editor.getCursorContext()?.position).toBeGreaterThan(liveMathFrom);
    expect(parent.querySelector(".cf-cst-math-preview.cf-math-display"))
      .not.toBeNull();
    editor.unmount();
  });

  it("enters a rendered math node with the keyboard alone", () => {
    const parent = document.createElement("div");
    const doc = "a $x$ b";
    const editor = mountEditor({ parent, doc });
    const view = mountedView(parent);
    const afterMath = doc.indexOf("$ b") + 1;
    view.dispatch({ selection: { anchor: afterMath } });
    view.focus();

    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      code: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    }));

    expect(editor.getCursorContext()?.inline?.kind).toBe("Math");
    expect(editor.getCursorContext()?.position).toBe(doc.indexOf("x") + 1);
    expect(parent.querySelector(".cf-math-source")).not.toBeNull();
    editor.unmount();
  });

  it("does not emit host change callbacks for setDoc", () => {
    const parent = document.createElement("div");
    const onChange = vi.fn();
    const onDocumentChange = vi.fn();
    const editor = mountEditor({ parent, doc: "old", onChange, onDocumentChange });

    editor.setDoc("new");

    expect(editor.getDoc()).toBe("new");
    expect(editor.getCst()?.text).toBe("new");
    expect(onChange).not.toHaveBeenCalled();
    expect(onDocumentChange).not.toHaveBeenCalled();
    editor.unmount();
  });
});
