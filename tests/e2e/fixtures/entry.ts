import { EditorView } from "@codemirror/view";
import "katex/dist/katex.min.css";
import "../../../src/editor/editor-theme.css";
import { mountEditor, type MountedEditor, type MountEditorOptions } from "../../../editor";
import { requiredHTMLElement } from "./utils";

export interface EditorFixtureWindow {
  __coflatEditor: MountedEditor;
  __coflatEditorView: EditorView;
  __coflatRemount(options: Pick<MountEditorOptions, "doc" | "editingAssistance">): void;
}

const root = requiredHTMLElement("editor-root");
const bibliography = `
@article{smith2024,
  author = {Smith, Alice},
  title = {A Useful Result},
  journal = {Journal of Examples},
  year = {2024}
}
`;

const longCitationStyle = `
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text">
  <info>
    <title>Long citation fixture</title>
    <id>https://example.com/long-citation</id>
    <updated>2026-01-01T00:00:00+00:00</updated>
  </info>
  <citation>
    <layout prefix="(" suffix=")">
      <text variable="title" prefix="See the detailed discussion in the collected research notes on "/>
    </layout>
  </citation>
</style>
`;

const initialDoc = [
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
].join("\n");

const fixtureWindow = window as unknown as EditorFixtureWindow;
let mounted: MountedEditor | null = null;
fixtureWindow.__coflatRemount = (options): void => {
  mounted?.unmount();
  mounted = mountEditor({
    parent: root,
    readTextResource: async (path) => {
      if (path === "references.bib") return bibliography;
      if (path === "long-citation.csl") return longCitationStyle;
      throw new Error(`Unexpected fixture resource: ${path}`);
    },
    ...options,
  });
  const editorView = EditorView.findFromDOM(root.querySelector(".cm-editor") ?? root);
  if (!editorView) throw new Error("Missing mounted fixture editor view");
  fixtureWindow.__coflatEditor = mounted;
  fixtureWindow.__coflatEditorView = editorView;
};
fixtureWindow.__coflatRemount({ doc: initialDoc });
