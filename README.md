# @chaoxu/coflat

Coflat is a keyboard-first WYSIWYG editor for Pandoc Markdown. CodeMirror 6
owns text input, selection, history, and viewport behavior. `pandocmd-cst` is
the only Markdown parser and the authoritative structure for every editor
state.

The package has one surface: editable Markdown. Reader and read-only modes are
not part of the public package.

## Data flow

```text
keyboard input -> CM6 transaction -> pandocmd-cst update -> editor decorations
                                      |                -> cursor block/inline context
                                      +-> authoritative CST snapshot
```

The CM6 document and CST text are published together in one transaction. The
editor does not create a Lezer Markdown projection, run a second Markdown
parser, or infer document structure with regular expressions.

Rendering is deliberately downstream of this boundary. Coflat may visually
present a CST node—for example, KaTeX for math—but rendering does not add new
Markdown syntax or change the CST. Publication-only features belong in a
Pandoc/Lua/HTML rendering pipeline.

## Quick start

```ts
import { mountEditor } from "@chaoxu/coflat";
import "@chaoxu/coflat/style.css";

const editor = mountEditor({
  parent: document.getElementById("root")!,
  doc: "# Hello\n\nAn *editable* formula: $x^2$.",
  onDocumentChange({ tree }) {
    console.log(tree.text, tree.version);
  },
  onCursorContextChange({ block, inline }) {
    console.log(block?.kind, inline?.kind);
  },
  async readTextResource(path) {
    return workspace.readTextRelativeToCurrentDocument(path);
  },
});
```

`editor.getCst()` returns the CST paired with the current document.
`editor.getCursorContext()` reports the nearest Pandoc block and inline nodes.

Editing assistance is enabled by default. Type `@` to choose a local reference label or a loaded bibliography key; suggestions include target labels, titles, and author details. Press Ctrl-Space for Markdown snippets, including emphasis, links, math, and complete fenced divs. Use the arrow keys to choose, Enter or Tab to insert, and Tab/Shift-Tab to move between snippet fields. Escape dismisses suggestions. Hover over a reference for a text preview of its target, or put the caret in its source and press Mod-Shift-Space (Command on macOS, Control elsewhere).

Both `mountEditor` and `createEditor` accept `editingAssistance: false` to disable these aids, or an options object to configure each feature:

```ts
const editor = mountEditor({
  parent,
  doc,
  editingAssistance: {
    referenceCompletion: true,
    markupCompletion: true,
    referencePreviews: true,
    activateOnTyping: true,
    hoverTime: 300,
  },
});
```

These are the defaults. With `activateOnTyping: false`, Ctrl-Space still opens enabled suggestions. Bibliography suggestions and previews use the same host-provided `readTextResource` data as citation rendering, including uncited entries. See [the host API](EDITOR-HOST-API.md) for details.

Inline delimiters are hidden when inactive and revealed when the cursor enters
or touches either boundary of their CST node. Inline math is rendered with
Coflat's KaTeX surface when inactive; on entry, its literal Markdown source and
a live preview are shown.
Arrow keys can enter rendered inline math from either side. Pipe tables render
as semantic HTML tables; clicking a cell places the cursor at the start of its
source content and reveals the Markdown source below the table. The table stays
in place as a live preview. All content can be edited as Markdown
without using a mouse.

YAML metadata remains part of the editable source but is collapsed behind a small `YAML` button. A string `title` is presented as the centered paper title, and `math` entries are passed to every KaTeX surface as document macros. When `bibliography` is present, Coflat asks the host's `readTextResource` callback for the declared bibliography and optional `csl` files, renders citations with CSL (IEEE by default), and appends the cited bibliography entries. Citation-js is loaded lazily only for such documents.

Theorem, lemma, corollary, proposition, figure, and table fenced divs share one source-order counter; proofs, remarks, and every other class stay unnumbered. Common abbreviations such as `thm`, `lem`, `fig`, and `tbl` use the same policy. Display math inside `.equation` or `.eq` fenced divs has a separate `(1)`, `(2)`, … sequence; ordinary display math stays unnumbered, and an equation wrapper's `#id` attaches an autoref target to its sole display equation. A fenced-div `#id` resolves from simple `@id` and `[@id]` references, with local targets taking precedence over bibliography keys. Entering an opener or rendered reference reveals its literal source.

## Public entries

- `@chaoxu/coflat` — the editable CST-backed editor
- `@chaoxu/coflat/numeric` — small numeric citation helpers
- `@chaoxu/coflat/latex` — Pandoc/LaTeX export configuration helpers
- `@chaoxu/coflat/style.css` — Coflat editor styling and KaTeX assets
- `@chaoxu/coflat/document-surface.css` — reusable document design tokens

The former reader, rich-readonly, inline-render, parse, citeproc, and test
helper entries are intentionally not exported.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check:m6-authority
pnpm check:package-smoke
```

The authority check walks the shipped editor's import graph and rejects the
legacy Markdown projection, CodeMirror's Markdown parser, reader/mode modules,
and other retired semantic caches.

Run the local showcase with `pnpm dev:pages`.

See [editing performance](docs/editing-performance.md) for opt-in typing, preview, and long-session measurements.

## License

MIT
