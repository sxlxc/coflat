// Keep after-mount plugin dynamic imports from racing environment teardown.
import "../test-plugin-preload";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { markdownExtensions } from "../../core/parser";
import { getPandocTree } from "../cst";
import { createEditor } from "../editor";
import { blockCounterField } from "../state/block-counter";
import { documentAnalysisField } from "../state/document-analysis";
import { programmaticDocumentChangeAnnotation } from "../state/programmatic-document-change";
import { getReferenceRenderDependencySignature } from "../state/reference-render-state";
import { createTestView } from "../test-utils";
import { _blockquoteFieldForTest, blockquoteRenderPlugin } from "./blockquote-render";
import { focusEffect } from "./focus-state";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
});

function createBlockquoteView(doc: string, cursorPos: number): EditorView {
  view = createTestView(doc, {
    cursorPos,
    extensions: [
      markdown({ extensions: markdownExtensions }),
      blockquoteRenderPlugin,
    ],
  });
  view.dispatch({ effects: focusEffect.of(true) });
  return view;
}

describe("blockquoteRenderPlugin", () => {
  it("renders a blockquote away from the caret as a widget", () => {
    const target = createBlockquoteView("> quoted text\n\nbody paragraph", 20);
    expect(target.dom.querySelector("blockquote")).not.toBeNull();
  });

  it("reuses the blockquote widget DOM across an unrelated edit", () => {
    const doc = "> quoted text\n\nbody paragraph";
    const target = createBlockquoteView(doc, doc.length);
    const before = target.dom.querySelector("blockquote");
    expect(before).not.toBeNull();

    // Edit the trailing paragraph, far from the blockquote. Its source slice
    // and the frontmatter config are unchanged, so the widget must compare
    // equal and CM6 must keep the existing DOM (no re-render).
    target.dispatch({
      changes: { from: doc.length, insert: " more" },
    });

    const after = target.dom.querySelector("blockquote");
    expect(after).toBe(before);
  });

  it("re-renders a blockquote crossref when a referenced block number changes", () => {
    // The widget's toDOM resolves `[@thm:two]` to its number via the numbering
    // pipeline — a render input beyond the blockquote's own source. If eq()
    // ignored that, a renumber below the (fixed-range) blockquote would leave a
    // stale number. Baking the render-dependency signature into eq fixes it.
    const parent = document.createElement("div");
    const first = "::: {.theorem #thm:one}\nA.\n:::\n\n";
    const doc = `> See [@thm:two].\n\n${first}::: {.theorem #thm:two}\nB.\n:::\n`;
    const editor = createEditor({ parent, doc });
    const beforeRenderKey = getReferenceRenderDependencySignature(editor.state);
    expect(editor.dom.querySelector("blockquote")?.textContent).toBe("See Theorem 2.");

    // Delete the first block through the programmatic-change path so the
    // interactive fence-protection filter does not preserve its delimiters.
    // The edit is AFTER the blockquote, so its range is unchanged, while the
    // second theorem renumbers 2 → 1 and the blockquote must follow.
    const from = doc.indexOf(first);
    editor.dispatch({
      changes: { from, to: from + first.length, insert: "" },
      annotations: programmaticDocumentChangeAnnotation.of(true),
    });
    expect(editor.state.doc.toString()).toBe(doc.slice(0, from) + doc.slice(from + first.length));
    expect(getPandocTree(editor.state).text).toBe(editor.state.doc.toString());
    expect([...getPandocTree(editor.state).root.children()].filter((node) =>
      node.kind === "FencedDiv"
    )).toHaveLength(1);
    expect(editor.state.field(documentAnalysisField).fencedDivs.map((div) => div.id)).toEqual([
      "thm:two",
    ]);
    expect(editor.state.field(blockCounterField).byId.get("thm:two")?.number).toBe(1);
    expect(getReferenceRenderDependencySignature(editor.state)).not.toBe(beforeRenderKey);
    expect(editor.dom.querySelector("blockquote")?.textContent).toBe("See Theorem 1.");
    editor.destroy();
  });

  it("keeps the field value identical for caret moves outside the blockquote", () => {
    const doc = "> quoted text\n\nbody paragraph";
    const target = createBlockquoteView(doc, doc.length);
    const before = target.state.field(_blockquoteFieldForTest);

    target.dispatch({ selection: { anchor: doc.length - 3 } });

    expect(target.state.field(_blockquoteFieldForTest)).toBe(before);
  });

  it("reveals and re-renders the blockquote as the caret crosses it", () => {
    const doc = "> quoted text\n\nbody paragraph";
    const target = createBlockquoteView(doc, doc.length);
    expect(target.dom.querySelector("blockquote")).not.toBeNull();

    target.dispatch({ selection: { anchor: doc.indexOf("quoted") } });
    expect(target.dom.querySelector("blockquote")).toBeNull();

    target.dispatch({ selection: { anchor: doc.length } });
    expect(target.dom.querySelector("blockquote")).not.toBeNull();
  });

  it("reveals a blockquote touched by any range of a multi-range selection", () => {
    const doc = "> quoted text\n\nbody paragraph";
    view = createTestView(doc, {
      cursorPos: doc.length,
      extensions: [
        markdown({ extensions: markdownExtensions }),
        EditorState.allowMultipleSelections.of(true),
        blockquoteRenderPlugin,
      ],
    });
    view.dispatch({ effects: focusEffect.of(true) });
    expect(view.dom.querySelector("blockquote")).not.toBeNull();

    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(doc.indexOf("quoted")),
        EditorSelection.cursor(doc.length),
      ], 1),
    });
    expect(view.dom.querySelector("blockquote")).toBeNull();
  });
});
