import { EditorState, Text } from "@codemirror/state";
import { PandocParser, type SyntaxNode } from "pandocmd-cst";
import { describe, expect, it, vi } from "vitest";
import {
  getPandocCursorContext,
  pandocCursorContextField,
  resolvePandocCursorContext,
  resolvePandocNode,
} from "./cursor-context";
import { getPandocTree, pandocCstField } from "./pandoc-cst-field";

describe("Pandoc cursor context", () => {
  it.each([
    "",
    "😀 e\u0301\r\n\r\nNext *strong **nested** text*.\r\n",
    "# Heading\n\n::: {.theorem #thm:main}\nA $x$ and [link](doc.md).\n:::\n\nName|Value\n---|---\nx|y\n",
    "- first\n- *second*\n\n> Quoted **text**.\n\n~~~\ncode\n~~~\n",
  ])("matches the CST resolver at every UTF-16 source position", (doc) => {
    const tree = new PandocParser().parse(doc);
    for (let position = 0; position <= doc.length; position += 1) {
      for (const bias of ["left", "right"] as const) {
        expect(resolvePandocNode(tree, position, bias)).toBe(tree.resolve(position, bias));
      }
      const path = [];
      let node: SyntaxNode | null = tree.resolve(position, "right");
      while (node) {
        path.unshift({ kind: node.kind, from: node.from, to: node.to });
        node = node.parent;
      }
      expect(resolvePandocCursorContext(tree, position)).toMatchObject({
        cstVersion: tree.version,
        position,
        path,
      });
    }
  });

  it("reads only the indexed block near the end of a large document", () => {
    const doc = "Ordinary prose.\n\n".repeat(2_000) + "Final *word*.\n";
    const tree = new PandocParser().parse(doc);
    const allChildren = vi.spyOn(tree.root, "children");
    const indexedChild = vi.spyOn(tree.root, "child");
    const position = doc.indexOf("word");

    const context = resolvePandocCursorContext(tree, position);

    expect(context.inline?.kind).toBe("Emphasis");
    expect(context.block?.kind).toBe("Paragraph");
    expect(context.path.at(-1)).toMatchObject({ kind: "Text", from: position });
    expect(allChildren).not.toHaveBeenCalled();
    expect(indexedChild).toHaveBeenCalledTimes(1);
  });

  it("reuses context when only the selection anchor changes", () => {
    const state = EditorState.create({
      doc: Text.of(["😀 e\u0301\r", "*text*\r", ""]),
      selection: { anchor: 11 },
      extensions: [pandocCstField, pandocCursorContextField],
    });
    const context = getPandocCursorContext(state);
    const selected = state.update({ selection: { anchor: 2, head: 11 } }).state;
    expect(getPandocCursorContext(selected)).toBe(context);
    expect(getPandocTree(selected)).toBe(getPandocTree(state));

    const edited = selected.update({ changes: { from: 10, insert: "字" } }).state;
    const nextContext = getPandocCursorContext(edited);
    expect(nextContext).not.toBe(context);
    expect(nextContext.position).toBe(12);
    expect(nextContext.cstVersion).toBe(getPandocTree(edited).version);
    expect(getPandocTree(edited).text).toBe(edited.doc.toString());
  });

  it("clamps out-of-document positions and rejects fractional offsets", () => {
    const tree = new PandocParser().parse("text");
    expect(resolvePandocCursorContext(tree, -1).position).toBe(0);
    expect(resolvePandocCursorContext(tree, 20).position).toBe(tree.length);
    expect(() => resolvePandocCursorContext(tree, 0.5)).toThrow(RangeError);
    expect(() => resolvePandocCursorContext(tree, Number.NaN)).toThrow(RangeError);
    expect(() => resolvePandocNode(tree, -1)).toThrow(RangeError);
    expect(() => resolvePandocNode(tree, tree.length + 1)).toThrow(RangeError);
  });
});
