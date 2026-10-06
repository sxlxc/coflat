import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountEditor } from "./editor";
import type { EditorDocumentChange, MountedEditor, SaveHandler } from "./editor";
import { CSS } from "./src/core/constants/css-classes";
import { DOCUMENT_SURFACE_CLASS } from "./src/core/document-surface-classes";

function mountedView(parent: HTMLElement): EditorView {
  const editor = parent.querySelector<HTMLElement>(".cm-editor");
  const view = editor ? EditorView.findFromDOM(editor) : null;
  if (!view) throw new Error("CodeMirror view was not mounted");
  return view;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function mountHostEditor(options: {
  readonly doc: string;
  readonly onChange?: (doc: string) => void;
  readonly onDocumentChange?: (change: EditorDocumentChange) => void;
  readonly saveHandler?: SaveHandler;
}): { readonly editor: MountedEditor; readonly view: EditorView } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const editor = mountEditor({
    parent,
    doc: options.doc,
    onChange: options.onChange,
    onDocumentChange: options.onDocumentChange,
    saveHandler: options.saveHandler,
  });
  cleanups.push(() => {
    editor.unmount();
    parent.remove();
  });
  return { editor, view: mountedView(parent) };
}

describe("mountEditor", () => {
  it("exposes numbered CST headings and keeps their UTF-16 destinations current", () => {
    const doc = "---\ntitle: Paper\n---\n\n😀 中文\n\n# Intro {#sec:intro}\n\n## Detail\n\n### Deep\n\n```md\n# Not a section\n```\n\n# Aside {-}\n\n# Appendix {.appendix}\n\n## Proof\n\nEnd.";
    const { editor, view } = mountHostEditor({ doc });
    const outline = editor.getOutline();
    expect(outline).toEqual([
      { from: doc.indexOf("# Intro"), level: 1, number: "1", title: "Intro" },
      { from: doc.indexOf("## Detail"), level: 2, number: "1.1", title: "Detail" },
      { from: doc.indexOf("### Deep"), level: 3, number: "1.1.1", title: "Deep" },
      { from: doc.indexOf("# Aside"), level: 1, number: "", title: "Aside" },
      { from: doc.indexOf("# Appendix"), level: 1, number: "", title: "Appendix" },
      { from: doc.indexOf("## Proof"), level: 2, number: "A.1", title: "Proof" },
    ]);
    editor.scrollToPosition(doc.indexOf("End."));
    expect(editor.getOutline()).toBe(outline);
    view.dispatch({ changes: { from: doc.indexOf("😀"), insert: "More 😀\n\n" } });
    expect(editor.getOutline().map((heading) => heading.from)).toEqual(outline.map((heading) => heading.from + "More 😀\n\n".length));
    const shiftedOutline = editor.getOutline();
    const current = editor.getDoc();
    view.dispatch({ changes: { from: current.indexOf("## Detail"), to: current.indexOf("## Detail") + 9, insert: "# Updated" } });
    expect(editor.getOutline()[1]).toMatchObject({ level: 1, number: "2", title: "Updated" });
    expect(undo(view)).toBe(true);
    expect(editor.getOutline()).toEqual(shiftedOutline);
    expect(undo(view)).toBe(true);
    expect(editor.getOutline()).toEqual(outline);
    editor.setDoc("No headings\n");
    expect(editor.getOutline()).toEqual([]);
    editor.setDoc("Setext\n======\n\nChild\n-----\n");
    expect(editor.getOutline().map(({ title, level, number }) => ({ title, level, number }))).toEqual([
      { title: "Setext", level: 1, number: "1" }, { title: "Child", level: 2, number: "1.1" },
    ]);
  });

  it.each([
    ["populated", "# Intro\n\n## Detail\n\n"],
    ["empty", ""],
  ])("reuses the %s outline after unrelated structural edits", (_name, headings) => {
    const doc = `${headings}::: {.theorem #thm:old}\nStatement.\n:::\n`;
    const { editor, view } = mountHostEditor({ doc });
    const outline = editor.getOutline();
    const from = doc.indexOf("thm:old");

    view.dispatch({ changes: { from, to: from + "thm:old".length, insert: "thm:renamed" } });
    expect(editor.getDoc()).toBe(doc.replace("thm:old", "thm:renamed"));
    expect(editor.getOutline()).toBe(outline);
    expect(undo(view)).toBe(true);
    expect(editor.getOutline()).toBe(outline);
  });

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
    expect("outline" in editor).toBe(false);
    expect("cursorContext" in editor).toBe(false);

    editor.unmount();
    expect(parent.querySelector(".cm-editor")).toBeNull();
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
});

describe("mountEditor host integration", () => {
  it.each([false, true])("publishes the synchronized CST and change metadata (onChange enabled: %s)", (withOnChange) => {
    const changes: EditorDocumentChange[] = [];
    const onChange = vi.fn();
    const { editor, view } = mountHostEditor({
      doc: "alpha",
      onChange: withOnChange ? onChange : undefined,
      onDocumentChange(change) {
        changes.push(change);
      },
    });
    const before = editor.getCst();

    view.dispatch({ changes: { from: 5, insert: " beta" } });

    expect(editor.getDoc()).toBe("alpha beta");
    expect(editor.getCst()?.text).toBe(editor.getDoc());
    expect(editor.getCst()?.version).toBeGreaterThan(before?.version ?? -1);
    expect(changes).toHaveLength(1);
    expect(changes[0].tree).toBe(editor.getCst());
    expect(changes[0].changes.empty).toBe(false);
    if (withOnChange) expect(onChange).toHaveBeenCalledExactlyOnceWith("alpha beta");
    else expect(onChange).not.toHaveBeenCalled();
  });

  it("does not emit document callbacks for programmatic setDoc", () => {
    const onChange = vi.fn();
    const onDocumentChange = vi.fn();
    const { editor, view } = mountHostEditor({
      doc: "alpha",
      onChange,
      onDocumentChange,
    });

    view.dispatch({ changes: { from: 5, insert: " beta" } });
    onChange.mockClear();
    onDocumentChange.mockClear();

    editor.setDoc("short");

    expect(editor.getDoc()).toBe("short");
    expect(editor.getCst()?.text).toBe("short");
    expect(onChange).not.toHaveBeenCalled();
    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  it("keeps delayed document snapshots tied to each change", () => {
    const changes: EditorDocumentChange[] = [];
    const { editor, view } = mountHostEditor({
      doc: "a",
      onDocumentChange(change) {
        changes.push(change);
      },
    });

    view.dispatch({ changes: { from: 1, insert: "b" } });
    view.dispatch({ changes: { from: 2, insert: "c" } });

    expect(changes).toHaveLength(2);
    expect(changes[0].changes.empty).toBe(false);
    expect(changes[1].changes.empty).toBe(false);
    expect(editor.getDoc()).toBe("abc");
    expect(changes.map(({ tree }) => tree.text)).toEqual(["ab", "abc"]);
    expect(changes[0].tree).not.toBe(changes[1].tree);
    expect(changes[1].tree).toBe(editor.getCst());
  });

  it("reuses the synchronized CST source for host updates and reads", () => {
    const onChange = vi.fn();
    const { editor, view } = mountHostEditor({ doc: "数学 😀\r\nBody", onChange });
    const transaction = view.state.update({ changes: { from: 2, insert: " notes" } });
    const nextState = transaction.state;
    const serialize = vi.spyOn(nextState.doc, "toString");
    try {
      view.update([transaction]);
      expect(editor.getDoc()).toBe("数学 notes 😀\nBody");
      expect(editor.getCst()?.text).toBe(editor.getDoc());
      expect(onChange).toHaveBeenCalledWith(editor.getDoc());
      editor.setDoc(editor.getDoc());
      expect(serialize).not.toHaveBeenCalled();
    } finally {
      serialize.mockRestore();
    }
  });

  it("saves the edited source and clears dirty state", async () => {
    const saves: string[] = [];
    const { editor } = mountHostEditor({
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
  });

  it("saves a stable source snapshot while further typing remains dirty", async () => {
    let finishSave: () => void = () => { throw new Error("Save has not started"); };
    const save = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
      finishSave = () => resolve({ ok: true });
    }));
    const { editor, view } = mountHostEditor({ doc: "数学 😀", saveHandler: { save } });
    const pending = editor.triggerSave();
    view.dispatch({ changes: { from: 2, insert: " notes" }, userEvent: "input" });
    finishSave();
    await pending;
    expect(save).toHaveBeenCalledWith({ source: "数学 😀", reason: "manual" });
    expect(editor.isSaved()).toBe(false);
    expect(undo(view)).toBe(true);
    expect(editor.getDoc()).toBe("数学 😀");
    expect(editor.isSaved()).toBe(true);
  });

  it("keeps the source cursor stable for a localized setDoc update", () => {
    const { editor } = mountHostEditor({ doc: "# Intro\n\nfirst\n\nsecond\n" });
    const cursor = "# Intro\n\nfirst\n\nsec".length;
    editor.scrollToPosition(cursor);

    editor.setDoc("# Intro\n\nfirst\n\nsecond\n\nthird\n");

    expect(editor.getCursorContext()?.position).toBe(cursor);
    expect(editor.getCst()?.text).toBe(editor.getDoc());
  });

  it.each([
    ["abcdef", "aXYZf", 2, 4],
    ["abcdef", "aXYZf", 4, 2],
    ["中文 😀 abcdef", "中文 😀 aXYZf", 8, 10],
  ] as const)("replaces %s while mapping an enclosed selection", (doc, replacement, anchor, head) => {
    const { editor, view } = mountHostEditor({ doc });
    view.dispatch({ selection: { anchor, head } });

    editor.setDoc(replacement);

    expect(editor.getDoc()).toBe(replacement);
    expect(editor.getCst()?.text).toBe(replacement);
    expect(view.state.selection.main.from).toBe(replacement.indexOf("XYZ"));
    expect(view.state.selection.main.to).toBe(replacement.indexOf("XYZ") + 3);
    editor.insertText("done");
    expect(editor.getDoc()).toBe(replacement.replace("XYZ", "done"));
    expect(editor.getCst()?.text).toBe(editor.getDoc());
  });

  it("keeps newly loaded YAML metadata collapsed at a visible caret boundary", () => {
    const { editor, view } = mountHostEditor({ doc: "alpha" });
    const doc = "---\ntitle: Loaded Title\n---\nBody";

    editor.setDoc(doc);

    const metadata = editor.getCst()?.topLevelBlocks()[0];
    expect(metadata?.kind).toBe("YamlMetadata");
    expect(view.state.selection.main.head).toBe(metadata?.to);
    expect(view.dom.querySelectorAll(`.cm-line.${CSS.yamlHidden}`)).toHaveLength(3);
    expect(view.dom.querySelector(".cf-doc-title")?.textContent)
      .toBe("Loaded Title");
  });

  it("inserts text at the current selection as a normal editor change", () => {
    const onChange = vi.fn();
    const changes: EditorDocumentChange[] = [];
    const { editor, view } = mountHostEditor({
      doc: "alpha omega",
      onChange,
      onDocumentChange(change) {
        changes.push(change);
      },
    });
    view.dispatch({ selection: { anchor: 5 } });

    editor.insertText(" beta");

    expect(editor.getDoc()).toBe("alpha beta omega");
    expect(onChange).toHaveBeenCalledWith("alpha beta omega");
    expect(changes).toHaveLength(1);
    expect(changes[0].changes.empty).toBe(false);
  });

  it("replaces the current selection when inserting text", () => {
    const { editor, view } = mountHostEditor({
      doc: "alpha TODO omega",
    });
    const from = "alpha ".length;
    const to = from + "TODO".length;
    view.dispatch({ selection: { anchor: from, head: to } });

    editor.insertText("done");

    expect(editor.getDoc()).toBe("alpha done omega");
  });

  it("inserts text at an explicit source position without replacing the current selection", () => {
    const { editor, view } = mountHostEditor({
      doc: "alpha TODO omega",
    });
    const from = "alpha ".length;
    const to = from + "TODO".length;
    view.dispatch({ selection: { anchor: from, head: to } });

    editor.insertText(" beta", { position: "alpha TODO".length });

    expect(editor.getDoc()).toBe("alpha TODO beta omega");
  });
});
