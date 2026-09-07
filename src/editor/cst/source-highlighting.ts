import { getIndentUnit, type StreamParser, StringStream } from "@codemirror/language";
import { c, cpp } from "@codemirror/legacy-modes/mode/clike";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { javascript, json, typescript } from "@codemirror/legacy-modes/mode/javascript";
import { python } from "@codemirror/legacy-modes/mode/python";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { stex, stexMath } from "@codemirror/legacy-modes/mode/stex";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import type { EditorState } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { CSS } from "../../core/constants/css-classes";

type SourceMarks = Array<ReturnType<Decoration["range"]>>;

const SOURCE_LANGUAGES: ReadonlyMap<string, StreamParser<unknown>> = new Map([
  ["javascript", javascript], ["js", javascript],
  ["typescript", typescript], ["ts", typescript],
  ["json", json],
  ["python", python], ["py", python],
  ["bash", shell], ["sh", shell], ["shell", shell],
  ["c", c], ["cpp", cpp], ["c++", cpp],
  ["haskell", haskell], ["hs", haskell],
  ["yaml", yaml], ["yml", yaml],
  ["tex", stex], ["latex", stex],
  ["math", stexMath],
]);

const TOKEN_CLASSES: Readonly<Record<string, string>> = {
  atom: "tok-atom",
  bracket: "tok-punctuation",
  builtin: "tok-keyword",
  comment: "tok-comment",
  def: "tok-punctuation",
  integer: "tok-number",
  keyword: "tok-keyword",
  meta: "tok-punctuation",
  number: "tok-number",
  operator: "tok-punctuation",
  property: "tok-atom",
  string: "tok-string",
  tag: "tok-keyword",
  type: "tok-keyword",
  variable: "tok-meta",
  variableName: "tok-meta",
};

/** Color literal source without applying rendered inline typography. */
export function addSourceToken(
  ranges: SourceMarks,
  from: number,
  to: number,
  className: string,
): void {
  if (from < to) ranges.push(Decoration.mark({
    class: `${CSS.sourceToken} ${className}`,
  }).range(from, to));
}

/** The caller supplies CST boundaries; tokenizers only produce color spans. */
export function addOpaqueSourceHighlights(
  ranges: SourceMarks,
  state: EditorState,
  from: number,
  to: number,
  language: string,
  visibleFrom = from,
): void {
  const tokenizer = SOURCE_LANGUAGES.get(language.trim().toLowerCase());
  if (!tokenizer) return;
  const indentUnit = getIndentUnit(state);
  const tokenState = tokenizer.startState?.(indentUnit);
  for (let position = from; position < to;) {
    const line = state.doc.lineAt(position);
    const end = Math.min(line.to, to);
    const stream = new StringStream(state.sliceDoc(position, end), state.tabSize, indentUnit);
    // stex's blankLine hook exits math mode. CST math boundaries remain
    // authoritative even when the body starts with a newline or has blank rows.
    if (stream.eol() && tokenizer !== stexMath) tokenizer.blankLine?.(tokenState, indentUnit);
    while (!stream.eol()) {
      stream.start = stream.pos;
      let token = tokenizer.token(stream, tokenState);
      // Stream parsers may change state before consuming their next token.
      for (let retries = 0; stream.pos === stream.start && retries < 9; retries += 1) {
        token = tokenizer.token(stream, tokenState);
      }
      if (stream.pos <= stream.start) throw new Error("Source tokenizer did not advance");
      const className = token?.split(" ").map((name) => (
        TOKEN_CLASSES[name] ?? TOKEN_CLASSES[name.split(".")[0]]
      )).filter(Boolean).join(" ");
      if (className && position + stream.pos > visibleFrom) addSourceToken(
        ranges,
        Math.max(position + stream.start, visibleFrom),
        position + stream.pos,
        className,
      );
    }
    position = line.to + 1;
  }
}
