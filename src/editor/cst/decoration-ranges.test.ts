import { EditorState, Text } from "@codemirror/state";
import type { SourceRange } from "pandocmd-cst";
import { describe, expect, it } from "vitest";
import { changedBlockRanges } from "./decoration-ranges";
import { getPandocTree, pandocCstField } from "./pandoc-cst-field";

function covers(ranges: readonly SourceRange[], from: number, to: number): boolean {
  return ranges.some((range) => range.from <= from && to <= range.to);
}

describe("decoration source invalidation", () => {
  it("keeps a local edit bounded between thousands of unchanged paragraphs", () => {
    const prose = "Ordinary *prose* with $x$.\n\n";
    const doc = `${prose.repeat(1_000)}中文 😀 TARGET.\n\n${prose.repeat(1_000)}`;
    const state = EditorState.create({ doc, extensions: pandocCstField });
    const from = doc.indexOf("TARGET");
    const transaction = state.update({ changes: { from, insert: "more " } });
    const { oldRanges, newRanges } = changedBlockRanges(transaction);
    expect(covers(oldRanges, from, from + 6)).toBe(true);
    expect(covers(newRanges, from, from + 11)).toBe(true);
    for (const ranges of [oldRanges, newRanges]) {
      expect(ranges.reduce((length, range) => length + range.to - range.from, 0))
        .toBeLessThan(150);
    }
    expect(getPandocTree(transaction.state).text).toBe(transaction.newDoc.toString());
  });

  it("removes distant previews absorbed by a newly opened code block", () => {
    const doc = "Lead.\n\nA|B\n---|---\nx|y\n\n$$x=1$$\n\nTail.\n```";
    const state = EditorState.create({ doc, extensions: pandocCstField });
    const transaction = state.update({ changes: { from: 0, insert: "```\n\n" } });
    expect(getPandocTree(transaction.state).root.firstChild()?.kind).toBe("FencedCodeBlock");
    const ranges = changedBlockRanges(transaction);
    expect(covers(ranges.oldRanges, 0, doc.length)).toBe(true);
    expect(covers(ranges.newRanges, 0, transaction.newDoc.length)).toBe(true);
  });

  it("recollects every block exposed by deleting a code opener", () => {
    const doc = "```\nA|B\n---|---\nx|y\n\n$$x=1$$\n\nTail.\n```";
    const state = EditorState.create({ doc, extensions: pandocCstField });
    const transaction = state.update({ changes: { from: 0, to: 4 } });
    const ranges = changedBlockRanges(transaction);
    expect(covers(ranges.oldRanges, 0, doc.length)).toBe(true);
    expect(covers(ranges.newRanges, 0, transaction.newDoc.length)).toBe(true);
    expect(getPandocTree(transaction.state).text).toBe(doc.slice(4));
  });

  it("handles CRLF, UTF-16 offsets, and deletion of the entire source", () => {
    const doc = "中文 😀\r\n\r\n$$x$$\r\n\r\nTail.";
    const state = EditorState.create({
      doc: Text.of(doc.split("\n")),
      extensions: pandocCstField,
    });
    const from = doc.indexOf("x");
    const edit = state.update({ changes: { from, insert: "字" } });
    const ranges = changedBlockRanges(edit);
    expect(covers(ranges.oldRanges, from, from + 1)).toBe(true);
    expect(covers(ranges.newRanges, from, from + 2)).toBe(true);
    expect(getPandocTree(edit.state).text).toBe(edit.newDoc.toString());
    const deletion = edit.state.update({ changes: { from: 0, to: edit.newDoc.length } });
    expect(covers(changedBlockRanges(deletion).oldRanges, 0, edit.newDoc.length)).toBe(true);
    expect(getPandocTree(deletion.state).length).toBe(0);
    expect(changedBlockRanges(state.update({ selection: { anchor: from } })))
      .toEqual({ oldRanges: [], newRanges: [] });
  });
});
