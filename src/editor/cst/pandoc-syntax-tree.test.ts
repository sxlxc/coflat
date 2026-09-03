import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  ensurePandocSyntaxTree,
  getPandocSyntaxTree,
  pandocCstField,
  pandocSyntaxTreeAvailable,
  parsePandocCstSource,
} from ".";

describe("CST-derived traversal tree", () => {
  it("projects the legacy traversal names without invoking another Markdown parser", () => {
    const tree = parsePandocCstSource([
      "# Heading",
      "",
      "::: {.note #example}",
      "- [x] **done**",
      ":::",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      "left | right",
      "--- | ---",
      "a | b",
      "",
    ].join("\n"));

    expect(tree.toString()).toContain("ATXHeading1(HeaderMark)");
    expect(tree.toString()).toContain("FencedDiv(FencedDivFence,FencedDivAttributes");
    expect(tree.toString()).toContain("Task(TaskMarker");
    expect(tree.toString()).toContain("StrongEmphasis");
    expect(tree.toString()).toContain("FencedCode(CodeMark,CodeInfo,CodeText,CodeMark)");
    expect(tree.toString()).toContain("Table(TableHeader");
  });

  it("is complete and version-synchronous in an editor state", () => {
    const state = EditorState.create({
      doc: "[manual]\n\n[manual]: guide.pdf\n",
      extensions: pandocCstField,
    });
    const tree = getPandocSyntaxTree(state);

    expect(tree.length).toBe(state.doc.length);
    expect(tree.toString()).toContain("Link");
    expect(pandocSyntaxTreeAvailable(state, state.doc.length)).toBe(true);
    expect(ensurePandocSyntaxTree(state, state.doc.length, 1)).toBe(tree);
  });
});
