# M6 CST feature matrix

Status: M6 complete. The immutable `pandocmd-cst` snapshot and its version-bound semantics are the only production Markdown authority. The `Tree` returned by `getPandocSyntaxTree` is a read-only traversal projection of that snapshot for mature Coflat geometry code; it does not parse or reinterpret Markdown.

| Phase | Current consumers | CST input | Semantic input | Migration/verification | Status |
| --- | --- | --- | --- | --- | --- |
| Transaction spine | `base-editor-extensions`, `document-state-extensions` | exact `SyntaxTree.text`, `version`, `changedRanges` | `semanticChangedRanges` | `pandoc-cst-field`; transaction, multi-change, undo/redo, IME, UTF-16 and CRLF tests | Complete |
| Source mode | `editor-mode-state`, source styling | all leaf ranges and ancestor kinds | none | `pandoc-cst-highlighting`; source/rich browser flow | Complete |
| Basic blocks | block render plan, headings, paragraphs, code, div renderers | heading/list/fence properties and ranges | heading info | CST traversal adapter plus block/render unit tests | Complete |
| Inline rendering | emphasis, code, links, images, math, raw, mark reveal | inline nodes, delimiter/body/destination ranges | reference resolution | CST traversal adapter, source-reveal and interaction tests | Complete |
| Document structure | lists, blockquotes, footnotes, citations, outline/navigation | list properties, quote/list marks, footnote/citation nodes | headings, footnotes, citations and references from the same version | synchronous `documentAnalysisField`; command and catalog tests | Complete |
| Replacement widgets | tables, images, math and cursor stops | table/cell geometry, image targets, math ranges | relevant syntax/semantic invalidation union | table, widget-stop and live-cell tests | Complete |
| Global interpretation | numbering, cross-references, bibliography/file services | CST structure | version-bound document projection plus independently versioned host data | reference catalog, label graph, indexer and bibliography tests | Complete |
| Readonly/reader | reader, preview blocks, rich-readonly surface | standalone CST parse and projection | complete synchronous snapshot | browser parity/readonly tests; Pandoc + Lua remains publication authority | Complete |

## Intentional fixed-dialect changes

The migration follows the workspace `plan.md` dialect, even where legacy Coflat accepted a narrower custom syntax:

- `==highlight==` is literal because Pandoc mark syntax is disabled.
- `$$x$$ {#eq:id}` has a display-math node followed by literal attributes; Coflat's former equation-label extension is retired. Cross-references resolve only targets intrinsic to the fixed dialect or supplied explicitly by host services.
- Custom `.algo` line parsing and custom theorem-fence title rules are retired; ordinary Pandoc list/div structure wins.
- Backslash display forms follow Pandoc `raw_tex` precedence. A standalone form that Pandoc classifies as raw TeX is not relabeled as display math by Coflat.
- Pipe tables require Pandoc-valid delimiter rows (including the minimum hyphen width); formerly accepted one-hyphen rows remain paragraphs.
- Incomplete emphasis that Pandoc leaves literal is no longer styled by a document-wide regex fallback.

These differences are locked by CST negative/differential fixtures. No editor-side scanner restores the old interpretation.

## Authority and invalidation

`pandocCstField` parses once during state creation and calls `PandocParser.update` exactly once for each document-changing transaction. Every published tree is synchronous with `EditorState.doc`. Renderers obtain structure through `getPandocTree`, `getPandocSyntaxTree`, and `getPandocSemantics`; standalone reader/indexer calls use the same parser and complete projection.

Widget anchors store CST version, kind, and half-open UTF-16 range. A mapped anchor is validated in the new tree before reuse. Viewport decoration caches are rebuilt from syntax or semantic changed ranges as appropriate. Bibliography, filesystem, and other host data retain their own context versions and do not mutate CST nodes.

The configured `@lezer/markdown` language package and private patch are absent from the shipped editor dependency graph. The old package remains a development-only dependency temporarily for historical parser comparison tests; it cannot select production rendering or semantics.

## M6 acceptance evidence

Baseline: Apple M4 Mac mini (10 cores, 16 GB), macOS 26.6.2 arm64, Bun 1.4.0, Node 26.8.1, Vitest 4.1.5, and Playwright 1.60.0. Timings are warmed local runs with no other benchmark running concurrently.

| Gate | Result | Limit/status |
| --- | --- | --- |
| CST 700 KiB full parse | 143.55 ms p95 | at or below 150 ms |
| CST 700 KiB localized update | 3.33 ms p95; one line scanned and one block rebuilt | at or below 5 ms |
| CodeMirror 700 KiB ordinary localized updates | worst case 3.24 ms p95 across prose, math, paired emphasis, theorem text, and multi-change autocorrect | at or below 8 ms |
| 700 KiB viewport decoration rebuild | 0.41 ms p95, 1.75 ms max over 50 samples | at or below 16.7 ms |
| 10,000 mixed edits | zero retained historical trees; maximum sampled heap growth 292,107 bytes | below 64 MiB diagnostic ceiling |
| CST verification | 158 tests passed, one opt-in long test skipped in the default run; the separate 10-seed × 1,000-edit long fuzz passed | green |
| Coflat verification | 3,589 tests passed, two intentional skips; typecheck, Biome, layer boundary, and CST-authority checks passed | green |
| Chromium smoke/parity | 56 tests passed, including source/rich/readonly, selection, writing, tables, scrolling, exact-pixel parity, and footnotes | green |

The separately reported short multiline paste/delete case is adversarial and reaches EOF; its 20.59 ms p95 is not classified as an ordinary localized M6 edit. The benchmark labels it explicitly and does not apply the 8 ms gate to it.
