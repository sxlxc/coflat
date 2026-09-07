import { redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, RangeSet } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CSS } from "../../core/constants/css-classes";
import { createSimpleEditor } from "../simple-editor";
import { cstDisplayMathDecorationField, selectedFencedDivs } from "./edit-surface";
import { getPandocTree, pandocCstField } from "./pandoc-cst-field";
import { cstTableDecorationField } from "./table-surface";

describe("CST block selection decorations", () => {
  it("handles mapped selections that enclose a host replacement", () => {
    const extensions = [pandocCstField, cstDisplayMathDecorationField];
    const before = EditorState.create({ doc: "abcdef", selection: { anchor: 2, head: 4 }, extensions });
    const after = before.update({ changes: { from: 1, to: 5, insert: "\n\n$$x$$\n\n" } }).state;
    const normalized = EditorSelection.single(after.selection.main.anchor, after.selection.main.head);
    const rebuilt = EditorState.create({ doc: after.doc, selection: normalized, extensions });
    expect(RangeSet.eq(
      [after.field(cstDisplayMathDecorationField).decorations],
      [rebuilt.field(cstDisplayMathDecorationField).decorations],
    )).toBe(true);
    expect(selectedFencedDivs(after)).toEqual([]);
    expect(getPandocTree(after).text).toBe("a\n\n$$x$$\n\nf");
  });

  it("updates display math locally while preserving distant decorations", () => {
    const doc = `$$a=0$$\n\n${"Ordinary *prose* with words.\n\n".repeat(24_000)}$$x=1$$\n\nTail.`;
    const position = doc.indexOf("x=1");
    const extensions = [pandocCstField, cstDisplayMathDecorationField];
    let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions });
    const distant = state.field(cstDisplayMathDecorationField).decorations.iter().value;
    const tree = getPandocTree(state);
    const prototype: Pick<typeof tree, "iterate"> = Object.getPrototypeOf(tree);
    const iterate = tree.iterate;
    let visited = 0;
    const spy = vi.spyOn(prototype, "iterate").mockImplementation(function (
      this: typeof tree,
      visitor,
      range,
    ) {
      iterate.call(this, {
        enter(node) {
          visited += 1;
          return typeof visitor === "function" ? visitor(node) : visitor.enter?.(node);
        },
        leave: typeof visitor === "function" ? undefined : visitor.leave,
      }, range);
    });
    try {
      for (const transaction of [
        { selection: { anchor: position } },
        { changes: { from: position + 1, insert: "+中文" } },
        { selection: { anchor: doc.length } },
      ]) {
        visited = 0;
        state = state.update(transaction).state;
        expect(visited).toBeLessThan(500);
        expect(state.field(cstDisplayMathDecorationField).decorations.iter().value).toBe(distant);
        expect(getPandocTree(state).text).toBe(state.doc.toString());
      }
    } finally {
      spy.mockRestore();
    }
    const rebuilt = EditorState.create({ doc: state.doc, selection: state.selection, extensions });
    expect(RangeSet.eq(
      [state.field(cstDisplayMathDecorationField).decorations],
      [rebuilt.field(cstDisplayMathDecorationField).decorations],
    )).toBe(true);
  });

  it("keeps shared source lines and neighboring math consistent with a full rebuild", () => {
    const doc = "Before.\n\n$$a$$ and $$b$$\n\n  $$c\nd$$\n\nAfter.";
    const extensions = [pandocCstField, cstDisplayMathDecorationField, EditorState.allowMultipleSelections.of(true)];
    let state = EditorState.create({ doc, extensions });
    for (const transaction of [
      { selection: { anchor: doc.indexOf("b$$") } },
      { selection: EditorSelection.create([
        EditorSelection.cursor(doc.indexOf("a$$")),
        EditorSelection.cursor(doc.indexOf("c\n")),
      ]) },
      { changes: { from: doc.indexOf("$$a"), to: doc.indexOf(" and"), insert: "" } },
      { selection: { anchor: 0 } },
      { changes: { from: 0, to: 9, insert: "中文\n" } },
      { selection: { anchor: 0, head: 20 } },
    ]) {
      state = state.update(transaction).state;
      const rebuilt = EditorState.create({ doc: state.doc, selection: state.selection, extensions });
      expect(RangeSet.eq(
        [state.field(cstDisplayMathDecorationField).decorations],
        [rebuilt.field(cstDisplayMathDecorationField).decorations],
      )).toBe(true);
      expect(getPandocTree(state).text).toBe(state.doc.toString());
    }
  });

  it("updates a math replacement after editing its leading source whitespace", () => {
    const extensions = [pandocCstField, cstDisplayMathDecorationField];
    const before = EditorState.create({ doc: "Start 😀.\n\n  $$x$$\n\n$$y$$", extensions });
    const after = before.update({ changes: { from: 1, to: 12, insert: "\n\n" } }).state;
    const rebuilt = EditorState.create({ doc: after.doc, selection: after.selection, extensions });
    expect(RangeSet.eq(
      [after.field(cstDisplayMathDecorationField).decorations],
      [rebuilt.field(cstDisplayMathDecorationField).decorations],
    )).toBe(true);
    expect(after.field(cstDisplayMathDecorationField).decorations.iter().from).toBe(3);
  });

  it("renders math exposed throughout a former table after deleting its header", () => {
    const extensions = [pandocCstField, cstDisplayMathDecorationField];
    const doc = "Start 😀.\n\n  $$x$$\n\n$$y$$ and $$z$$\n\nA|$$m$$\n---|---\n$$n$$|b\n\nEnd.\n";
    const before = EditorState.create({ doc, extensions });
    const after = before.update({ changes: { from: 28, to: 39, insert: "\n\n" } }).state;
    const rebuilt = EditorState.create({ doc: after.doc, selection: after.selection, extensions });
    expect(RangeSet.eq(
      [after.field(cstDisplayMathDecorationField).decorations],
      [rebuilt.field(cstDisplayMathDecorationField).decorations],
    )).toBe(true);
  });

  it("updates the math replacement boundary when trailing whitespace becomes text", () => {
    const extensions = [pandocCstField, cstDisplayMathDecorationField];
    let state = EditorState.create({ doc: "Before 😀.\r\n\r\n$$x$$  \r\n\r\nAfter.", extensions });
    const end = state.doc.line(3).to;
    expect(state.field(cstDisplayMathDecorationField).decorations.iter().to).toBe(end);
    state = state.update({ changes: { from: end, insert: "中文" } }).state;
    expect(state.field(cstDisplayMathDecorationField).decorations.iter().to).toBe(end - 2);
    state = state.update({ changes: { from: end, to: end + 2, insert: " " } }).state;
    expect(state.field(cstDisplayMathDecorationField).decorations.iter().to).toBe(end + 1);
    const rebuilt = EditorState.create({ doc: state.doc, selection: state.selection, extensions });
    expect(RangeSet.eq(
      [state.field(cstDisplayMathDecorationField).decorations],
      [rebuilt.field(cstDisplayMathDecorationField).decorations],
    )).toBe(true);
    expect(getPandocTree(state).text).toBe(state.doc.toString());
  });

  it("preserves math starting on another display's closing source line", () => {
    const extensions = [pandocCstField, cstDisplayMathDecorationField];
    const doc = "q:$$\n$$x$$\n:::\n$$\n\nAfter.\n";
    const before = EditorState.create({ doc, selection: { anchor: doc.length }, extensions });
    const after = before.update({ selection: { anchor: 0, head: 2 } }).state;
    const rebuilt = EditorState.create({ doc: after.doc, selection: after.selection, extensions });
    expect(RangeSet.eq(
      [after.field(cstDisplayMathDecorationField).decorations],
      [rebuilt.field(cstDisplayMathDecorationField).decorations],
    )).toBe(true);
  });

  it("reveals math when a selection endpoint reaches its opening source line", () => {
    const extensions = [pandocCstField, cstDisplayMathDecorationField];
    const doc = "Before.\n\n$$x$$\n\nAfter.";
    const before = EditorState.create({ doc, extensions });
    const after = before.update({ selection: { anchor: doc.indexOf("$$"), head: 0 } }).state;
    const rebuilt = EditorState.create({ doc: after.doc, selection: after.selection, extensions });
    expect(RangeSet.eq(
      [after.field(cstDisplayMathDecorationField).decorations],
      [rebuilt.field(cstDisplayMathDecorationField).decorations],
    )).toBe(true);
  });

  it("limits short selections to nearby CST nodes in a large document", () => {
    const doc = "Ordinary *prose* with words.\n\n".repeat(24_000);
    const before = EditorState.create({
      doc,
      extensions: [pandocCstField, cstDisplayMathDecorationField, cstTableDecorationField],
    });
    const tree = getPandocTree(before);
    const iterate = tree.iterate.bind(tree);
    let visited = 0;
    const spy = vi.spyOn(tree, "iterate").mockImplementation((visitor, range) => {
      iterate({
        enter(node) {
          visited += 1;
          return typeof visitor === "function" ? visitor(node) : visitor.enter?.(node);
        },
        leave: typeof visitor === "function" ? undefined : visitor.leave,
      }, range);
    });
    try {
      for (const anchor of [1, Math.floor(doc.length / 2), doc.length - 3]) {
        visited = 0;
        const after = before.update({ selection: { anchor, head: anchor + 2 } }).state;
        expect(visited).toBeLessThan(100);
        expect(after.field(cstDisplayMathDecorationField)).toBe(before.field(cstDisplayMathDecorationField));
        expect(after.field(cstTableDecorationField)).toBe(before.field(cstTableDecorationField));
        expect(getPandocTree(after)).toBe(tree);
        expect(after.selection.main.from).toBe(anchor);
        expect(after.selection.main.to).toBe(anchor + 2);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("selected fenced div traversal", () => {
  const doc = "Before\n\n:::: {.theorem}\nStatement.\n\n::: {.proof}\n中文 😀.\n:::\n::::\n\nAfter";
  const outer = doc.indexOf("::::");
  const inner = doc.indexOf("::: {.proof}");
  const innerEnd = doc.indexOf("\n:::\n") + 4;
  const outerEnd = doc.lastIndexOf("::::") + 4;

  it.each([
    [0, []],
    [outer, [outer]],
    [inner, [outer, inner]],
    [innerEnd, [outer, inner]],
    [outerEnd, [outer]],
    [outerEnd + 1, []],
    [doc.length, []],
  ])("finds the enclosing divs at position %i", (position, expected) => {
    const state = EditorState.create({ doc, selection: { anchor: position }, extensions: [pandocCstField] });
    expect(selectedFencedDivs(state).map((node) => node.from)).toEqual(expected);
  });

  it("finds enclosed divs and deduplicates multiple selections", () => {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create([
        EditorSelection.range(outer, inner + 1),
        EditorSelection.cursor(innerEnd),
      ]),
      extensions: [pandocCstField, EditorState.allowMultipleSelections.of(true)],
    });
    expect(selectedFencedDivs(state).map((node) => node.from)).toEqual([outer, inner]);
    const selected = state.update({ selection: { anchor: doc.length, head: 0 } }).state;
    expect(selectedFencedDivs(selected).map((node) => node.from)).toEqual([outer, inner]);
    expect(getPandocTree(selected)).toBe(getPandocTree(state));
  });

  it.each(["", "::: {.proof}\nBody.", "::: {.proof}\nBody.\n:::"])("handles document edges in %j", (source) => {
    const state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [pandocCstField] });
    expect(selectedFencedDivs(state)).toHaveLength(source ? 1 : 0);
  });

  it("prunes unrelated prose on a large document's cursor movement", () => {
    const source = "Ordinary *prose* with words.\n\n".repeat(24_000);
    let state = EditorState.create({ doc: source, extensions: [pandocCstField] });
    const tree = getPandocTree(state);
    const iterate = tree.iterate.bind(tree);
    let visited = 0;
    const spy = vi.spyOn(tree, "iterate").mockImplementation((visitor, range) => {
      iterate({
        enter(node) {
          visited += 1;
          return typeof visitor === "function" ? visitor(node) : visitor.enter?.(node);
        },
        leave: typeof visitor === "function" ? undefined : visitor.leave,
      }, range);
    });
    try {
      for (const anchor of [1, Math.floor(source.length / 2), source.length - 1]) {
        state = state.update({ selection: { anchor } }).state;
        visited = 0;
        expect(selectedFencedDivs(state)).toEqual([]);
        expect(visited).toBeLessThan(20);
        expect(getPandocTree(state)).toBe(tree);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("CST inline source boundaries", () => {
  it.each(["*", "**", "`", "_", "__", "~~", "^", "~"])(
    "keeps %s delimiters visible at either selection endpoint without reparsing",
    (markup) => {
      const body = "résumé中文😀";
      const parent = document.createElement("div");
      document.body.appendChild(parent);
      const editor = createSimpleEditor({
        parent,
        doc: `Before 中文😀.\r\n\r\n${markup}${body}${markup}\r\n\r\nAfter.`,
      });
      try {
        const source = editor.state.doc.toString();
        const tree = getPandocTree(editor.state);
        const from = source.indexOf(markup);
        const to = from + body.length + markup.length * 2;
        for (const selection of [
          { anchor: from },
          { anchor: to },
          { anchor: 0, head: to },
          { anchor: to, head: 0 },
        ]) {
          editor.dispatch({ selection });
          expect([...parent.querySelectorAll(`.${CSS.sourceDelimiter}`)].map(
            (element) => element.textContent,
          )).toEqual([markup, markup]);
          expect(editor.state.selection.main.anchor).toBe(selection.anchor);
          expect(editor.state.selection.main.head).toBe(selection.head ?? selection.anchor);
          expect(editor.state.doc.toString()).toBe(source);
          expect(getPandocTree(editor.state)).toBe(tree);
          expect(tree.text).toBe(source);
        }
        editor.dispatch({ selection: { anchor: source.length } });
        expect(parent.querySelectorAll(`.${CSS.sourceDelimiter}`)).toHaveLength(0);
      } finally {
        editor.destroy();
        parent.remove();
      }
    },
  );
});

describe("CST edit surface list markers", () => {
  let editor: ReturnType<typeof createSimpleEditor> | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function mount(doc: string): HTMLElement {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = createSimpleEditor({ parent, doc });
    return parent;
  }

  it("renders unordered list source markers as bullet glyphs", () => {
    const doc = "- dash\n+ plus\n* star\n1. ordered";
    const parent = mount(doc);

    expect(
      [...parent.querySelectorAll(`.${CSS.listBullet}`)].map(
        (marker) => marker.textContent,
      ),
    ).toEqual(["•", "•", "•"]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("updates the rendered marker when the CST list kind changes", () => {
    const parent = mount("- item");
    expect(parent.querySelectorAll(`.${CSS.listBullet}`)).toHaveLength(1);

    editor?.dispatch({ changes: { from: 0, to: 1, insert: "1." } });
    expect(parent.querySelectorAll(`.${CSS.listBullet}`)).toHaveLength(0);
    expect(editor?.state.doc.toString()).toBe("1. item");

    editor?.dispatch({ changes: { from: 0, to: 2, insert: "-" } });
    expect(parent.querySelectorAll(`.${CSS.listBullet}`)).toHaveLength(1);
    expect(editor?.state.doc.toString()).toBe("- item");
  });
});

describe("CST edit surface block presentation", () => {
  let editor: ReturnType<typeof createSimpleEditor> | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function mount(doc: string): HTMLElement {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = createSimpleEditor({ parent, doc });
    return parent;
  }

  function sectionNumbers(parent: HTMLElement): Array<string | null> {
    return [...parent.querySelectorAll<HTMLElement>(".cf-doc-heading")].map(
      (heading) => heading.dataset.sectionNumber ?? null,
    );
  }

  it("renders hierarchical section numbers without changing source", () => {
    const doc = [
      "# One",
      "",
      "## First",
      "",
      "## Aside {-}",
      "",
      "### Detail",
      "",
      "# Two",
      "",
      "Setext subsection",
      "-----------------",
    ].join("\n");
    const parent = mount(doc);

    expect(sectionNumbers(parent)).toEqual([
      "1",
      "1.1",
      null,
      "1.1.1",
      "2",
      "2.1",
    ]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("uses appendix letters after a top-level appendix boundary", () => {
    const doc = [
      "# Main",
      "",
      "# Appendix {.appendix}",
      "",
      "## First appendix subsection",
      "",
      "# Data",
      "",
      "## Hidden {.unnumbered}",
      "",
      "## Tables",
    ].join("\n");
    const parent = mount(doc);

    expect(sectionNumbers(parent)).toEqual([
      "1",
      null,
      "A.1",
      "B",
      null,
      "B.1",
    ]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("updates following section numbers after an attribute edit", () => {
    const doc = "# One\n\n## First\n\n## Second";
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    expect(sectionNumbers(parent)).toEqual(["1", "1.1", "1.2"]);

    const insertAt = doc.indexOf("\n", doc.indexOf("## First"));
    editor.dispatch({ changes: { from: insertAt, insert: " {-}" } });

    expect(sectionNumbers(parent)).toEqual(["1", null, "1.1"]);
    expect(editor.state.doc.toString()).toBe(
      "# One\n\n## First {-}\n\n## Second",
    );
  });

  it("numbers a heading created in the remainder of a split paragraph", () => {
    const parent = mount("x# New\n\n# Existing");
    if (!editor) throw new Error("Missing mounted editor");
    expect(sectionNumbers(parent)).toEqual(["1"]);
    editor.dispatch({ changes: { from: 0, to: 1, insert: "\n" } });
    expect(sectionNumbers(parent)).toEqual(["1", "2"]);
    expect(getPandocTree(editor.state).text).toBe("\n# New\n\n# Existing");
  });

  it("renders blockquote markers with the dedicated monospace class", () => {
    const doc = "> quoted\n> again";
    const parent = mount(doc);

    const markers = parent.querySelectorAll(`.${CSS.blockquoteMark}`);
    expect(markers).toHaveLength(2);
    expect([...markers].map((marker) => marker.textContent)).toEqual([">", ">"]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("keeps block-looking TeX inside display math with adjacent prose", () => {
    const doc = [
      "Before $$",
      "\\begin{aligned}",
      "x &= 1",
      "\\end{aligned}",
      "$$ after",
    ].join("\n");
    const parent = mount(doc);
    const rendered = parent.querySelector(
      ".cf-math-display:not(.cf-cst-math-preview)",
    );

    expect(rendered).not.toBeNull();
    expect(rendered?.querySelector(".katex-display")).not.toBeNull();
    expect(rendered?.classList.contains(CSS.mathError)).toBe(false);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("renders an unnumbered fenced-div header from its first class and title", () => {
    const doc = [
      "Before",
      "",
      '::: {#label .someRandomClass .theorem title="some title" someAttr="xxx"}',
      "Body.",
      ":::",
    ].join("\n");
    const parent = mount(doc);
    const header = parent.querySelector<HTMLElement>(`.${CSS.fencedDivHeader}`);

    expect(header?.textContent).toBe("SomeRandomClass (some title)");
    expect(header?.dataset.blockClass).toBe("someRandomClass");
    expect(header?.dataset.referenceId).toBe("label");
    expect(header?.textContent).not.toMatch(/\d/);
    expect(
      [...parent.querySelectorAll(".cm-line")].some((line) => line.textContent === ":::"),
    ).toBe(false);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("expands common fenced-div class abbreviations", () => {
    const doc = [
      "Before",
      "",
      "::: {.thm}",
      "Theorem body.",
      ":::",
      "",
      "::: lem",
      "Lemma body.",
      ":::",
    ].join("\n");
    const parent = mount(doc);

    expect(
      [...parent.querySelectorAll(`.${CSS.fencedDivHeader}`)].map(
        (header) => header.textContent,
      ),
    ).toEqual(["Theorem 1", "Lemma 2"]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("resolves simple narrative and bracketed references to div labels", () => {
    const doc = [
      "Before",
      "",
      '::: {#main-result .thm title="Main result"}',
      "Body.",
      ":::",
      "",
      "Use @main-result and [@main-result].",
    ].join("\n");
    const parent = mount(doc);
    const references = parent.querySelectorAll<HTMLElement>(
      `.${CSS.fencedDivReference}`,
    );

    expect([...references].map((reference) => reference.textContent))
      .toEqual(["Theorem 1", "Theorem 1"]);
    expect([...references].map((reference) => reference.dataset.referenceId))
      .toEqual(["main-result", "main-result"]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("keeps the rendered header while editing the body and reveals opener source on click", () => {
    const doc = [
      "Before",
      "",
      '::: {.thm #result title="Main result"}',
      "Body.",
      ":::",
    ].join("\n");
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");

    editor.dispatch({ selection: { anchor: doc.indexOf("Body") + 2 } });
    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)?.textContent)
      .toBe("Theorem 1 (Main result)");

    const header = parent.querySelector<HTMLElement>(`.${CSS.fencedDivHeader}`);
    header?.querySelector("span")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));

    expect(editor.state.selection.main.head).toBe(doc.indexOf(":::"));
    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)).toBeNull();
    expect(parent.querySelector(`.${CSS.fencedDivSource}`)?.textContent)
      .toBe('::: {.thm #result title="Main result"}');
    expect(editor.state.doc.toString()).toBe(doc);
  });

  it("renders inline math in fenced-div titles with document macros", () => {
    const doc = [
      "---",
      "math:",
      '  R: "\\\\mathbb{R}"',
      "---",
      "",
      '::: {.thm title="Maps $f\\colon X \\to \\R$ and \\(g\\)"}',
      "Body.",
      ":::",
    ].join("\n");
    const parent = mount(doc);
    const header = parent.querySelector<HTMLElement>(`.${CSS.fencedDivHeader}`);

    expect(header?.textContent).toContain("Theorem 1 (Maps ");
    expect(header?.textContent).not.toContain("$");
    expect(header?.querySelectorAll(".katex")).toHaveLength(2);
    expect(header?.querySelector(`.${CSS.mathError}`)).toBeNull();
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it.each([
    ["*italic*", `.${CSS.italic}`, "italic"],
    ["**bold**", `.${CSS.bold}`, "bold"],
    ["~~deleted~~", `.${CSS.strikethrough}`, "deleted"],
    ["`code $x$ [@missing]`", `.${CSS.inlineCode}`, "code $x$ [@missing]"],
    ["[link](https://example.org)", `.${CSS.linkRendered}`, "link"],
    ["x^2^", ".cf-cst-superscript", "2"],
    ["H~2~O", ".cf-cst-subscript", "2"],
    ["**bold _italic_**", `.${CSS.bold} .${CSS.italic}`, "italic"],
  ])("renders title inline syntax %s from the CST", (title, selector, text) => {
    const doc = `Before.\n\n::: {.theorem title="中文 😀 ${title}"}\nBody.\n:::`;
    const parent = mount(doc);
    expect(parent.querySelector(`.${CSS.fencedDivHeader} ${selector}`)?.textContent).toBe(text);
    expect(editor?.state.doc.toString()).toBe(doc);
    expect(editor && getPandocTree(editor.state).text).toBe(doc);
  });

  it("renders local references in titles and reveals the entire opener for editing", () => {
    const opener = '::: {.lemma title="From *[@thm:main]* and @thm:main"}';
    const doc = `Before.\n\n::: {.theorem #thm:main}\nFirst.\n:::\n\n${opener}\nBody.\n:::`;
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    const header = parent.querySelectorAll(`.${CSS.fencedDivHeader}`)[1];
    expect(header?.textContent).toBe("Lemma 2 (From Theorem 1 and Theorem 1)");
    expect(header?.querySelectorAll(`.${CSS.fencedDivReference}`)).toHaveLength(2);
    editor.dispatch({ selection: { anchor: doc.indexOf("From") } });
    expect(parent.querySelector(`.${CSS.fencedDivSource}`)?.textContent).toBe(opener);
    expect(parent.querySelector(`.${CSS.fencedDivReference}`)).toBeNull();
    expect(getPandocTree(editor.state).text).toBe(doc);
  });

  it.each(['"', "'", ""])("preserves %s title boundaries across edits, selection, and undo", (quote) => {
    const doc = `Before 中文 😀.\r\n\r\n::: {.remark title=${quote}*résumé*${quote} other="**hidden**"}\r\nBody.\r\n:::`;
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    const source = editor.state.doc.toString();
    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)?.textContent).toBe("Remark (résumé)");
    const tree = getPandocTree(editor.state);
    const from = source.indexOf("résumé");
    editor.dispatch({ selection: { anchor: from, head: from + "résumé".length } });
    expect(getPandocTree(editor.state)).toBe(tree);
    expect(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)).toBe("résumé");
    editor.dispatch(editor.state.replaceSelection("新标题"));
    editor.dispatch({ selection: { anchor: 0 } });
    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)?.textContent).toBe("Remark (新标题)");
    expect(getPandocTree(editor.state).text).toBe(editor.state.doc.toString());
    expect(undo(editor)).toBe(true);
    editor.dispatch({ selection: { anchor: 0 } });
    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)?.textContent).toBe("Remark (résumé)");
    expect(getPandocTree(editor.state).text).toBe(source);
  });

  it("updates headers and references after an attribute edit", () => {
    const doc = [
      "Before",
      "",
      "::: {.thm #result}",
      "Body.",
      ":::",
      "",
      "See [@result].",
    ].join("\n");
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)?.textContent)
      .toBe("Theorem 1");
    expect(parent.querySelector(`.${CSS.fencedDivReference}`)?.textContent)
      .toBe("Theorem 1");

    const classFrom = doc.indexOf("thm");
    editor.dispatch({ changes: { from: classFrom, to: classFrom + 3, insert: "lem" } });

    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)?.textContent)
      .toBe("Lemma 1");
    expect(parent.querySelector(`.${CSS.fencedDivReference}`)?.textContent)
      .toBe("Lemma 1");
    expect(editor.state.doc.toString()).toContain("{.lem #result}");
  });

  it("renders fenced divs with CRLF source without changing their text", () => {
    const doc = "Before\r\n\r\n::: {.proof title='details'}\r\nBody.\r\n:::\r\n";
    const parent = mount(doc);

    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)?.textContent)
      .toBe("Proof (details)");
    expect(parent.querySelector(`.${CSS.fencedDivSource}`)).toBeNull();
    expect(editor?.state.doc.toString()).toBe(doc.replaceAll("\r\n", "\n"));
  });

  it("reveals only the nested closing fences touched by the selection", () => {
    const doc = "Before\n\n:::: {.theorem}\n中文 😀.\n::: {.proof}\nProof.\n:::\n::::\n\nAfter";
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    const tree = getPandocTree(editor.state);
    for (const anchor of [doc.indexOf("中文"), doc.indexOf("Proof."), doc.length]) {
      editor.dispatch({ selection: { anchor } });
      expect(parent.querySelector(`.${CSS.fencedDivSource}`)).toBeNull();
      expect(getPandocTree(editor.state)).toBe(tree);
      expect(editor.state.selection.main.head).toBe(anchor);
    }
    const innerCloser = doc.indexOf("\n:::\n") + 1;
    const closer = doc.lastIndexOf("::::");
    for (const [anchor, text] of [[innerCloser, ":::"], [closer, "::::"]] as const) {
      editor.dispatch({ selection: { anchor } });
      expect([...parent.querySelectorAll(`.${CSS.fencedDivSource}`)].map((fence) => fence.textContent))
        .toEqual([text]);
      expect(getPandocTree(editor.state)).toBe(tree);
      expect(editor.state.selection.main.head).toBe(anchor);
    }
    editor.dispatch({ selection: { anchor: innerCloser, head: closer + 4 } });
    expect([...parent.querySelectorAll(`.${CSS.fencedDivSource}`)].map((fence) => fence.textContent))
      .toEqual([":::", "::::"]);
    expect(getPandocTree(editor.state)).toBe(tree);
    editor.dispatch({ selection: { anchor: doc.length } });
    editor.dispatch({ changes: { from: closer, to: closer + 4 } });
    expect(parent.querySelector(`.${CSS.fencedDivSource}`)).toBeNull();
    expect(getPandocTree(editor.state).text).toBe(editor.state.doc.toString());
    expect(undo(editor)).toBe(true);
    expect(getPandocTree(editor.state).text).toBe(doc);
  });

  it("keeps punctuation editable beside rendered inline math and references", () => {
    const doc = "Before\n\n中文 😀 $x^2$，and [@thm:a]).\n\n::: {.theorem #thm:a}\nBody.\n:::";
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    const groups = (): Element[] => [...parent.querySelectorAll(`.${CSS.inlineNoBreak}`)];
    expect(groups()).toHaveLength(2);
    expect(groups()[0].querySelector(".cf-math-inline")).not.toBeNull();
    expect(groups()[0].textContent?.endsWith("，")).toBe(true);
    expect(groups()[1].textContent).toBe("Theorem 1).");
    const tree = getPandocTree(editor.state);
    const position = doc.indexOf("x^2");
    editor.dispatch({ selection: { anchor: position } });
    expect(groups()).toHaveLength(1);
    expect(parent.querySelector(`.${CSS.mathSource}`)?.textContent).toBe("x^2");
    expect(editor.state.selection.main.head).toBe(position);
    expect(getPandocTree(editor.state)).toBe(tree);
    const comma = doc.indexOf("，");
    editor.dispatch({ changes: { from: comma, to: comma + 1, insert: ";" } });
    editor.dispatch({ selection: { anchor: 0 } });
    expect(groups()[0].textContent?.endsWith(";")).toBe(true);
    expect(getPandocTree(editor.state).text).toBe(doc.replace("，", ";"));
    expect(undo(editor)).toBe(true);
    expect(getPandocTree(editor.state).text).toBe(doc);
  });

  it.each(["proof", "pf", "prf"])("keeps the %s tombstone while editing its closing fence", (className) => {
    const parent = mount(`Before\r\n\r\n::: {.${className}}\r\n中文 😀.\r\n\r\n:::\r\n\r\nAfter`);
    if (!editor) throw new Error("Editor was not mounted");
    const doc = editor.state.doc.toString();
    const closer = doc.lastIndexOf(":::");
    expect(parent.querySelector(`.${CSS.blockQed}`)?.textContent).toBe("∎");
    expect(parent.querySelector(`.${CSS.blockQed}`)?.closest(".cm-line")?.textContent)
      .toBe("中文 😀.∎");
    const tree = getPandocTree(editor.state);
    editor.dispatch({ selection: { anchor: closer } });
    expect(parent.querySelector(`.${CSS.fencedDivSource}`)?.textContent).toBe(":::");
    expect(parent.querySelectorAll(`.${CSS.blockQed}`)).toHaveLength(1);
    expect(parent.querySelector(`.${CSS.blockQed}`)?.closest(".cm-line")?.textContent)
      .toBe("中文 😀.∎");
    expect(editor.state.selection.main.head).toBe(closer);
    expect(getPandocTree(editor.state)).toBe(tree);
    expect(editor.state.doc.toString()).toBe(doc);

    editor.dispatch({ changes: { from: closer, to: closer + 3, insert: "" } });
    expect(parent.querySelector(`.${CSS.blockQed}`)).toBeNull();
    expect(getPandocTree(editor.state).text).toBe(editor.state.doc.toString());
    editor.dispatch({ changes: { from: closer, insert: ":::" } });
    expect(parent.querySelectorAll(`.${CSS.blockQed}`)).toHaveLength(1);
    expect(getPandocTree(editor.state).text).toBe(doc);
  });

  it.each([
    ["display math", "$$\nx = 1\n$$"],
    ["pipe table", "| A | B |\n| --- | --- |\n| 中文 😀 | 2 |"],
    ["nested equation", "::: {.equation}\n$$\nx = 1\n$$\n:::"],
  ])("keeps the tombstone after terminal %s previews", (_name, body) => {
    const source = `Before\n\n:::: {.proof}\n${body}\n::::\n\nAfter`;
    const parent = mount(source);
    if (!editor) throw new Error("Missing mounted editor");
    const tree = getPandocTree(editor.state);
    const closer = source.lastIndexOf("::::");
    const contentPosition = source.includes("x = 1") ? source.indexOf("x = 1") : source.indexOf("中文");
    for (const anchor of [0, contentPosition, closer, source.length]) {
      editor.dispatch({ selection: { anchor } });
      expect(parent.querySelectorAll(`.${CSS.blockQed}`)).toHaveLength(1);
      expect(parent.querySelector(`.${CSS.blockQed}`)?.textContent).toBe("∎");
      expect(editor.state.selection.main.head).toBe(anchor);
      expect(editor.state.doc.toString()).toBe(source);
      expect(getPandocTree(editor.state)).toBe(tree);
    }
    editor.dispatch({ changes: { from: closer, to: closer + 4, insert: "" } });
    expect(parent.querySelectorAll(`.${CSS.blockQed}`)).toHaveLength(0);
    expect(getPandocTree(editor.state).text).toBe(editor.state.doc.toString());
    editor.dispatch({ changes: { from: closer, insert: "::::" } });
    expect(parent.querySelectorAll(`.${CSS.blockQed}`)).toHaveLength(1);
    expect(getPandocTree(editor.state).text).toBe(source);
  });

  it("shares one counter across the six numbered fenced-div classes", () => {
    const doc = [
      "Before", "",
      "::: {.thm}", "A", ":::", "",
      "::: {.remark}", "B", ":::", "",
      "::: {.fig}", "C", ":::", "",
      "::: {.definition}", "D", ":::", "",
      "::: {.tbl}", "E", ":::", "",
      "::: {.prop}", "F", ":::", "",
      "::: {.cor}", "G", ":::", "",
      "::: {.lem}", "H", ":::",
    ].join("\n");
    const parent = mount(doc);

    expect(
      [...parent.querySelectorAll(`.${CSS.fencedDivHeader}`)].map(
        (header) => header.textContent,
      ),
    ).toEqual([
      "Theorem 1",
      "Remark",
      "Figure 2",
      "Definition",
      "Table 3",
      "Proposition 4",
      "Corollary 5",
      "Lemma 6",
    ]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it.each(["$$x = 1$$", "::: {.eq #eq:first}\n$$x = 1$$\n:::"])(
    "preserves display math rendering across unrelated prose edits: %s",
    (math) => {
      const parent = mount(`Prose.\n\n${math}\n\nAfter.`);
      if (!editor) throw new Error("Editor was not mounted");
      const before = editor.state.field(cstDisplayMathDecorationField).decorations.iter().value;
      const rendered = parent.querySelector(".cf-math-display");
      editor.dispatch({ changes: { from: 0, insert: "中文 😀 " } });
      const after = editor.state.field(cstDisplayMathDecorationField).decorations.iter().value;
      if (!before || !after) throw new Error("Missing math decoration");
      expect(after.eq(before)).toBe(true);
      expect(parent.querySelector(".cf-math-display")).toBe(rendered);
      expect(getPandocTree(editor.state).text).toBe(editor.state.doc.toString());
      parent.querySelector<HTMLElement>(".cf-math-display")?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
      const position = editor.state.selection.main.head;
      const source = editor.state.doc.toString();
      expect(position).toBeGreaterThanOrEqual(source.indexOf("x = 1"));
      expect(position).toBeLessThanOrEqual(source.indexOf("x = 1") + 5);
    },
  );

  it("refreshes equation numbering and IDs when its wrapper changes", () => {
    const parent = mount("Before.\n\n::: {.eq #eq:first}\n$$x = 1$$\n:::");
    if (!editor) throw new Error("Editor was not mounted");
    const source = editor.state.doc.toString();
    editor.dispatch({ changes: { from: source.indexOf("eq:first"), to: source.indexOf("eq:first") + 8, insert: "eq:other" } });
    expect(parent.querySelector(`.${CSS.mathDisplayNumbered}`)?.id).toBe("eq:other");
    const from = editor.state.doc.toString().indexOf(".eq");
    editor.dispatch({ changes: { from, to: from + 3, insert: ".remark" } });
    expect(parent.querySelector(`.${CSS.mathDisplayNumbered}`)).toBeNull();
    expect(getPandocTree(editor.state).text).toBe(editor.state.doc.toString());
  });

  it("numbers only equation-div display math and resolves equation labels", () => {
    const doc = [
      "Before",
      "",
      "$$z = 0$$",
      "",
      "::: {.eq #eq:first}",
      "$$x = 1$$",
      ":::",
      "",
      "See [@eq:first].",
    ].join("\n");
    const parent = mount(doc);
    const displayMath = parent.querySelectorAll<HTMLElement>(
      ".cf-math-display:not(.cf-cst-math-preview)",
    );
    const equations = parent.querySelectorAll<HTMLElement>(
      `.${CSS.mathDisplayNumbered}:not(.cf-cst-math-preview)`,
    );

    expect(displayMath).toHaveLength(2);
    expect(equations).toHaveLength(1);
    expect([...equations].map((equation) => (
      equation.querySelector(`.${CSS.mathDisplayNumber}`)?.textContent
    ))).toEqual(["(1)"]);
    expect(equations[0]?.id).toBe("eq:first");
    expect(displayMath[0]?.classList.contains(CSS.mathDisplayNumbered)).toBe(false);
    expect(parent.querySelector(`.${CSS.fencedDivReference}`)?.textContent)
      .toBe("(1)");
    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)).toBeNull();
    expect(editor?.state.doc.toString()).toBe(doc);
  });
});

describe("CST edit surface tables", () => {
  let editor: ReturnType<typeof createSimpleEditor> | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function mount(doc: string): HTMLElement {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = createSimpleEditor({ parent, doc });
    return parent;
  }

  it("renders pipe tables with semantic rows, alignment, and inline math", () => {
    const doc = [
      "Before",
      "",
      "| Item | Value |",
      "| :--- | ---: |",
      "| **Alpha** | $x^2$ |",
    ].join("\n");
    const parent = mount(doc);
    const rendered = parent.querySelector<HTMLElement>(
      ".cf-cst-table:not(.cf-cst-table-preview)",
    );

    expect(rendered).not.toBeNull();
    expect(rendered?.querySelectorAll("thead th")).toHaveLength(2);
    expect(rendered?.querySelector("thead th")?.textContent).toBe("Item");
    expect(rendered?.querySelector("thead th")?.getAttribute("data-align")).toBe("left");
    expect(rendered?.querySelector("thead th:nth-child(2)")?.getAttribute("data-align"))
      .toBe("right");
    expect(rendered?.querySelector("tbody strong")?.textContent).toBe("Alpha");
    expect(rendered?.querySelector("tbody .katex")).not.toBeNull();
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("reveals source on click and keeps a live rendered preview", () => {
    const doc = [
      "Before",
      "",
      "| Item | Value |",
      "| --- | ---: |",
      "| Alpha | 1 |",
    ].join("\n");
    const parent = mount(doc);
    const cell = parent.querySelector<HTMLElement>(
      ".cf-cst-table:not(.cf-cst-table-preview) tbody td",
    );
    expect(cell).not.toBeNull();

    cell?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(parent.querySelector(".cf-cst-table-preview")).not.toBeNull();
    expect(parent.querySelector(".cf-cst-table:not(.cf-cst-table-preview)")).toBeNull();
    expect(parent.querySelectorAll(`.cm-line.${CSS.tableSource}`)).toHaveLength(3);

    if (!editor) throw new Error("Missing mounted editor");
    const insertAt = editor.state.doc.toString().indexOf("Alpha") + "Alpha".length;
    editor.dispatch({
      changes: { from: insertAt, insert: "X" },
      selection: { anchor: insertAt + 1 },
    });

    expect(editor?.state.doc.toString()).toContain("| AlphaX | 1 |");
    expect(parent.querySelector(".cf-cst-table-preview tbody td")?.textContent)
      .toBe("AlphaX");

    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toContain("| Alpha | 1 |");
    expect(parent.querySelector(".cf-cst-table-preview tbody td")?.textContent)
      .toBe("Alpha");

    expect(redo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toContain("| AlphaX | 1 |");
    expect(parent.querySelector(".cf-cst-table-preview tbody td")?.textContent)
      .toBe("AlphaX");
  });

  it.each(["\n", "\r\n"])("keeps all table markup literal while editing with %j line endings", (lineEnding) => {
    const lines = [
      "| **Item** | *Value* |",
      "| --- | --- |",
      "| 😀 **bold** *italic* ~~strike~~ H~2~ x^2^ | `code` $x^2$ \\(y\\) |",
      "| [link](https://example.com) ![image](image.png) | [@thm:main] <br> &amp; |",
    ];
    const doc = ["Before", "", ...lines, "", "::: {.theorem #thm:main}", "Result.", ":::"].join(lineEnding);
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    const source = editor.state.doc.toString();
    const tree = getPandocTree(editor.state);
    parent.querySelector<HTMLElement>(".cf-cst-table tbody td")?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    expect(editor.state.selection.main.head).toBe(source.indexOf("😀"));

    for (const anchor of [source.indexOf("😀"), source.indexOf("bold"), source.indexOf("$x^2$") + 1]) {
      editor.dispatch({ selection: { anchor } });
      const sourceLines = [...parent.querySelectorAll(`.cm-line.${CSS.tableSource}`)];
      expect(sourceLines.map((line) => line.textContent)).toEqual(lines);
      expect(sourceLines.every((line) => (
        line.querySelectorAll(`*:not(span.${CSS.sourceToken})`).length === 0
      ))).toBe(true);
      expect(parent.querySelector(".cf-cst-table-preview strong")?.textContent).toBe("Item");
      expect(parent.querySelectorAll(".cf-cst-table-preview .katex")).toHaveLength(2);
      expect(editor.state.doc.toString()).toBe(source);
      expect(getPandocTree(editor.state)).toBe(tree);
    }
  });

  it("does not split pipes inside escapes, code spans, or math", () => {
    const parent = mount([
      "Before",
      "",
      "| Name | Code | Dollar | Backslash | Literal |",
      "| --- | --- | --- | --- | --- |",
      "| Row | `a|b` | $O(|E|)$ | \\(a|b\\) | a\\|b |",
      "| Next || 2 || tail |",
    ].join("\n"));
    const cells = parent.querySelectorAll(
      ".cf-cst-table:not(.cf-cst-table-preview) tbody tr:first-child td",
    );
    const emptyRow = parent.querySelectorAll(
      ".cf-cst-table:not(.cf-cst-table-preview) tbody tr:nth-child(2) td",
    );

    expect(cells).toHaveLength(5);
    expect(cells[0]?.textContent).toBe("Row");
    expect(cells[1]?.textContent).toBe("a|b");
    expect(cells[2]?.querySelector(".katex")).not.toBeNull();
    expect(cells[3]?.querySelector(".katex")).not.toBeNull();
    expect(cells[4]?.textContent).toBe("a|b");
    expect(emptyRow).toHaveLength(5);
    expect(emptyRow[0]?.textContent).toBe("Next");
    expect(emptyRow[1]?.textContent).toBe("");
    expect(emptyRow[2]?.textContent).toBe("2");
  });

  it("omits an empty table header but retains empty body rows", () => {
    const parent = mount([
      "Before",
      "",
      "||",
      "---|---",
      "||",
      "a|b",
    ].join("\n"));
    const rendered = parent.querySelector<HTMLElement>(
      ".cf-cst-table:not(.cf-cst-table-preview)",
    );
    expect(rendered).not.toBeNull();

    expect(rendered?.querySelector("thead") ?? null).toBeNull();
    expect(rendered?.querySelector("table")?.getAttribute("aria-label")).toBe("Table");
    expect(rendered?.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(rendered?.querySelectorAll("tbody tr:first-child td")).toHaveLength(2);
    expect(rendered?.querySelector("tbody tr:first-child")?.textContent).toBe("");
  });

  it.each(["\n", "\r\n"])("maps every click in a cell to its source start with %j line endings", (lineEnding) => {
    const doc = [
      "Before",
      "",
      "| Item | Value |",
      "| --- | --- |",
      "| 😀 中文 | **value** |",
      "| next ||",
    ].join(lineEnding);
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    const source = editor.state.doc.toString();
    const tree = getPandocTree(editor.state);
    for (const [selector, anchor] of [
      ["tbody tr:first-child td:first-child", source.indexOf("😀")],
      ["tbody strong", source.indexOf("**value**")],
      ["thead th:last-child", source.indexOf("Value")],
      ["tbody tr:last-child td:last-child", source.indexOf("||") + 1],
    ] as const) {
      for (const clientX of [0, 50, 99]) {
        const target = parent.querySelector<HTMLElement>(`.cf-cst-table ${selector}`);
        if (!target) throw new Error("Missing rendered table cell");
        const cell = target.closest("td, th");
        if (!cell) throw new Error("Missing cell container");
        cell.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);
        target.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          clientX,
        }));
        expect(editor.state.selection.main.head).toBe(anchor);
        expect(editor.state.selection.main.empty).toBe(true);
        expect(editor.state.doc.toString()).toBe(source);
        expect(getPandocTree(editor.state)).toBe(tree);
      }
    }
  });

  it("visibly marks inactive block replacements covered by a selection", () => {
    const doc = [
      "Before",
      "",
      "$$x+y$$",
      "",
      "| Item | Value |",
      "| --- | --- |",
      "| Alpha | 1 |",
      "",
      "After",
    ].join("\n");
    const parent = mount(doc);
    editor?.dispatch({ selection: { anchor: 0, head: doc.length } });

    expect(parent.querySelector(
      ".cf-math-display.cf-selection-range:not(.cf-cst-math-preview)",
    )).not.toBeNull();
    expect(parent.querySelector(
      ".cf-cst-table.cf-selection-range:not(.cf-cst-table-preview)",
    )).not.toBeNull();
  });
});
