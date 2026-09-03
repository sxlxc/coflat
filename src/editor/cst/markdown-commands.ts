import { EditorSelection } from "@codemirror/state";
import type { Command } from "@codemirror/view";

function continuedPrefix(lineBeforeCursor: string): string | null {
  const list = /^(\s*)([-+*]|\d+[.)])(\s+)(?:\[([ xX])\](\s+))?/.exec(lineBeforeCursor);
  if (list) {
    const body = lineBeforeCursor.slice(list[0].length);
    if (!body.trim()) return null;
    let marker = list[2] ?? "";
    const ordered = /^(\d+)([.)])$/.exec(marker);
    if (ordered) marker = `${Number.parseInt(ordered[1] ?? "0", 10) + 1}${ordered[2]}`;
    return `${list[1]}${marker}${list[3]}${list[4] === undefined ? "" : `[ ]${list[5]}`}`;
  }

  const quote = /^(\s*(?:>\s*)+)(\S.*)$/.exec(lineBeforeCursor);
  return quote?.[1] ?? null;
}

/** Continue list/quote markup without consulting CodeMirror's Markdown parser. */
export const insertNewlineContinuePandocMarkup: Command = (view) => {
  let handled = false;
  const transaction = view.state.changeByRange((range) => {
    if (!range.empty) return { range };
    const line = view.state.doc.lineAt(range.head);
    const prefix = continuedPrefix(view.state.sliceDoc(line.from, range.head));
    if (prefix === null) return { range };
    handled = true;
    const insert = `\n${prefix}`;
    return {
      changes: { from: range.head, insert },
      range: EditorSelection.cursor(range.head + insert.length),
    };
  });
  if (!handled) return false;
  view.dispatch(transaction);
  return true;
};
