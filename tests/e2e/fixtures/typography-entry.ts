import "katex/dist/katex.min.css";
import "../../../src/editor/editor-theme.css";
import "../../../src/themes/blueprint-book.css";
import { mountEditor } from "../../../editor";
import { requiredHTMLElement } from "./utils";

const editor = mountEditor({
  parent: requiredHTMLElement("editor-root"),
  doc: [
    "Body text",
    "",
    "# Heading 1",
    "",
    "## Heading 2",
    "",
    "### Heading 3",
    "",
    "#### Heading 4",
    "",
    "##### Heading 5",
    "",
    "###### Heading 6",
  ].join("\n"),
});

(window as unknown as { __coflatTypographyEditor: typeof editor })
  .__coflatTypographyEditor = editor;
