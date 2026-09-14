# Coflat Agent Guide

## Project purpose

Coflat (`@chaoxu/coflat`) is a keyboard-first WYSIWYG editor for a fixed Pandoc Markdown dialect. It is a TypeScript ESM package built on CodeMirror 6, `pandocmd-cst`, and KaTeX.

The product has one public editing surface. CodeMirror owns text input, selection, history, and viewport behavior; `pandocmd-cst` owns Markdown structure and semantics; visual rendering is downstream of both. Reader, rich-readonly, and alternate editor modes have been deliberately retired.

The published entries are `@chaoxu/coflat`, `@chaoxu/coflat/numeric`, `@chaoxu/coflat/latex`, the editor and document-surface stylesheets, the optional theme, and LaTeX support assets. Do not casually broaden this API surface.

## Read before changing code

- `README.md` explains the current product boundary, data flow, public entries, and normal development commands.
- `docs/editor-invariants.md` is normative for editor-state and CST changes.
- `FORMAT.md` specifies Coflat's canonical Pandoc Markdown dialect. Read its “Rules for Agents” before writing or modifying example documents or format behavior.
- `EDITOR-HOST-API.md` defines what the host owns and what the editor owns.
- `THEMING.md` defines stable CSS variables and document classes.
- `vendor/pandocmd-cst/README.md` defines how the vendored parser snapshot is maintained.

If documentation and implementation disagree, investigate the history and tests rather than silently choosing one. Update the relevant contract document when intentionally changing a documented contract.

## Repository map

- `editor.ts`: main public API and editor host integration.
- `numeric.ts` and `latex.ts`: the other public TypeScript entries.
- `src/editor/`: CodeMirror state, CST-backed editing surfaces, browser rendering, theme integration, citations, and LaTeX assets.
- `src/core/`: dependency-light shared logic and document styling. Its import restrictions are enforced by `scripts/check-layer-boundary.mjs`.
- `vendor/pandocmd-cst/`: development-only snapshot copied from the authoritative sibling `pandocmd-cst` repository. Do not implement CST behavior directly here; make and test parser changes upstream, then refresh the snapshot, version, and lockfile.
- `scripts/`: package checks, architectural guardrails, export tooling, and maintenance utilities.
- `tests/e2e/`: Playwright browser behavior and typography coverage.
- `examples/simple/`: local showcase used by `bun run dev:pages`.
- `dist/`, `dist-pages/`, `test-results/`, and Playwright reports: generated output; do not edit or commit them as source.

## Non-negotiable architecture

1. `EditorState.doc` is the complete Pandoc Markdown source.
2. `pandocCstField` publishes the only structural and semantic tree, and its text must equal the CodeMirror document in every observable state.
3. Each document-changing CodeMirror transaction performs exactly one synchronous CST update. Selection-only transactions reuse the existing CST snapshot.
4. Decorations, cursor context, and syntax presentation read the CST directly. Do not add a second Markdown parser, use CodeMirror's Markdown/Lezer tree, reconstruct the retired CST-to-Lezer projection, or infer document structure with regular expressions.
5. Visual widgets never own persisted content. Every source position must remain selectable and keyboard-editable; presentation must not create mouse-only behavior.
6. KaTeX, tables, and other renderers may change presentation, but they may not add grammar or mutate source semantics.
7. Publication-only behavior belongs in the Pandoc/Lua/HTML export pipeline, not in editor grammar.
8. There is one editable mode. Do not restore reader, rich-readonly, mode-switching, or retired semantic-cache modules.

Run `bun run check:m6-authority` whenever the editor import graph or structural parsing path changes.

## Layer boundary

`src/core` may only use relative imports that stay inside `src/core`, and it must not import CodeMirror, React, DOMPurify, or KaTeX. `src/editor` may depend on `src/core` and browser/editor packages. Keep type-only dependency edges within the same boundary; the layer checker intentionally validates them too.

Put logic in `src/core` only when it genuinely belongs to the dependency-light shared layer. Do not introduce adapters merely to evade the boundary.

## Engineering principles

Optimize for correctness, simplicity, and maintainability. Prefer fewer concepts, abstractions, dependencies, indirections, lines of code, and touched files when alternatives are equally correct.

Make the smallest coherent change that fully solves the task. Follow existing patterns and fix root causes. Do not refactor unrelated code, add speculative configuration, or design for hypothetical requirements. A little local duplication is better than a premature abstraction.

Use direct functions and data structures with explicit control flow. Add an abstraction only when it represents a real domain concept, removes meaningful duplication, or clearly makes the current implementation easier to understand.

Do not hide failures with silent fallbacks, broad catches, or defensive checks that conceal violated invariants. Handle realistic boundary cases, especially document synchronization, selection behavior, Unicode, CRLF input, and lifecycle cleanup.

Optimize only where measurements or a known hot path justify it. Preserve synchronous transaction semantics and avoid unnecessary reparses, DOM work, allocation, and copying, but do not trade clarity for speculative speed.

## TypeScript and CSS style

- Use strict TypeScript and native ESM. Use `import type`/`export type` for type-only edges.
- Match the surrounding style: two-space indentation, double quotes, semicolons, and trailing commas in multiline constructs. Biome formatting is disabled, so do not mechanically reformat unrelated code.
- Prefer `const`, explicit domain types, immutable/`readonly` data, and narrow interfaces. Avoid `any`, CommonJS, namespaces, unsafe non-null assertions, and casts that bypass invariants.
- Public APIs and non-obvious helpers should have explicit return types. Keep public dependency types neutral unless exposing the dependency is intentional.
- Names should communicate intent. Comments should explain why a constraint or workaround exists, not narrate the code.
- CodeMirror source offsets are zero-based UTF-16 offsets. Public line-oriented helpers use one-based line numbers; preserve these conventions and test non-ASCII text when touching coordinates.
- Keep related state transitions together and clean up timers, views, event handlers, and DOM resources deterministically.
- Reuse the stable `cf-*` class vocabulary and `--cf-*` custom properties. Centralize shared class names/tokens using existing constants, and preserve caret visibility, source selection, keyboard access, and responsive behavior.
- Coflat document prose should not be hard-wrapped: in the editor's dialect, a source newline is visibly meaningful. Follow `FORMAT.md` rather than GitHub-Flavored Markdown assumptions.

## Tests and verification

Use bun as declared in `package.json` (`bun@1.4.2`). Do not switch package managers or hand-edit `bun.lock`.

Choose checks proportional to the change:

- Focused unit test: `bunx vitest run path/to/file.test.ts`
- Full unit suite: `bun run test`
- Type and architectural lint checks: `bun run check:static`
- Layer boundary only: `bun run lint:layers`
- CST authority only: `bun run check:m6-authority`
- Production package build: `bun run build`
- Published-package smoke test: `bun run check:package-smoke`
- Package metadata/export validation: `bun run check:package`
- Chromium interaction smoke suite: `bun run test:e2e`
- Local showcase: `bun run dev:pages`

Tests use Vitest with jsdom and are normally colocated as `*.test.ts` or `*.test.mjs`. Browser tests live under `tests/e2e`. Add focused regression coverage for behavior changes; assert source text, CST synchronization, cursor/selection state, and rendered DOM where applicable. Include keyboard paths for interactive surfaces, not only click paths.

For an editor behavior change, normally run the focused tests, `bun run check:static`, and `bun run test`. Add `bun run build` and package checks for entry-point, dependency, export, asset, or packaging changes. Add Playwright coverage for real layout, focus, selection, keyboard navigation, or cross-browser behavior. Documentation-only changes do not require the full suite.

Benchmarks and long-session checks are specialized tools, not routine gates. Use them when changing transaction performance, incremental parsing, or CST invalidation behavior.

## Git and change hygiene

- Inspect `git status` before editing. The worktree may contain user changes; preserve them and never overwrite or clean unrelated files.
- Keep diffs narrow. Do not include generated artifacts, local stores, test output, drive-by formatting, or unrelated cleanup.
- Update `bun.lock` only through bun when dependencies or the vendored package version genuinely change.
- Do not commit, amend, rebase, merge, tag, or push unless the user explicitly asks.
- When asked to commit, prefer the repository's concise imperative style, usually `type(scope): summary` for changes such as `feat(editor): ...`, `fix(editor): ...`, or `test(cst): ...`. Keep a commit focused on one coherent change.
- Before handing off, review `git diff` and `git status`, remove accidental changes, and confirm that no user-owned modification was included.

## Completion standard

Before finishing, ask whether the implementation can be simpler without losing correctness or clarity. Report what changed, why the design fits the project, which checks ran and their results, and any remaining uncertainty or unverified behavior.
