import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

const PAIRS: ReadonlyMap<string, string> = new Map([
  ["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"],
  ["*", "*"], ["_", "_"], ["$", "$"], ["`", "`"],
  ["~", "~"], ["^", "^"], ["'", "'"], ['"', '"'],
]);

/** Selection wrapping and ordinary bracket completion, without a language parser. */
export function pairedMarkupExtension(): Extension {
  return [
    // Only asymmetric brackets use CM's auto-closing path. Symmetric Markdown
    // tokens remain literal at a caret so **, $$, and code-fence triggers work.
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{", "<"] } }]),
    closeBrackets(),
    EditorView.inputHandler.of((view, from, to, text) => {
      const { state } = view;
      const main = state.selection.main;
      const close = PAIRS.get(text);
      if (!close || state.readOnly || view.compositionStarted
        || from !== main.from || to !== main.to
        || state.selection.ranges.every((range) => range.empty)) return false;

      // CM handles ordinary bracket wrapping above. This also preserves mixed
      // selections if a caret inside a word prevents CM from pairing brackets.
      view.dispatch(state.changeByRange((range) => range.empty ? {
        changes: { from: range.from, insert: text },
        range: EditorSelection.cursor(range.head + text.length),
      } : {
        changes: [{ from: range.from, insert: text }, { from: range.to, insert: close }],
        range: EditorSelection.range(range.anchor + text.length, range.head + text.length),
      }), { scrollIntoView: true, userEvent: "input.type" });
      return true;
    }),
    keymap.of(closeBracketsKeymap),
  ];
}
