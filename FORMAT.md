# Coflat Document Format

Pandoc Markdown with one fixed dialect for mathematical writing. This document specifies the canonical input format the editor expects.

Canonical documents must be parseable by Pandoc. Coflat semantics are encoded with Pandoc-native constructs such as YAML metadata, fenced divs, attributes, citations, raw LaTeX, and tables. Non-Pandoc authoring sugar is not part of the canonical format.

The canonical Pandoc reader profile is:

```text
markdown+tex_math_double_backslash+tex_math_single_backslash+latex_macros+raw_tex
```

The editor uses the immutable CST and its version-bound semantic indexes. Pandoc plus the Lua pipeline remains the publication-rendering authority.

## Rules for Agents

LLM agents do not know Coflat from training data and default to GitHub-flavored Markdown habits that break Coflat documents. This section is the delta an agent must load before writing or editing Coflat; inject it (or a pointer to it) into every agent call that writes Coflat. The rest of this document is the full specification.

Ordered by how often agents get them wrong:

1. **One paragraph = one source line.** A single source newline inside a paragraph is preserved visually by the editor, so hard-wrapped prose appears with ragged line breaks. Never wrap prose at a source-column width; a blank line starts a new paragraph. See "Paragraphs and Line Breaks".
2. **Use standard Pandoc structure.** Blockquotes, definition lists, indented code, and reference-style links are accepted by the fixed dialect. Use fenced divs when the content needs theorem-like semantics or a stable block id.
3. **Theorem-like content goes in fenced divs with stable ids**, such as `::: {.theorem #thm:main title="Main theorem"}` — never bold pseudo-labels (`**Theorem 1.**`), code fences, or raw `\begin{theorem}`. The `title` attribute is plain text except for inline math delimited by `$...$` or `\(...\)`; other Markdown is not parsed there.
4. **Nest divs with more colons outside.** The outer div uses more colons than the inner (`::::` outside, `:::` inside); same-count nesting misparses. Every div needs its matching explicit closer with the same colon count as its opener.
5. **Math uses `$...$`, `$$...$$`, `\(...\)`, or `\[...\]`**, never backticks or code fences. To label display math, wrap it in `::: {.equation #eq:name}`; do not append pandoc-crossref-style `{#eq:name}` text after the math. Escape a literal dollar in prose as `\$`.
6. **Cross-reference with `[@id]` or narrative `@id`** using the prefix conventions in "Cross-References"; a bare key without a known prefix is treated as a BibTeX citation.
7. **Do not rely on disabled extensions** such as `==mark==`, alerts, wikilinks, emoji shortcodes, bare-URI autolinks, or GFM-only math forms. They remain literal text. See "Disabled Extensions".
8. **Code fences are only for literal artifacts** — code, command output, raw data, certificates, and algorithm bodies — never for prose, mathematical statements, or formulas.
9. **When unsure, use the plainest canonical forms**: one-line paragraphs, pipe tables, and built-in fenced divs. Do not invent syntax.

Host contracts may add page rules on top of this format. For example, Cosheaf wiki pages start with one meaningful `#` H1, and Cosheaf's typed file route owns YAML frontmatter, so agents writing Cosheaf pages should not add frontmatter themselves. Follow the host's contract for frontmatter and page shape.

## Editing and Rendering

Coflat's runtime package has one editable surface:

- The editor (`@chaoxu/coflat`) mounts a keyboard-editable CodeMirror surface.
  Its structure, inline/block cursor context, and visual interfaces come only
  from `pandocmd-cst`.

Read-only HTML, publication layout, reference resolution, and other fancy
presentation are downstream rendering concerns. They may consume the CST or
Pandoc output, but they do not add editor grammar or reconstruct the retired
Lezer Markdown projection.

## Frontmatter

YAML block delimited by `---`. All fields optional.

Coflat follows Quarto's scholarly-article metadata names where they fit. Use
`author` as the canonical author key for new documents; `authors` is accepted
as a compatibility alias. Likewise, top-level `affiliation` and
`affiliations` are aliases, with `affiliations` preferred when defining shared
affiliation records.

```yaml
---
title: Document Title
subtitle: Optional subtitle
description: |
  Short summary for listings, previews, and citation metadata.
date: 2026-06-20
date-format: long

author:
  - id: first
    name: First Author
    email: first@example.org
    orcid: 0000-0000-0000-0000
    url: https://example.org/first
    affiliation:
      - ref: lab
    funding: Supported by grant X.
affiliations:
  - id: lab
    name: Example Lab
    city: Example City
    country: Example Country
    url: https://example.org/lab

doi: 10.5555/example
citation:
  type: article-journal
  container-title: Journal of Examples
  volume: 1
  issue: 2
  doi: 10.5555/example
google-scholar: true
bibliography: reference.bib
csl: style.csl
keywords:
  - keyword one
  - keyword two
license:
  text: CC BY 4.0
  type: open-access
  url: https://creativecommons.org/licenses/by/4.0/
copyright:
  holder: First Author and coauthors
  year: 2026
funding: Document-level funding statement.
acknowledgements: We thank the reviewers.
relatedversion: https://arxiv.org/abs/0000.00000

imageFolder: images
math:
  \R: "\\mathbb{R}"
  \N: "\\mathbb{N}"
latex:
  template: article
  bibliography: reference.bib
---
```

Put the scholarly abstract in the document body as a normal Coflat block:

```markdown
::: {.abstract}
Scholarly abstract. Markdown, citations, and math like $x^2$ are allowed.
:::
```

### Article metadata

These keys describe the article itself. They are intentionally close to
Quarto's front matter so source can move between Quarto and Coflat with minimal
rewriting.

| Key | Type | Description |
|-----|------|-------------|
| `title` | string | Document title shown by the editor and used by downstream renderers and export. |
| `subtitle` | string | Optional subtitle for title-block/export hosts. |
| `description` | string | Short summary for listings, previews, and citation metadata. |
| `date` | string | Publication or document date. ISO `YYYY-MM-DD` is preferred; Quarto-style `today`, `now`, and `last-modified` are accepted by hosts that can resolve them. |
| `date-format` | string | Quarto-compatible date formatting hint. |
| `author` / `authors` | string, object, or list | Author metadata. `author` is canonical; `authors` is an accepted alias for existing Coflat/LIPIcs documents. |
| `affiliations` / `affiliation` | string, object, or list | Shared affiliation records. Use `id` and author-side `ref` to avoid repeating shared affiliations. |
| `doi` | string | Article DOI. Also used as a default for `citation.doi` when citation metadata is emitted. |
| `keywords` | list of string | Keyword list. |
| `license` | string or map | License text or `{text, type, url}` metadata. |
| `copyright` | string or map | Copyright statement or `{statement, holder, year}` metadata. |
| `funding` | string | Document-level funding statement. |
| `acknowledgements` | string | Document-level acknowledgements. |
| `relatedversion` | string | Preprint, full version, artifact, or related-version pointer. |
| `citation` | boolean or map | CSL-shaped citation metadata. `true` requests citation metadata from the article fields; a map can provide CSL fields such as `type`, `container-title`, `volume`, `issue`, `publisher`, `url`, `doi`, `page-first`, and `page-last`. |
| `google-scholar` | boolean | Request Google Scholar / Highwire-style metadata in HTML-producing hosts. |

Author objects use Quarto-compatible keys where possible:

| Key | Type | Description |
|-----|------|-------------|
| `id` | string | Stable author identifier for references from other metadata. |
| `name` | string or CSL name map | Display name. A CSL name map may be used when particles or family/given names matter. |
| `email`, `phone`, `fax`, `url` | string | Contact details. |
| `orcid` | string | ORCID in `0000-0000-0000-0000` form. |
| `degrees` | string or list | Academic/professional degrees. |
| `affiliation` | string, object, or list | Inline affiliation(s) or `{ref: id}` references to top-level `affiliations`. |
| `affiliation-url` | string | Shortcut URL for a string affiliation. Prefer full affiliation objects when possible. |
| `note`, `acknowledgements`, `funding` | string | Author-specific notes and support statements. |
| `corresponding` | boolean | Marks the corresponding author. |

Affiliation objects use:

| Key | Type | Description |
|-----|------|-------------|
| `id` | string | Stable affiliation identifier. |
| `ref` | string | Reference to another affiliation record. |
| `name` | string | Institution, organization, or lab name. |
| `department`, `group` | string | Optional sub-organization labels. |
| `city`, `state`, `country` | string | Location metadata. |
| `url` | string | Affiliation URL. |

### Coflat document config

These keys control Coflat parsing, rendering, and export behavior rather than
the scholarly identity of the article:

| Key | Type | Description |
|-----|------|-------------|
| `bibliography` | string or list of strings | Path(s) to `.bib`, CSL JSON, or CSL YAML data, relative to the document. |
| `csl` | string | Path to CSL style file. |
| `nocite` | string or list | Pandoc-style keys to include in the bibliography without an inline citation; `@*` includes every loaded entry. |
| `math` | map | KaTeX macro definitions (`\command: "expansion"`); the leading backslash on a macro name is optional. |
| `latex` | map | LaTeX export options. Supported keys: `template`, `bibliography`, `csl`. |
| `imageFolder` | string | Default folder for pasted/dropped images. Also accepts `image-folder`. |

Project-level config in `coflat.yaml` uses the same Coflat document config
keys. File frontmatter overrides project config. Math macros and block
definitions merge additively (file adds to or overrides project).

### Title-block metadata

Full-document renderers and export hosts that produce an article title block
should use `title`, `subtitle`, `author`, `date`, `doi`,
and `description`. The following Quarto-compatible keys customize
title-block display when a host supports them:

| Key | Type | Description |
|-----|------|-------------|
| `title-block-style` | `"default"` \| `"plain"` \| `"none"` | Controls title-block processing/styling. |
| `title-block-banner` | boolean or string | Enables a banner title block; a string is interpreted as a banner image path. |
| `title-block-banner-color` | string | Foreground color for banner text. |
| `author-title`, `affiliation-title`, `description-title`, `published-title`, `doi-title` | string | Label overrides for title-block metadata. |

### Template-specific metadata

Fields consumed only by a specific export template remain allowed at top level
so Pandoc templates can read them directly. They should not replace the
article metadata above.

| Key | Type | Description |
|-----|------|-------------|
| `titlerunning` | string | Short title for running heads. |
| `authorrunning` | string | Short author line for running heads. |
| `category` | string | Track / session label. |
| `ccsdesc` | list of `{weight, text}` | ACM CCS subject descriptors (higher weight -> more prominent). |

## Text Formatting

| Syntax | Renders as |
|--------|-----------|
| `**bold**` | **bold** |
| `*italic*` | *italic* |
| `` `code` `` | `code` (monospace) |
| `~~strikethrough~~` | ~~strikethrough~~ |
| `==highlight==` | literal text (`mark` is disabled) |
| `[text](url)` | hyperlink |
| `![alt](src)` | image |

Backtick-quoted text (`` `...` ``) renders as plain monospace — no background or badge. In mathematical writing this corresponds to `\texttt{}` in LaTeX: a font switch, not a code block. The same syntax can mean either "inline code" or "monospace emphasis" depending on context; Coflat does not distinguish between them.

## Paragraphs and Line Breaks

A blank line starts a new paragraph.

A single source newline inside a paragraph is preserved visually by Coflat's
editor, but remains a Pandoc soft break for export:

```markdown
first visual line
second visual line
```

Do not add manual newlines just to wrap prose in source control. In Coflat those
newlines affect editor presentation and can create unintended ragged line
breaks. Write ordinary prose as one paragraph and let the editor, browser, or
export target wrap it naturally. Pandoc, LaTeX, and ordinary HTML
export treat a soft line break as normal whitespace unless an explicit hard
break is used.

Use an intentional source newline only when the visual break matters in Coflat's
editor presentation. Use a blank line for a new paragraph. Outside
tables, use Markdown's hard line break syntax, two trailing spaces before the
newline, only when the exported target must receive a hard break. For table-cell
line breaks, use the table-cell rule below.

## Headings

ATX headings (`#` through `######`). Auto-numbered unless marked unnumbered. Explicit heading IDs are supported via trailing Pandoc attributes and can be cross-referenced.

```markdown
# Numbered Heading              --> "1. Numbered Heading"
## Subsection                   --> "1.1. Subsection"
# Another Section               --> "2. Another Section"

# Unnumbered Heading {-}        --> no number
## Also Unnumbered {.unnumbered} --> no number
## Background {#sec:background} --> cross-ref target "Section 1.1"
```

Appendices start at a top-level semantic appendix boundary:

```markdown
# Main Result                    --> "1. Main Result"

# Appendix {.appendix}           --> no number; starts appendix mode after this heading

# Extra Proofs                   --> "A. Extra Proofs"
## Technical Lemma               --> "A.1. Technical Lemma"
# Data Tables                    --> "B. Data Tables"
```

The `.appendix` marker is meaningful only on top-level `#` headings. The marker
heading itself is unnumbered, the marker is stripped from visible text, and all
following numbered headings use appendix letters (`A`, `B`, ...) with dotted
subheading numbers (`A.1`, `A.2`, ...). If the first numbered heading after the
boundary is a subheading, it is treated as part of implicit appendix `A` (for
example, `## Proofs` becomes `A.1`). Explicitly unnumbered headings after the
boundary remain unnumbered. LaTeX/PDF export emits `\appendix` at this boundary.

Trailing Pandoc attribute blocks are supported on headings. Coflat uses them primarily for `#id`, `{-}`, `{.unnumbered}`, and `{.appendix}`.

## Math

Four delimiter styles, all producing the same KaTeX output:

### Inline math

```
$e^{i\pi} + 1 = 0$
\(e^{i\pi} + 1 = 0\)
```

### Display math

```
$$
\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}
$$

\[
\sum_{k=0}^n \binom{n}{k} = 2^n
\]
```

Display math can interrupt a paragraph (no blank line required before `$$` or `\[`).

### Labeled display equations

Display math uses `$$...$$` or `\[...\]`. To give one display equation a stable cross-reference target, place exactly that math block inside an `.equation` fenced div with an `#eq:` ID:

```markdown
::: {.equation #eq:einstein}
$$
E = mc^2
$$
:::
```

The fenced div is a native Pandoc `Div`: its `#eq:einstein` identifier survives parsing, while its body remains ordinary display math. Reference it with `[@eq:einstein]` or narrative `@eq:einstein`. An `.equation` div must have one `#eq:` ID, contain exactly one display math block, and have no `title` or other body content. Use bare display math when no reference target is needed.

For LaTeX export, `.equation` follows the environment-backed fenced-div convention: the class selects the `equation` environment, the div ID becomes its label, and the sole display-math contents become the environment body.

```latex
\begin{equation}\label{eq:einstein}
E = mc^2
\end{equation}
```

Coflat does not use pandoc-crossref equation-label syntax. A trailing `{#eq:einstein}` after `$$...$$` is literal text in Pandoc's AST and is not a canonical Coflat equation label. Raw LaTeX `\begin{equation}\label{...}...\end{equation}` is opaque raw TeX and is likewise not the canonical authoring form.

Only display-math CST nodes inside `.equation` or `.eq` fenced divs receive a document-global number in source order. Ordinary display math remains unnumbered. The editor places `(1)`, `(2)`, and so on at the right edge without widening the article; an `.equation #id` wrapper associates its ID with its sole display math, so `[@eq:einstein]` renders as `(1)`. The wrapper itself has no separate header or counter entry.

**Escape rules.** A literal dollar sign in prose is written `\$` and does not open inline math. Inside `$...$` inline math, a backslash escapes the following character, so `$ \$50 $` is a math span containing a literal `$`. Display math `\[...\]` and inline math `\(...\)` are the LaTeX-style alternative syntaxes for `$$...$$` and `$...$`; the same backslash-escape applies to their contents. Dollar-math is suppressed inside fenced code blocks and inline code spans.

### Custom macros

Define in frontmatter under `math:`. Available in all math expressions:

```yaml
math:
  \R: "\\mathbb{R}"
  \set: "\\left\\{#1\\right\\}"
```

Usage: `$x \in \R$`, `$\set{1,2,3}$`.

The leading backslash on each macro name is optional. `R: "\\mathbb{R}"` and `\R: "\\mathbb{R}"` both define `\R`, matching the Pandoc/Lua renderer.

## Fenced Divs

Pandoc-style fenced divs for semantic blocks. Minimum 3 colons.

### Basic syntax

```markdown
::: {.theorem}
Content here.
:::
```

### With ID, class, and title

```markdown
::: {.theorem #thm:main title="Main Result"}
Statement of the theorem with $math$.
:::
```

The title is a Pandoc attribute. It is plain text except for inline math delimited by `$...$` or `\(...\)`, which the editor renders with the document's KaTeX macros; other inline Markdown is not parsed. The editor renders the six numbered classes with their shared document-global number and an optional parenthesized title, for example **Theorem 1 (Main Result)**. Other classes render a bold, unnumbered label. For `figure`, `table`, and `algorithm` blocks, the title also becomes the publication caption.

Attributes inside `{...}`:
- `.classname` -- block type (required, first class is the primary type)
- `#id` -- cross-reference ID
- `key="value"` -- key-value attributes (e.g., `title="Alternative Title"`)
- Multiple classes: `{.theorem .important}` (first is the block type)

Trailing title text after the attribute block, such as `::: {.theorem} Main Result`, is not canonical because Pandoc does not parse it as part of the div.

### Class shorthand

Pandoc supports a class-only shorthand when no ID or title is needed:

```markdown
::: theorem
Content.
:::
```

This is equivalent to `::: {.theorem}`. It cannot carry a title.

For editor presentation, common abbreviated classes expand to their mathematical labels: `thm` to Theorem, `lem` to Lemma, `cor` to Corollary, `prop` to Proposition, `def` or `defn` to Definition, `conj` to Conjecture, `prob` to Problem, `ex` to Example, `rem` to Remark, `pf` or `prf` to Proof, `fig` to Figure, `tbl` to Table, and `alg` to Algorithm. Canonical documents should continue to use the full built-in class names when downstream export behavior matters.

### No self-closing blocks

Fenced divs must use explicit opener and closer lines:

```markdown
::: {.theorem}
Short statement.
:::
```

Single-line self-closing divs such as `::: {.theorem} Short statement. :::` are not canonical because Pandoc treats them as unclosed divs or literal paragraph text.

Unclosed fenced divs at end of file are tolerated while editing and during import recovery, but they are not canonical. A saved canonical document must include the matching closing fence line.

### Nesting

Use more colons for outer divs:

```markdown
:::: {.theorem title="Outer result"}
Statement.

::: {.proof}
Proof content.
:::
::::
```

The opening and closing fence of a single div must use the same number of colons. A closer with a different colon count is not a valid match for that opener.

The inner block must use **fewer** colons than the outer. Each level of nesting must use a strictly smaller colon count than the level enclosing it; reusing the same count at any nested level is not supported.

Same-colon nesting is not supported. For example, this is invalid and will parse incorrectly:

```markdown
::: {.theorem}
::: {.proof}
...
:::
:::
```

Use `::::` for the outer block and `:::` for the inner block instead.

The parser uses a generation counter to prevent incremental fragment reuse across composite block boundaries.

Display math and fenced divs are independent block structures. A display math opener inside a fenced div must close before the fenced div closes; otherwise the fenced div closer still wins as the block boundary and the math is treated as incomplete authoring state.

### Built-in block types

| Type | Counter group | Body style | Special behavior |
|------|--------------|-----------|-----------------|
| `theorem` | numbered-block | italic | -- |
| `lemma` | numbered-block | italic | -- |
| `corollary` | numbered-block | italic | -- |
| `proposition` | numbered-block | italic | -- |
| `conjecture` | -- (unnumbered) | italic | -- |
| `definition` | -- (unnumbered) | normal | -- |
| `problem` | -- (unnumbered) | normal | -- |
| `equation` | equation | normal | exactly one labeled display math block; wrapper header hidden |
| `example` | -- (unnumbered) | normal | -- |
| `remark` | -- (unnumbered) | normal | -- |
| `proof` | -- (unnumbered) | normal | QED tombstone at end |
| `algorithm` | -- (unnumbered) | normal | verbatim code-fence body |
| `algo` | -- (unnumbered) | normal | line-mode pseudocode body (see below) |
| `figure` | numbered-block | normal | caption rendered below content |
| `table` | numbered-block | normal | caption rendered below content |
| `blockquote` | -- (unnumbered) | normal | header label hidden |

The `numbered-block` counter is fixed and document-global: only theorem, lemma, corollary, proposition, figure, and table advance it, including their abbreviations. For example, Theorem 1, Figure 2, and Lemma 3 form one sequence. Equation numbers form a separate document-global sequence.

Typical numbered figure/table usage:

```markdown
::: {.figure #fig:architecture title="System overview"}
![System overview](architecture.png)
:::

::: {.table #tbl:runtime title="Running times"}
| Algorithm | Time |
|-----------|------|
| Quicksort | $O(n \log n)$ |
:::
```

#### Multi-image figures (subfigures)

A figure div may contain more than one image. Each image becomes a subfigure in LaTeX (`\subfigure` / `\subcaptionbox`). Alt text per image is used as the subcaption:

```markdown
::: {.figure #fig:compare title="Before and after"}
![Before](before.png)
![After](after.png)
:::
```

#### Algorithm body

Algorithm blocks use a fenced code block (language `text` or none) for the pseudocode body. The exporter lifts the body verbatim into a LaTeX `algorithm` environment; the div's `title` attribute becomes the `\caption`:

````markdown
::: {.algorithm #alg:dijkstra title="Shortest paths"}
```text
Input: graph G, source s
Output: distances d[v]
  for each v in V: d[v] <- infinity
  d[s] <- 0
  ...
```
:::
````

#### Erickson-style pseudocode (`.algo`)

`.algo` blocks are line-mode pseudocode in the style of Jeff Erickson's `algo`
LaTeX environment: every non-blank physical line inside the div is one
algorithm line, and leading whitespace is the block structure (2 spaces = 1
indent level; a tab counts as 1 level). Line content is ordinary inline
markdown, so `$...$` math renders everywhere:

```markdown
::: {.algo #alg:min3 title="Compute a minimum 3-partition."}
$\textsc{Min3Partition}(f)$:
  $V \gets \mathrm{domain}(f)$
  if $|V| \le 6$
    return the optimum by brute force
  for $X \in \binom{V}{1}$
    add candidate $\{X\} \cup \textsc{Min2Partition}(f_{\setminus X})$
  return minimum over all candidates
:::
```

Rules:

- One source line = one rendered line; there is no continuation syntax.
  The editor renders the literal leading spaces; the LaTeX tabbing export keeps wrapped and following
  lines at their indent level.
- Blank lines inside the block are preserved as vertical spacing.
- The body has **no nested block structure**: a line starting with `:::`,
  `#`, `-`, or ` ``` ` is still just a pseudocode line. Only the exact
  matching closing fence ends the block.
- `.algo` and `.algorithm` are unnumbered in the editor. Both use the `alg:` ID
  prefix for explicit references, and the `title` attribute becomes the
  caption.
- There are no keywords, line numbers, or automatic styling — the Erickson
  aesthetic is plain text plus math plus indentation.

LaTeX export maps the body onto a boxed, centered `tabbing` environment
(`coflatalgo` in the article template, after chao.sty / Jeff Erickson's
macros), converting indent changes between consecutive lines into `\+` / `\-`
tabbing marks inside an `algorithm` float whose `\caption` is the title.

Internally, `.algo` is the first block class with `bodyMode: "lines"` in the
block manifest: the fenced-div parser starts a `LineFencedDiv` composite
instead of `FencedDiv` (same fence syntax, opener attributes, nesting, and
closer rules), and each body line parses as an `AlgoLine` node with inline
content.

### Other block types

Any other first class remains a valid Pandoc fenced div. Coflat derives a readable label from its class name but does not number it. Document metadata cannot override the fixed numbered class set or counter policy.

## Cross-References

Reference fenced blocks and headings by their `#id` attribute. A host may also resolve document-external targets through `DocumentContext`.

`pandocmd-cst` tokenizes bracketed citation clusters and narrative `@id` forms as `Citation` / `ExampleReference` nodes. Coflat derives local targets and citation presentation directly from those nodes; it does not scan Markdown source with a second parser.

### ID prefixes

IDs are conventionally prefixed by target kind. The LaTeX exporter uses these prefixes to route `[@id]` to `\cref{id}` vs `\cite{id}`:

| Prefix | Target |
|--------|--------|
| `sec:` | heading |
| `thm:` | theorem |
| `lem:` | lemma |
| `cor:` | corollary |
| `prop:` | proposition |
| `def:` | definition |
| `eq:` | equation |
| `fig:` | figure |
| `tbl:` | table |
| `alg:` | algorithm |

Any other bare key (e.g. `karger2000`) is treated as a citation key. IDs with unrecognized prefixes still resolve if they match a fenced block `#id`.

### Bracketed (rendered inline)

```markdown
See [@thm:main] for the proof.     --> "See Theorem 1 for the proof."
See [@sec:background].             --> "See Section 1.1."
```

### Narrative (bare @)

```markdown
@thm:main shows that...             --> "Theorem 1 shows that..."
```

### Clusters

Bibliography citations can be clustered with `;`:

```markdown
[@karger2000; @stein2001]
```

Simple standalone local references resolve from fenced-div `#id` values. Local targets take priority over bibliography entries with the same key. A mixed local/bibliography cluster remains literal source so Coflat does not silently discard either item.

### Cross-reference example

:::: {.theorem #thm:format-live title="Shared preview surfaces"}
Downstream renderers may resolve this FORMAT.md reference.
::::

Cross-reference example: [@thm:format-live].

## Citations

Set `bibliography:` in frontmatter and provide the editor host's `readTextResource(path)` callback. Paths are passed to the host exactly as written so it can resolve them relative to the current document. BibTeX (`.bib`), CSL JSON, and CSL YAML are supported; `csl:` optionally selects a style.

### Parenthetical

```markdown
See [@karger2000] for details.
Results from [@karger2000; @stein2001].
```

### With locators

```markdown
[@karger2000, p. 42]
[@karger2000, Theorem 3; @stein2001, Ch. 2]
```

### Narrative

```markdown
@karger2000 showed that...          --> "Karger [1] showed that..." (default IEEE style)
```

Citation formatting depends on the CSL style. Default: IEEE numeric (`[1]`, `[2]`). A bibliography section is automatically appended at the end of the document listing cited and `nocite` entries.

## Footnotes

```markdown
This has a footnote[^1].

[^1]: This is the footnote content with math $x^2$.
```

Footnote IDs can be any string: `[^note]`, `[^long-id]`. Rendered as sidenotes in the margin when space allows. Footnote definitions can appear anywhere in the document.

## Code Blocks

Fenced and Pandoc indented code blocks are both part of the fixed dialect.

````markdown
```haskell
fibonacci :: Int -> Int
fibonacci 0 = 0
fibonacci n = fibonacci (n-1) + fibonacci (n-2)
```
````

Language tag after opening fence enables syntax highlighting.

## Tables

Pipe-delimited tables with optional alignment:

```markdown
| Algorithm | Time          | Space       |
|-----------|---------------|-------------|
| Quicksort | $O(n \log n)$ | $O(\log n)$ |
| Mergesort | $O(n \log n)$ | $O(n)$      |
```

Alignment: `|:---|` left, `|:---:|` center, `|---:|` right. Math works inside table cells.

### Line breaks inside cells

Inline `<br>` forces a visible line break inside a cell. The LaTeX exporter maps `<br>` in a cell to `\newline` (within a `tabularx` column).

```markdown
| Case | Notes |
|------|-------|
| A    | first line<br>second line |
```

### Grid tables

Grid tables (pandoc `grid_tables`) are accepted as Pandoc-compatible raw/source blocks for cells that need multiple paragraphs or block content. Coflat preserves the grid-table source range for import/export and source-boundary operations, but grid tables are not parsed into Coflat's semantic live table model. Use pipe tables for editable semantic tables.

```markdown
+-------+------------------+
| Input | Output           |
+=======+==================+
| graph | first paragraph  |
|       |                  |
|       | second paragraph |
+-------+------------------+
```

## Lists

Ordered, unordered, and task lists. Math works inside list items:

```markdown
1. First item with $O(n \log n)$
2. Display math in list:
   $$
   T(n) = 2T(n/2) + O(n)
   $$

- Bullet with macros: $\R$, $\N$, $\Z$
- [ ] Unchecked task
- [x] Checked task
```

## Disabled Extensions

These extension-specific forms are disabled by the fixed dialect and remain literal text:

| Feature | Result | Alternative |
|---------|--------|-------------|
| `==mark==` | Literal text | Use emphasis or a host-level presentation feature |
| GitHub alerts | Ordinary blockquote content | Use a typed fenced div |
| `[[wikilinks]]` | Literal text | Use an inline or reference link |
| `:emoji:` shortcodes | Literal text | Use the Unicode character |
| Bare URL autolink (`https://example.com`) | Literal text | Use `[text](https://example.com)` or `<https://example.com>` |
| GFM-only math forms | Literal text | Use Pandoc dollar/backslash math delimiters |

## Horizontal Rules

```markdown
---
```

Three or more hyphens on a line. Must not be at the start of the document (where `---` is frontmatter). A blank line before `---` distinguishes it from frontmatter.

## LaTeX Export

The LaTeX export pipeline (`scripts/export-latex.mjs`, desktop PDF/LaTeX export, `src/editor/latex/`) emits a compilable `.tex` or `.pdf` file from a canonical Coflat Markdown document. The default `article` template is the Springer LNCS proceedings layout; `llncs.cls` must be installed by the TeX distribution. The existing `lipics` template remains available when selected explicitly.

1. **Prepare metadata** — preserve root frontmatter as Pandoc metadata and hoist supported export-only fields such as `math:` into Pandoc-compatible metadata.
2. **Pandoc** — invoked as:

   ```text
   pandoc --from markdown+tex_math_double_backslash+tex_math_single_backslash+latex_macros+raw_tex \
          --to latex --wrap=preserve --syntax-highlighting=none \
          --lua-filter=src/editor/latex/filter.lua \
          --template=src/editor/latex/template/<variant>.tex \
          --metadata=bibliography=<bib-name-without-.bib> \
          --output=out/<doc>.tex
   ```

3. **Compile** — `latexmk -pdf out/<doc>.tex` (optional; separate target).

### Block vocabulary mapping

Each built-in block maps to a LaTeX environment. Unknown classes are passed through as raw text.

| Fenced div class | LaTeX environment | Notes |
|------------------|-------------------|-------|
| `.theorem` | `theorem` | |
| `.lemma` | `lemma` | |
| `.corollary` | `corollary` | |
| `.proposition` | `proposition` | |
| `.conjecture` | `conjecture` | |
| `.definition` | `definition` | |
| `.problem` | `problem` | |
| `.equation` | `equation` | Sole display math becomes the environment body; `#id` → `\label` |
| `.example` | `example` | |
| `.remark` | `remark` | |
| `.proof` | `proof` | |
| `.algorithm` | `algorithm` | Body becomes pseudocode; title → `\caption`, `#id` → `\label` |
| `.algo` | `algorithm` + `coflatalgo` | Erickson-style tabbing box; indent deltas → `\+`/`\-`; title → `\caption`, `#id` → `\label` |
| `.figure` | `figure` | Multi-image → subfigures |
| `.table` | `table` + `tabularx` | Supports `<br>` → `\newline`, grid tables → multi-paragraph cells |
| `.blockquote` | `quote` | |

### Inline mapping

| Coflat markdown | LaTeX |
|-----------------|-------|
| `$...$` | `\(...\)` |
| `\(...\)` | `\(...\)` (passthrough) |
| `$$...$$` | `\[...\]` |
| `$$...$$ {#eq:id}` | display math followed by literal text; not a Coflat equation label |
| `==highlight==` | literal text (`mark` is disabled) |
| `[@id]` where `id` begins with an xref prefix | `\cref{id}` |
| `[@id]` otherwise | `\cite{id}` |
| `@id` where `id` begins with an xref prefix | `\cref{id}` (narrative form) |
| `- [ ] task` / `- [x] done` | `\item[$\square$]` / `\item[$\boxtimes$]` inside `itemize` |
| `<br>` inside a table cell | `\newline` |
| `<br>` outside a table | `\\` |

### Math macro injection

Frontmatter `math:` entries become `\newcommand` declarations in the preamble. The exporter detects argument arity by scanning the RHS for `#1`, `#2`, ...:

```yaml
math:
  R: "\\mathbb{R}"
  floor: "\\lfloor #1 \\rfloor"
```

→

```latex
\newcommand{\R}{\mathbb{R}}
\newcommand{\floor}[1]{\lfloor #1 \rfloor}
```

The LaTeX importer recognizes the same exported `\newcommand` shape, plus
`\renewcommand`, `\def`, `\let`, and `\DeclareMathOperator`, and maps used
macros back into frontmatter `math:`.

### Template variants

- `template/article.tex` — default Springer LNCS proceedings layout (`\documentclass[runningheads,envcountsame]{llncs}`), with LNCS title metadata, theorem environments, `cleveref`, tables, figures, and algorithms.
- `template/lipics.tex` — LIPIcs submissions; consumes article metadata plus LIPIcs-specific template metadata (`author`/`authors`, `ccsdesc`, `keywords`, `copyright`, `titlerunning`, `authorrunning`, `funding`, `acknowledgements`, `category`, `relatedversion`).

Select a variant with `scripts/export-latex.mjs --template lipics` or by setting `latex.template: lipics` in frontmatter. `latex.bibliography` overrides the top-level `bibliography` value for LaTeX export; command-line `--template` and `--bibliography` flags override frontmatter in the CLI.
