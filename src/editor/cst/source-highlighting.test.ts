import { cursorCharLeft, cursorCharRight, undo } from "@codemirror/commands";
import { javascript } from "@codemirror/legacy-modes/mode/javascript";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSS } from "../../core/constants/css-classes";
import { createSimpleEditor } from "../simple-editor";
import { cstEditDecorationPlugin } from "./edit-surface";
import { getPandocTree, pandocCstField } from "./pandoc-cst-field";

describe("CST source highlighting", () => {
  let editor: ReturnType<typeof createSimpleEditor>;

  afterEach(() => editor?.destroy());

  function mount(doc: string): void {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = createSimpleEditor({ parent, doc });
  }

  function tokens(className: string): string[] {
    return [...editor.dom.querySelectorAll(`.${CSS.sourceToken}.${className}`)]
      .map((element) => element.textContent?.trim() ?? "");
  }

  function sourceLines(className: string): string {
    return [...editor.dom.querySelectorAll(`.cm-line.${className}`)]
      .map((element) => element.textContent).join("\n");
  }

  it("reuses code tokens on cursor moves near the end of a large fence", () => {
    const doc = `\`\`\`js\n/* comment\n${"comment 中文 😀\n".repeat(20_000)}*/\nreturn 42;\n\`\`\``;
    const visible = { from: doc.length - 2_000, to: doc.length };
    vi.spyOn(EditorView.prototype, "visibleRanges", "get").mockReturnValue([visible]);
    vi.spyOn(EditorView.prototype, "viewport", "get").mockReturnValue(visible);
    const tokenize = vi.spyOn(javascript, "token");
    mount(doc);
    expect(tokenize).toHaveBeenCalled();
    const tree = getPandocTree(editor.state);
    tokenize.mockClear();

    const position = doc.indexOf("42;");
    for (const anchor of [position, position + 1, position + 2]) {
      editor.dispatch({ selection: { anchor } });
      expect(editor.state.selection.main.head).toBe(anchor);
      expect(getPandocTree(editor.state)).toBe(tree);
    }
    expect(tokenize.mock.calls.length).toBe(0);

    const decorations = editor.plugin(cstEditDecorationPlugin)?.presentation.decorations;
    if (!decorations) throw new Error("Missing source decorations");
    const highlighted: string[] = [];
    decorations.between(position, position + 2, (from, to, decoration) => {
      if (decoration.spec.class?.includes("tok-number")) highlighted.push(doc.slice(from, to));
    });
    expect(highlighted).toEqual(["42"]);
    expect(editor.state.field(pandocCstField).updateCount).toBe(0);

    editor.dispatch({ effects: StateEffect.appendConfig.of(EditorState.tabSize.of(8)) });
    expect(tokenize.mock.calls.length).toBeGreaterThan(0);
    expect(getPandocTree(editor.state)).toBe(tree);
  });

  it("limits table tokens to each visible range, including partial cells", () => {
    const doc = [
      "| **Heading** | Value |", "| --- | --- |",
      ...Array.from({ length: 10_000 }, (_, index) => `| **row${index}** | $42$ |`),
    ].join("\n");
    const visible = [
      { from: 0, to: doc.indexOf("| **row0") },
      { from: doc.indexOf("row9900") + 2, to: doc.indexOf("row9902") + 3 },
    ];
    vi.spyOn(EditorView.prototype, "visibleRanges", "get").mockReturnValue(visible);
    vi.spyOn(EditorView.prototype, "viewport", "get").mockReturnValue({ from: 0, to: doc.length });
    editor = new EditorView({
      doc,
      selection: { anchor: visible[1].from },
      extensions: [pandocCstField, cstEditDecorationPlugin],
    });
    const decorations = editor.plugin(cstEditDecorationPlugin)?.presentation.decorations;
    if (!decorations) throw new Error("Missing source decorations");
    const highlighted: string[] = [];
    for (const cursor = decorations.iter(); cursor.value; cursor.next()) {
      if (!cursor.value.spec.class?.includes(CSS.sourceToken)) continue;
      expect(visible.some((range) => range.from <= cursor.from && cursor.to <= range.to)).toBe(true);
      highlighted.push(doc.slice(cursor.from, cursor.to));
    }
    expect(highlighted).toContain("Heading");
    expect(highlighted).toContain("w9900");
    expect(highlighted).toContain("row9901");
    expect(highlighted).toContain("row");
    expect(highlighted.filter((text) => text === "42")).toHaveLength(2);
    expect(highlighted.length).toBeLessThan(50);
    const tree = getPandocTree(editor.state);
    let offscreenRow = tree.resolve(doc.indexOf("row5000"));
    while (offscreenRow.parent && offscreenRow.kind !== "TableRow") offscreenRow = offscreenRow.parent;
    expect(offscreenRow.kind).toBe("TableRow");
    const offscreenChildren = vi.spyOn(offscreenRow, "children");
    editor.dispatch({ selection: { anchor: visible[1].from + 1 } });
    expect(offscreenChildren.mock.calls.length).toBe(0);
    expect(getPandocTree(editor.state)).toBe(tree);
    expect(tree.text).toBe(doc);
  });

  it.each([
    ["js", 'const value = 42; // 中文 😀', "const"],
    ["TS", "const value: number = 42;", "const"],
    ["json", '{"value": 42}', ""],
    ["py", "return 42", "return"],
    ["bash", "echo 42", "echo"],
    ["c", "return 42;", "return"],
    ["c++", "return 42;", "return"],
    ["hs", "if True then 42 else 0", "if"],
    ["yml", "value: 42", ""],
    ["latex", "\\(\\frac{42}{x}\\)", "\\frac"],
  ])("highlights %s code using the existing tokenizers", (language, code, keyword) => {
    const block = `\`\`\`${language}\n${code}\n\`\`\``;
    const doc = `Before 中文 😀.\n\n${block}\n\nAfter.`;
    mount(doc);
    expect(tokens("tok-number")).toContain("42");
    if (keyword) expect(tokens("tok-keyword")).toContain(keyword);
    expect(sourceLines("cf-cst-code-block")).toBe(block);
    const lines = [...editor.dom.querySelectorAll(".cf-cst-code-block")];
    expect(lines[0]?.querySelector(".cf-source-token")).toBeNull();
    expect(lines.at(-1)?.querySelector(".cf-source-token")).toBeNull();
    expect(getPandocTree(editor.state).text).toBe(doc);
    expect(editor.state.field(pandocCstField).updateCount).toBe(0);
  });

  it.each(["\n", "\r\n"])("updates code highlights and language labels with %j line endings", (ending) => {
    mount(["Before 中文 😀.", "", "```js", 'const value = "😀";', "/* comment", "", "still comment */", "return 42;", "```", "After."].join(ending));
    const doc = editor.state.doc.toString();
    const position = doc.indexOf("42");
    const tree = getPandocTree(editor.state);
    editor.dispatch({ selection: { anchor: position } });
    expect(getPandocTree(editor.state)).toBe(tree);
    expect(tokens("tok-comment")).toEqual(["/* comment", "still comment */"]);
    expect(tokens("tok-keyword")).toEqual(["const", "return"]);
    const number = editor.dom.querySelector(".cf-source-token.tok-number");
    if (!number) throw new Error("Missing code number");
    expect(editor.posAtDOM(number, 0)).toBe(position);
    editor.dispatch({ changes: { from: position, to: position + 2, insert: "7" }, selection: { anchor: position + 1 }, userEvent: "input.type" });
    expect(tokens("tok-number")).toEqual(["7"]);
    expect(editor.state.selection.main.head).toBe(position + 1);
    expect(editor.state.field(pandocCstField).updateCount).toBe(1);
    expect(getPandocTree(editor.state).text).toBe(doc.replace("42", "7"));
    expect(undo(editor)).toBe(true);
    expect(tokens("tok-number")).toEqual(["42"]);
    const language = doc.indexOf("js");
    editor.dispatch({ changes: { from: language, to: language + 2, insert: "text" }, userEvent: "input.type" });
    expect(editor.dom.querySelectorAll(".cf-source-token")).toHaveLength(0);
    expect(undo(editor)).toBe(true);
    expect(tokens("tok-keyword")).toEqual(["const", "return"]);
    expect(getPandocTree(editor.state).text).toBe(doc);
  });

  it.each(["", "unknown", "constructor", "{.python}"])("keeps unsupported code info %j plain", (info) => {
    const doc = `\`\`\`${info}\nreturn 42\n\`\`\`\n\n    return 42`;
    mount(doc);
    expect(editor.dom.querySelectorAll(".cf-source-token")).toHaveLength(0);
    expect(getPandocTree(editor.state).text).toBe(doc);
  });

  it("bounds multiline code tokens by their CST fences and handles unfinished fences", () => {
    const doc = '```python\n"""string\n\nreturn 1\n```\n\n~~~js\nreturn 42;\n~~~\n\n```python\nreturn 13';
    mount(doc);
    expect(tokens("tok-string")).toEqual(['"""string', "return 1"]);
    expect(tokens("tok-keyword")).toEqual(["return"]);
    expect(tokens("tok-number")).toEqual(["42"]);
    expect(getPandocTree(editor.state).text).toBe(doc);
  });

  it.each(["\n", "\r\n"])("colors YAML reached by keyboard with %j line endings", (ending) => {
    const lines = [
      "\ufeff---", 'title: "数学 😀"', "count: 42", "enabled: true", "# comment",
      "description: |", "  First line", "", "  Second line", "---", "After.",
    ];
    mount(lines.join(ending));
    const doc = editor.state.doc.toString();
    const tree = getPandocTree(editor.state);
    expect(tokens("tok-atom")).toEqual([]);
    expect(cursorCharLeft(editor)).toBe(true);
    expect(getPandocTree(editor.state)).toBe(tree);
    expect(tokens("tok-atom")).toEqual(["title", "count", "enabled", "description"]);
    expect(tokens("tok-number")).toEqual(["42"]);
    expect(tokens("tok-keyword")).toEqual(["true"]);
    expect(tokens("tok-comment")).toEqual(["# comment"]);
    expect(tokens("tok-string")).toEqual(['"数学 😀"', "First line", "Second line"]);
    // CM's special-character widget presents the BOM as a visible dot.
    expect(sourceLines(CSS.yamlSource).split("\n").slice(1)).toEqual(lines.slice(1, -1));

    const from = doc.indexOf("42");
    editor.dispatch({
      changes: { from, to: from + 2, insert: '"unfinished' },
      selection: { anchor: from + 11 },
      userEvent: "input.type",
    });
    expect(tokens("tok-number")).toEqual([]);
    expect(tokens("tok-string")).toContain('"unfinished');
    expect(editor.state.selection.main.head).toBe(from + 11);
    expect(editor.state.field(pandocCstField).updateCount).toBe(1);
    expect(getPandocTree(editor.state).text).toBe(editor.state.doc.toString());
    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(doc);
    expect(getPandocTree(editor.state).text).toBe(doc);
    expect(tokens("tok-number")).toEqual(["42"]);
    editor.dispatch({ selection: { anchor: doc.length } });
    expect(tokens("tok-atom")).toEqual([]);
  });

  it.each([
    ["$$\n\\frac{α}{2} % 中文 😀\n+ 3\n$$", true],
    ["\\[\n\\frac{α}{2} % 中文 😀\n\n+ 3\n\\]", true],
    ["$\\frac{α}{2} + 3$", false],
    ["\\(\\frac{α}{2} + 3\\)", false],
  ])("colors math source without changing its positions: %s", (math, display) => {
    const doc = `Before 中文 😀.\n\n${math}\n\nAfter.`;
    mount(doc);
    const tree = getPandocTree(editor.state);
    editor.dispatch({ selection: { anchor: doc.indexOf("\\frac") } });
    expect(getPandocTree(editor.state)).toBe(tree);
    expect(tokens("tok-keyword")).toContain("\\frac");
    expect(tokens("tok-number")).toEqual(["2", "3"]);
    expect(tokens("tok-punctuation")).toEqual(["{", "}", "{", "}"]);
    if (display) {
      expect(tokens("tok-comment")).toEqual(["% 中文 😀"]);
      expect(sourceLines(CSS.mathSourceLine)).toBe(math);
    }
    const number = editor.dom.querySelector(`.${CSS.sourceToken}.tok-number`);
    if (!number) throw new Error("Missing highlighted number");
    expect(editor.posAtDOM(number, 0)).toBe(doc.indexOf("2"));
    editor.dispatch({
      changes: { from: doc.indexOf("2"), to: doc.indexOf("2") + 1, insert: "27" },
      selection: { anchor: doc.indexOf("2") + 2 },
      userEvent: "input.type",
    });
    expect(tokens("tok-number")).toEqual(["27", "3"]);
    expect(editor.state.field(pandocCstField).updateCount).toBe(1);
    expect(getPandocTree(editor.state).text).toBe(editor.state.doc.toString());
    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(doc);
    expect(tokens("tok-number")).toEqual(["2", "3"]);
    editor.dispatch({ selection: { anchor: doc.length } });
    expect(tokens("tok-keyword")).toEqual([]);
  });

  it.each(["$$42$$", "\\[42\\]", "$42$", "\\(42\\)"])(
    "nests equal-range math token marks inside source marks: %s",
    (math) => {
      const doc = `Before 中文 😀.\n\n${math}\n\nAfter.`;
      mount(doc);
      const position = doc.indexOf("42");
      editor.dispatch({ selection: { anchor: position } });
      const source = editor.dom.querySelector(`.${CSS.mathSource}`);
      const number = source?.querySelector(`.${CSS.sourceToken}.tok-number`);
      expect(number?.textContent).toBe("42");
      if (!number) throw new Error("Missing nested math number");
      expect(editor.posAtDOM(number, 0)).toBe(position);
      expect(getPandocTree(editor.state).text).toBe(doc);
      editor.dispatch({
        changes: { from: position, to: position + 2, insert: "7" },
        selection: { anchor: position + 1 },
      });
      expect(editor.dom.querySelector(`.${CSS.mathSource} .tok-number`)?.textContent).toBe("7");
      expect(editor.state.selection.main.head).toBe(position + 1);
      expect(getPandocTree(editor.state).text).toBe(doc.replace("42", "7"));
      expect(undo(editor)).toBe(true);
      expect(editor.dom.querySelector(`.${CSS.mathSource} .tok-number`)?.textContent).toBe("42");
      expect(getPandocTree(editor.state).text).toBe(doc);
    },
  );

  it("colors table CST tokens while preserving every literal character", () => {
    const table = [
      "| Heading | Value |", "| :--- | ---: |",
      "| 中文 😀 **bold** *italic* `code` | [link](https://example.org) $\\frac{x}{2}$ |",
    ].join("\n");
    const doc = `Before.\n\n${table}\n\nAfter.`;
    mount(doc);
    const position = doc.indexOf("$\\frac");
    editor.dispatch({ selection: { anchor: position } });
    expect(sourceLines(CSS.tableSource)).toBe(table);
    expect(tokens("tok-punctuation")).toContain("| :--- | ---: |");
    expect(tokens("tok-strong")).toEqual(["bold"]);
    expect(tokens("tok-emphasis")).toEqual(["italic"]);
    expect(tokens("tok-monospace")).toEqual(["code"]);
    expect(tokens("tok-url")).toEqual(["https://example.org"]);
    expect(tokens("tok-keyword")).toEqual(["\\frac"]);
    expect(tokens("tok-number")).toEqual(["2"]);
    expect(editor.dom.querySelector(`.${CSS.tableSource} .katex`)).toBeNull();
    expect(editor.dom.querySelector(`.${CSS.tableSource} a`)).toBeNull();
    const tree = getPandocTree(editor.state);
    expect(cursorCharRight(editor)).toBe(true);
    expect(editor.state.selection.main.head).toBe(position + 1);
    expect(cursorCharLeft(editor)).toBe(true);
    expect(editor.state.selection.main.head).toBe(position);
    expect(getPandocTree(editor.state)).toBe(tree);
    editor.dispatch({ selection: { anchor: 0, head: doc.length } });
    expect(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)).toBe(doc);
    expect(getPandocTree(editor.state).text).toBe(doc);
  });

  it("keeps token state within each CST region", () => {
    const doc = '---\ndescription: |\n  title: text\n---\n\nProse title: 42 # comment\n\n$$% comment$$\n\n$$\\alpha + 2$$\n\n```\nkey: 42\n\\alpha\n```';
    mount(doc);
    editor.dispatch({ selection: { anchor: doc.indexOf("description") } });
    expect(tokens("tok-string")).toEqual(["title: text"]);
    editor.dispatch({ selection: { anchor: doc.indexOf("\\alpha") } });
    expect(tokens("tok-string")).toEqual([]);
    expect(tokens("tok-comment")).toEqual([]);
    expect(tokens("tok-keyword")).toEqual(["\\alpha"]);
    expect(tokens("tok-number")).toEqual(["2"]);
    expect(editor.state.doc.toString()).toBe(doc);
  });
});
