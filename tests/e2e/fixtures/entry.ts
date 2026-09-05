import { EditorView } from "@codemirror/view";
import "katex/dist/katex.min.css";
import "../../../src/editor/editor-theme.css";
import { mountEditor } from "../../../editor";
import { requiredHTMLElement } from "./utils";

const root = requiredHTMLElement("editor-root");
const bibliography = `
@article{smith2024,
  author = {Smith, Alice},
  title = {A Useful Result},
  journal = {Journal of Examples},
  year = {2024}
}
`;

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
    "",
    "| Item | Value |",
    "| :--- | ---: |",
    "| **Alpha** | 1 |",
    "| Beta | 2 |",
  ].join("\n"),
  readTextResource: async (path) => {
    if (path === "references.bib") return bibliography;
    throw new Error(`Unexpected fixture resource: ${path}`);
  },
});

// Expose for assertions if needed by future specs.
(window as unknown as { __coflatEditor: typeof mounted }).__coflatEditor = mounted;
const editorView = EditorView.findFromDOM(root.querySelector(".cm-editor") ?? root);
(window as unknown as { __coflatEditorView: EditorView | null }).__coflatEditorView = editorView;
