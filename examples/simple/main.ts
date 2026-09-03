import "katex/dist/katex.min.css";
import "../../src/editor/editor-theme.css";
import { mountEditor } from "../../editor";
import formatDoc from "../../FORMAT.md?raw";
import showcaseDoc from "./showcase.md?raw";
import "./style.css";

const editorRoot = document.querySelector<HTMLElement>("#editor");
if (!editorRoot) throw new Error("Missing #editor root");

const documents = {
  showcase: showcaseDoc,
  format: formatDoc,
} as const;
type DocumentId = keyof typeof documents;

const editor = mountEditor({
  parent: editorRoot,
  doc: documents.showcase,
});

function isDocumentId(value: string | undefined): value is DocumentId {
  return value === "showcase" || value === "format";
}

for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-doc-id]")) {
  link.addEventListener("click", (event) => {
    const id = link.dataset.docId;
    if (!isDocumentId(id)) return;
    event.preventDefault();
    editor.setDoc(documents[id]);
    for (const candidate of document.querySelectorAll<HTMLElement>("[data-doc-id]")) {
      candidate.toggleAttribute("aria-current", candidate.dataset.docId === id);
    }
    history.replaceState(null, "", `?doc=${id}`);
    editor.focus();
  });
}

const requested = new URLSearchParams(location.search).get("doc") ?? undefined;
if (isDocumentId(requested)) {
  editor.setDoc(documents[requested]);
  for (const candidate of document.querySelectorAll<HTMLElement>("[data-doc-id]")) {
    candidate.toggleAttribute("aria-current", candidate.dataset.docId === requested);
  }
}

editor.focus();
