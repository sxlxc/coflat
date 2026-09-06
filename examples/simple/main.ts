import "katex/dist/katex.min.css";
import "../../src/editor/editor-theme.css";
import { mountEditor } from "../../editor";
import formatDoc from "../../FORMAT.md?raw";
import exampleDoc from "./example.md?raw";
import referenceBibliography from "./ref.bib?raw";
import showcaseDoc from "./showcase.md?raw";
import "./style.css";

const editorRoot = document.querySelector<HTMLElement>("#editor");
if (!editorRoot) throw new Error("Missing #editor root");
const viewSourceButton = document.querySelector<HTMLButtonElement>("#view-source");
if (!viewSourceButton) throw new Error("Missing #view-source button");
const sourceDialog = document.querySelector<HTMLDialogElement>("#source-dialog");
if (!sourceDialog) throw new Error("Missing #source-dialog");
const documentSource = document.querySelector<HTMLElement>("#document-source");
if (!documentSource) throw new Error("Missing #document-source");

const documents = {
  showcase: showcaseDoc,
  format: formatDoc,
  example: exampleDoc,
} as const;
type DocumentId = keyof typeof documents;

function isDocumentId(value: string | undefined): value is DocumentId {
  return value === "showcase" || value === "format" || value === "example";
}

const drafts: Record<DocumentId, string> = { ...documents };
const requested = new URLSearchParams(location.search).get("doc") ?? undefined;
let activeDocument: DocumentId = isDocumentId(requested) ? requested : "showcase";

const mountDocument = (id: DocumentId): ReturnType<typeof mountEditor> => mountEditor({
  parent: editorRoot,
  doc: drafts[id],
  readTextResource: async (path) => {
    if (path === "ref.bib") return referenceBibliography;
    throw new Error(`Unknown example resource: ${path}`);
  },
});

let editor = mountDocument(activeDocument);

viewSourceButton.addEventListener("click", () => {
  documentSource.textContent = editor.getDoc();
  sourceDialog.showModal();
});

for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-doc-id]")) {
  link.toggleAttribute("aria-current", link.dataset.docId === activeDocument);
  link.addEventListener("click", (event) => {
    const id = link.dataset.docId;
    if (!isDocumentId(id)) return;
    event.preventDefault();
    if (id !== activeDocument) {
      drafts[activeDocument] = editor.getDoc();
      // File navigation starts a new undo history while retaining each draft.
      editor.unmount();
      activeDocument = id;
      editor = mountDocument(id);
    }
    for (const candidate of document.querySelectorAll<HTMLElement>("[data-doc-id]")) {
      candidate.toggleAttribute("aria-current", candidate.dataset.docId === id);
    }
    history.replaceState(null, "", `?doc=${id}`);
    editor.focus();
  });
}

editor.focus();
