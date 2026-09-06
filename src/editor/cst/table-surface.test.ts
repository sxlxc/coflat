import { EditorSelection, EditorState, RangeSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import fc from "fast-check";
import type { SyntaxTree } from "pandocmd-cst";
import { afterEach, describe, expect, it, vi } from "vitest";
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
