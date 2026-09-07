import { defaultKeymap, history, redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Extension, Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { getPandocCstUpdateCountForTesting, getPandocTree, pandocCstField } from "../cst/pandoc-cst-field";
import { editingAssistanceExtension } from "./editing-assistance";
import { pairedMarkupExtension } from "./paired-markup";

const PAIRS = [
  ["*", "*"], ["_", "_"], ["$", "$"], ["`", "`"],
  ["~", "~"], ["^", "^"], ["'", "'"], ['"', '"'],
  ["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"],
] as const;

describe("paired markup typing", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const view of views) {
      view.destroy();
      view.dom.remove();
    }
    views.length = 0;
  });

  function mount(
    doc: string,
    selection = EditorSelection.single(0, doc.length),
    assistance: Extension = pairedMarkupExtension(),
    extensions: Extension = [],
  ): EditorView {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: Text.of(doc.split("\n")),
        selection,
        extensions: [
          pandocCstField,
          history(),
          EditorState.allowMultipleSelections.of(true),
          assistance,
          keymap.of(defaultKeymap),
          extensions,
        ],
      }),
    });
    views.push(view);
    return view;
  }

  function type(view: EditorView, text: string, from = view.state.selection.main.from, to = view.state.selection.main.to): boolean {
    const insert = () => view.state.update(view.state.replaceSelection(text), { userEvent: "input.type" });
    const handled = view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, text, insert));
    if (!handled && !view.state.readOnly) view.dispatch(insert());
    return handled;
  }

  function expectSource(view: EditorView, source: string, updates: number): void {
    expect(view.state.doc.toString()).toBe(source);
    expect(getPandocTree(view.state).text).toBe(source);
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(updates);
  }

  it.each(PAIRS)("wraps forward and backward Unicode selections with %s", (open, close) => {
    const doc = "Before 中文 😀 after.";
    const from = doc.indexOf("中");
    const to = from + "中文 😀".length;
    for (const backward of [false, true]) {
      const selection = EditorSelection.single(backward ? to : from, backward ? from : to);
      const view = mount(doc, selection);
      expect(type(view, open)).toBe(true);
      expectSource(view, `Before ${open}中文 😀${close} after.`, 1);
      expect(view.state.selection.main.anchor).toBe(selection.main.anchor + 1);
      expect(view.state.selection.main.head).toBe(selection.main.head + 1);
      expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("中文 😀");
      expect(undo(view)).toBe(true);
      expectSource(view, doc, 2);
      expect(view.state.selection.eq(selection)).toBe(true);
      expect(redo(view)).toBe(true);
      expectSource(view, `Before ${open}中文 😀${close} after.`, 3);
    }
  });

  it.each(["*", "_", "$", "`", "~"])("keeps the inner selection when repeatedly typing %s", (token) => {
    const view = mount("text");
    type(view, token);
    type(view, token);
    expectSource(view, `${token}${token}text${token}${token}`, 2);
    expect(view.state.selection.eq(EditorSelection.single(2, 6))).toBe(true);
  });

  it("wraps a selection across CRLF lines without rewriting its contents", () => {
    const source = "中文 😀\r\nsecond line";
    const view = mount(source);
    type(view, "*");
    expectSource(view, `*${source}*`, 1);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(source);
  });

  it.each(["*", "["])("preserves multiple selections and their main index with %s", (open) => {
    const view = mount("one two", EditorSelection.create([
      EditorSelection.range(0, 3), EditorSelection.range(7, 4),
    ], 1));
    type(view, open);
    const close = open === "[" ? "]" : open;
    expectSource(view, `${open}one${close} ${open}two${close}`, 1);
    expect(view.state.selection.eq(EditorSelection.create([
      EditorSelection.range(1, 4), EditorSelection.range(10, 7),
    ], 1))).toBe(true);
  });

  it.each(["*", "["])("preserves selected text with %s even when another caret is inside a word", (open) => {
    const view = mount("one two", EditorSelection.create([
      EditorSelection.range(0, 3), EditorSelection.cursor(5),
    ], 1));
    type(view, open);
    const close = open === "[" ? "]" : open;
    expectSource(view, `${open}one${close} t${open}wo`, 1);
    expect(view.state.selection.eq(EditorSelection.create([
      EditorSelection.range(1, 4), EditorSelection.cursor(8),
    ], 1))).toBe(true);
  });

  it.each([["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"]])(
    "inserts %s and skips the automatically inserted closer",
    (open, close) => {
      const view = mount("");
      type(view, open);
      expectSource(view, open + close, 1);
      expect(view.state.selection.main.head).toBe(1);
      type(view, "x");
      type(view, close);
      expect(view.state.doc.toString()).toBe(open + "x" + close);
      expect(view.state.selection.main.head).toBe(3);
      expect(getPandocTree(view.state).text).toBe(view.state.doc.toString());
    },
  );

  it.each(["()", "[]", "{}", "<>"])("removes an empty %s pair with Backspace", (pair) => {
    const view = mount(pair, EditorSelection.single(1));
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expectSource(view, "", 1);
    expect(view.state.selection.main.head).toBe(0);
    expect(undo(view)).toBe(true);
    expectSource(view, pair, 2);
    expect(view.state.selection.main.head).toBe(1);
  });

  it("supports nested pairs and only skips generated closers", () => {
    const view = mount("]", EditorSelection.single(0));
    type(view, "]");
    expectSource(view, "]]", 1);
    const nested = mount("");
    for (const char of "([{<>}])") type(nested, char);
    expect(nested.state.doc.toString()).toBe("([{<>}])");
    expect(nested.state.selection.main.head).toBe(8);
  });

  it.each(["**", "$$", "```", "_", "'", '"'])("keeps %s literal at an empty caret", (source) => {
    const view = mount("");
    for (const char of source) type(view, char);
    expectSource(view, source, source.length);
    expect(view.state.selection.main.head).toBe(source.length);
  });

  it("inserts ordinary text normally and leaves bulk input alone", () => {
    const view = mount("selected");
    expect(type(view, "**")).toBe(false);
    expectSource(view, "**", 1);
    expect(view.state.selection.main.empty).toBe(true);
    const ordinary = mount("selected");
    expect(type(ordinary, "x")).toBe(false);
    expectSource(ordinary, "x", 1);
  });

  it("ignores readonly, composition, and input outside the current selection", () => {
    const readonly = mount("selected", undefined, undefined, EditorState.readOnly.of(true));
    expect(type(readonly, "*")).toBe(false);
    expectSource(readonly, "selected", 0);
    const composing = mount("selected");
    composing.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(type(composing, "*")).toBe(false);
    composing.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    const mismatched = mount("selected");
    expect(type(mismatched, "*", 0, 1)).toBe(false);
  });

  it.each([false, { markupCompletion: false }] as const)("respects disabled assistance: %j", (options) => {
    const view = mount("selected", undefined, editingAssistanceExtension(options));
    expect(type(view, "*")).toBe(false);
    expectSource(view, "*", 1);
    expect(type(view, "[")).toBe(false);
    expectSource(view, "*[", 2);
  });
});
