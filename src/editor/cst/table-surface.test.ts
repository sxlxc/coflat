import { redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, RangeSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import fc from "fast-check";
import type { SyntaxTree } from "pandocmd-cst";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSS } from "../../core/constants/css-classes";
import { createSimpleEditor } from "../simple-editor";
import { getPandocTree, pandocCstField } from "./pandoc-cst-field";
import { cstTableDecorationField, cstTableSurface } from "./table-surface";
import { cstYamlMetadataField } from "./yaml-metadata";

function tableState(
  doc: string,
  selection = EditorSelection.single(0),
  cstState?: EditorState,
): EditorState {
  return EditorState.create({
    doc,
    selection,
    extensions: [
      cstState ? pandocCstField.init(() => cstState.field(pandocCstField)) : pandocCstField,
      cstYamlMetadataField,
      cstTableSurface,
      EditorState.allowMultipleSelections.of(true),
    ],
  });
}

function tableDecorations(state: EditorState, view: EditorView): unknown[] {
  const decorations: unknown[] = [];
  const cursor = state.field(cstTableDecorationField).decorations.iter();
  for (; cursor.value; cursor.next()) {
    const element = cursor.value.spec.widget?.toDOM(view);
    if (element) {
      // Mapped widgets resolve their current coordinates from the live CST.
      for (const node of [element, ...element.querySelectorAll("[data-source-from]")]) {
        node.removeAttribute("data-source-from");
        node.removeAttribute("data-source-to");
        node.removeAttribute("data-cst-version");
      }
    }
    decorations.push({
      from: cursor.from,
      to: cursor.to,
      attributes: cursor.value.spec.attributes,
      html: element?.outerHTML,
    });
  }
  return decorations;
}

describe("incremental table decorations", () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
    vi.restoreAllMocks();
  });

  it("handles mapped selections that enclose a host replacement", () => {
    const before = tableState("abcdef", EditorSelection.single(4, 2));
    const after = before.update({ changes: { from: 1, to: 5, insert: "\n\nA|B\n---|---\nx|y\n\n" } }).state;
    const rebuilt = tableState(
      after.doc.toString(),
      EditorSelection.single(after.selection.main.anchor, after.selection.main.head),
      after,
    );
    expect(RangeSet.eq(
      [after.field(cstTableDecorationField).decorations],
      [rebuilt.field(cstTableDecorationField).decorations],
    )).toBe(true);
    expect(getPandocTree(after).text).toBe("a\n\nA|B\n---|---\nx|y\n\nf");
  });

  it("bounds CST visits during table typing and source transitions", () => {
    const doc = `${"Ordinary *prose*.\n\n".repeat(1_000)}Name|Value\n---|---\nrow|1\n\nTail.`;
    const position = doc.indexOf("row|1");
    let state = tableState(doc, EditorSelection.single(position));
    const prototype: Pick<SyntaxTree, "iterate"> = Object.getPrototypeOf(getPandocTree(state));
    const iterate = prototype.iterate;
    let visited = 0;
    vi.spyOn(prototype, "iterate").mockImplementation(function (this: SyntaxTree, visitor, range) {
      iterate.call(this, {
        enter(node) {
          visited += 1;
          return typeof visitor === "function" ? visitor(node) : visitor.enter?.(node);
        },
        ...(typeof visitor !== "function" ? { leave: visitor.leave } : {}),
      }, range);
    });
    state = state.update({ changes: { from: position, to: position + 1, insert: "R" } }).state;
    expect(visited).toBeLessThan(200);
    visited = 0;
    state = state.update({ selection: { anchor: doc.length } }).state;
    expect(visited).toBeLessThan(150);
    visited = 0;
    state = state.update({ selection: { anchor: position } }).state;
    expect(visited).toBeLessThan(150);
    expect(getPandocTree(state).text).toBe(state.doc.toString());
  });

  it("matches fresh decorations across edits, splits, indentation, and multiple selections", () => {
    const doc = "中文 😀 Prose.\n\n  A|B\n  ---|---\n  x|y\n\n::: {.theorem #thm:a}\nC|D\n---|---\nx|y\n:::\n\nE|F\n---|---\nx|y\n\nTail.";
    view = new EditorView({ state: tableState(doc) });
    const renderingView = view;
    fc.assert(fc.property(
      fc.integer({ min: 0, max: doc.length }),
      fc.integer({ min: 0, max: doc.length }),
      fc.constantFrom("", "😀", "\n", "\n\n", "|", "---", "  "),
      (left, right, insert) => {
        const from = Math.min(left, right);
        const to = Math.max(left, right);
        const state = tableState(doc, EditorSelection.create([
          EditorSelection.cursor(doc.indexOf("x|y")),
          EditorSelection.range(doc.indexOf("E|F"), doc.length),
        ]));
        const edited = state.update({ changes: { from, to, insert } }).state;
        expect(tableDecorations(edited, renderingView)).toEqual(tableDecorations(
          tableState(edited.doc.toString(), edited.selection, edited),
          renderingView,
        ));
        const selected = edited.update({ selection: EditorSelection.single(0, edited.doc.length) }).state;
        expect(tableDecorations(selected, renderingView)).toEqual(tableDecorations(
          tableState(selected.doc.toString(), selected.selection, selected),
          renderingView,
        ));
      },
    ), { numRuns: 100, seed: 7031 });
  });

  it("resolves a mapped table cell from the current Unicode source", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({ parent, state: tableState("Prose.\n\nA|B\n---|---\nx|y\n\nTail.") });
    const cell = view.dom.querySelector<HTMLElement>("td:last-child");
    expect(cell?.textContent).toBe("y");
    view.dispatch({ changes: { from: 0, insert: "中文 😀 " } });
    expect(view.dom.querySelector("td:last-child")).toBe(cell);
    cell?.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf("y\n"));
    expect(view.dom.querySelector(".cf-cst-table-preview")).not.toBeNull();
    expect(getPandocTree(view.state).text).toBe(view.state.doc.toString());
    parent.remove();
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

  it("renders semantic pipe tables and keeps their preview current through editing and undo", () => {
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

    const cell = rendered?.querySelector<HTMLElement>("tbody td");
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

    expect(editor.state.doc.toString()).toBe(doc.replace("Alpha", "AlphaX"));
    expect(parent.querySelector(".cf-cst-table-preview tbody td")?.textContent)
      .toBe("AlphaX");

    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(doc);
    expect(parent.querySelector(".cf-cst-table-preview tbody td")?.textContent)
      .toBe("Alpha");

    expect(redo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(doc.replace("Alpha", "AlphaX"));
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
});
