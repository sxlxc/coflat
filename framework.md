
USER'S BROWSER  ────────── everything below runs here ──────────────────────────
┌─────────────────────────────────────────────────────────────────────────────┐
│  Host page (e.g. examples/simple/main.ts)                                   │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  mountEditor() ────────────────────────────── editor.ts (public API)  │  │
│  │   ├─ save/autosave state machine: SaveHandler + StatusEvents + Mod-s  │  │
│  │   ├─ onChange / onDocumentChange({tree}) / onCursorContextChange      │  │
│  │   └─ setDoc/insertText/scrollTo...  (programmatic doc changes)        │  │
│  │        │                                                              │  │
│  │        ▼                                                              │  │
│  │  createSimpleEditor() ── src/editor/simple-editor.ts                  │  │
│  │   builds CM6 EditorState + EditorView with extensions:                │  │
│  │                                                                       │  │
│  │   ┌─ 1. CST AUTHORITY ─────────────────────────────────────────────┐  │  │
│  │   │ pandocCstField ─src/editor/cst/pandoc-cst-field.ts (StateField)│  │  │
│  │   │  every doc-changing transaction:                               │  │  │
│  │   │    CM6 changes ─► parser.update(newText, tree, changes)        │  │  │
│  │   │                   vendor/pandocmd-cst/src/tree.ts              │  │  │
│  │   │        ├─ block/parser.ts      (localized block re-parse)      │  │  │
│  │   │        ├─ inline/parser.ts     (delimiter resolution)          │  │  │
│  │   │        ├─ line-index.ts        (half-open UTF-16 ranges)       │  │  │
│  │   │        └─ semantic/index.ts    (refs/citations per version)    │  │  │
│  │   │  ──► immutable SyntaxTree snapshot + changedRanges             │  │  │
│  │   │      (asserted to equal EditorState.doc text, always)          │  │  │
│  │   └────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                       │  │
│  │   ┌─ 2. CURSOR SEMANTICS ──────────────────────────────────────────┐  │  │
│  │   │ pandocCursorContextField ── src/editor/cst/cursor-context.ts   │  │  │
│  │   │  tree.resolve(pos) ─► nearest block/inline node kinds          │  │  │
│  │   └────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                       │  │
│  │   ┌─ 3. WYSIWYG RENDERING (downstream of the CST) ─────────────────┐  │  │
│  │   │ cstEditSurface ── src/editor/cst/edit-surface.ts               │  │  │
│  │   │  ViewPlugin: walks CST nodes in visibleRanges ─► decorations   │  │  │
│  │   │   • hide `*` `_` `` ` `` delimiters when cursor is outside     │  │  │
│  │   │   • headings, code blocks, links, list-marker widgets          │  │  │
│  │   │   • math widgets (CstMathWidget) + Arrow-key entry             │  │  │
│  │   │        └► KaTeX + DOMPurify ── src/editor/render/katex-render.ts│ │  │
│  │   │  cstTableSurface ── src/editor/cst/table-surface.ts            │  │  │
│  │   │   • pipe tables as semantic HTML table widget (click=edit src) │  │  │
│  │   │        └► DOM builders in src/core/table-surface.ts            │  │  │
│  │   │  math surfaces ── src/core/math-{inline,display}-surface.ts    │  │  │
│  │   │  syntax token classes ── src/core/constants/css-classes.ts     │  │  │
│  │   └────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                       │  │
│  │   ┌─ 4. PLUMBING ──────────────────────────────────────────────────┐  │  │
│  │   │ CM6 core: history, keymaps, drawSelection, search ── @codemirror/*│  │
│  │   │ coflatTheme ── src/editor/theme.ts                             │  │  │
│  │   │ styles ── src/editor/editor-theme.css, src/core/document-surface.css │
│  │   └────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │  the ONLY server boundary: the host's
                                  │  SaveHandler.save({source}) — Coflat
                                  │  defines the interface, host implements
                                  ▼                        it (e.g. HTTP PUT)
                      [host's own backend]
                      (none shipped in this repo)


BUILD MACHINE / HOST CLI (not the user's browser) ─────────────────────────────
• vite build (vite.editor.config.ts) ─► bundles editor/numeric/latex .mjs + CSS
  + KaTeX fonts into dist/ — the static assets a host page loads
• LaTeX/PDF export: @chaoxu/coflat/latex (src/editor/latex/*.mjs, filter.lua,
  templates, ieee.csl) + scripts/export-latex.mjs — Node CLI that shells out
  to the real pandoc binary
• Final publication HTML: sibling repo pandocmd-lua (Pandoc + Lua pipeline) —
  explicitly outside this editor package
