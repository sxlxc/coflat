import { EditorView } from "@codemirror/view";
import "../../../src/editor/editor-theme.css";
import { mountEditor } from "../../../editor";
import { requiredHTMLElement } from "./utils";

const root = requiredHTMLElement("editor-root");

const mounted = mountEditor({
  parent: root,
  doc: [
    "Before *emphasis* and $x^2$ after.",
    "",
    "$$",
    "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
    "$$",
    "",
    "```ts",
    "const selected = true;",
    "return selected;",
    "```",
  ].join("\n"),
});

// Expose for assertions if needed by future specs.
(window as unknown as { __coflatEditor: typeof mounted }).__coflatEditor = mounted;
const editorView = EditorView.findFromDOM(root.querySelector(".cm-editor") ?? root);
(window as unknown as { __coflatEditorView: EditorView | null }).__coflatEditorView = editorView;
