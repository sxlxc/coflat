# Coflat editor invariants

1. `EditorState.doc` is always the complete Pandoc Markdown source.
2. `pandocCstField` publishes the only structural/semantic tree and its text
   must equal `EditorState.doc` in every observable state.
3. A document-changing CM6 transaction performs exactly one synchronous CST
   update. Selection-only transactions reuse the same CST snapshot.
4. Decorations, syntax highlighting, and cursor context read the CST directly.
   They must not use CodeMirror's Markdown parser, regex structure scanners, or
   the retired CST-to-Lezer projection.
   Completion and reference previews follow the same rule: targets and context
   come from the CST, while bibliography candidates reuse host-loaded data.
   Lexical matching of an unfinished completion prefix does not define grammar.
5. Visual widgets never own persisted content. Every source position remains
   reachable and editable from the keyboard.
6. Rendering may change presentation, such as KaTeX output, but cannot add
   editor grammar or mutate source semantics.
7. Coflat has one editable mode. Reader and read-only behavior belong outside
   the editor.

Run `pnpm check:m6-authority` after changing the editor import graph.
