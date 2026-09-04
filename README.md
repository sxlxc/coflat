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
});
```

`editor.getCst()` returns the CST paired with the current document.
`editor.getCursorContext()` reports the nearest Pandoc block and inline nodes.

Inline delimiters are hidden when inactive and revealed when the cursor enters
their CST node. Inline math is rendered with Coflat's KaTeX surface when
inactive; on entry, its literal Markdown source and a live preview are shown.
Arrow keys can enter rendered inline math from either side. Pipe tables render
as semantic HTML tables; clicking one reveals its Markdown source and keeps a
live table preview beside the edit. All content can be edited as Markdown
without using a mouse.

Fenced div openers render as bold, unnumbered class labels with an optional parenthesized `title`; common class abbreviations such as `thm` and `lem` expand to their full labels. A fenced div `#id` resolves from simple `@id` and `[@id]` references. Entering an opener or reference reveals its literal source, and blockquote `>` markers use the source monospace font.

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

## License

MIT
