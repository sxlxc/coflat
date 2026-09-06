# Editing performance

The transaction remains synchronous: CodeMirror publishes the complete source together with exactly one updated Pandoc CST snapshot. Presentation optimizations reuse derived decorations and numbering only when the CST permits it; they do not defer parsing or introduce another structural tree.

## Reproduce the measurements

```sh
pnpm bench:cst-transactions
COFLAT_CST_BENCHMARK=1 pnpm exec playwright test tests/e2e/performance.spec.ts --workers=1
pnpm check:cst-long-session
```

Run timing checks without concurrent tests or source edits. The browser benchmark uses a 700 KiB document with repeated prose, emphasis, links, and inline math, followed by the active prose, display-math, or table block. Each operation has 20 warmup samples and 50 measured samples. It checks source/CST agreement, restoration of the source after paired edits, and the current live preview. It reports synchronous dispatch time separately from time until the next animation frame; the latter includes browser scheduling and is not an input-to-paint measurement.

The unit benchmark uses jsdom and reports CST-only, CST-plus-cursor, complete-editor, and 1,000-row-table transactions. Its complete-editor case edits outside the initial viewport. Browser timings are the relevant complement for visible editing and preview layout. These workloads do not establish a latency bound for every Markdown edit or device.

## Local results, 2026-09-05

The original checkout at `259b322`, measured in isolation with the same browser workload, took 376.5 ms p95 for prose replacement, 377.7 ms for paired insertion/deletion, and 12.4 ms for cursor movement. Final Chromium dispatch measurements were:

| Active surface | Replace | Insert/delete | Cursor | Enter/leave source |
| --- | ---: | ---: | ---: | ---: |
| Prose | 4.7 ms | 4.6 ms | 2.6 ms | 2.8 ms |
| Display math | 5.0 ms | 5.1 ms | 2.5 ms | 2.6 ms |
| Small pipe table | 4.5 ms | 5.1 ms | 2.7 ms | 2.0 ms |

All entries are p95 values. Prose dispatch is approximately 80 times faster in this workload. Time until the next animation frame was about 26–29 ms in this browser environment; the dispatch results do not imply a particular display refresh rate. The table fixture is a small active table in a large paper, distinct from the large-table parser case below.

In jsdom, the complete-editor transaction fell from 507.6 ms to 4.53 ms p95. CST plus cursor context fell from 15.42 ms to 2.05 ms. CST parsing itself remains approximately 2 ms for localized prose edits; the 1,000-row table parser benchmark remains approximately 19.5 ms.

## Optimization boundaries

- Cursor and selection lookups use indexed CST range traversal instead of enumerating all top-level siblings.
- Document numbering, local targets, YAML presentation, and citation output retain unchanged results. Position mapping follows CodeMirror changes; syntax changes are checked against the authoritative CST.
- Invalidation ranges include mapped old block extents and adjacent structure where necessary, so splitting or merging a block cannot leave stale presentation behind.
- Full parser fallbacks refresh presentation across the document because the published CST can change outside the parser's reported invalidation ranges.
- Display-math and table fields rebuild affected previews and source lines while mapping unrelated decorations. Macro changes and changes to equation numbering still trigger the necessary global refresh.
- Host callbacks, reads, and saves reuse the source string already synchronized by the CST field.

The 10,000-edit, 700 KiB CST memory check retained no historical CST trees and recorded approximately 215 KB maximum heap growth on the local run. A separate 2,000-edit, 100 KiB run with the presentation state fields also retained no historical CST trees, with approximately 410 KB maximum heap growth.

## Remaining parser work

The vendored parser still has expensive cases: some paragraph splits fall back to a full parse, changes in large enclosing blocks exceed its localized-reparse limit, and heading edits can rebuild document-wide semantic indexes. These must be optimized and tested in the authoritative `pandocmd-cst` repository before refreshing the vendor snapshot.

The audit also observed existing incremental/full-parse discrepancies when introducing block fences. Rendering comparisons therefore rebuild from the same published CST, as required by the editor contract. Upstream parser work should include full-parse differential coverage for these edits.

A separate exploratory Bun measurement found a 1,000-row table edit took about 434 ms inside a 700 KiB document versus 7.4 ms in isolation. A bounded block-reparse prototype could target 10–30 ms for that embedded-table case; this is an estimate to validate upstream, not a measured gain from the editor changes. General paragraph splitting and incremental semantic indexes need their own correctness and performance evaluation.
