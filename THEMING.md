# Coflat theming

Import `@chaoxu/coflat/style.css` once and mount the editor inside an optional
`.cf-theme-scope` container. Coflat's visual contract is the `--cf-*` custom
property family plus stable `cf-*` document classes.

```css
.workspace .cf-theme-scope {
  --cf-content-max-width: 48rem;
  --cf-base-font-size: 17px;
  --cf-accent: #3157a4;
}
```

The editor keeps authored Markdown in CM6. Themes may change presentation but
must not hide the caret, disable source selection, or make any content
mouse-only. Cursor-sensitive CST decorations reveal source markup when a user
enters a structured inline node.

Revealed inline source uses the monospace font with `--cf-fg` text on the normal document background. Only block source editing (display math, tables, YAML, and code blocks) uses full `--cf-subtle` rows. Fenced-div closing fences are hidden unless the selection touches them; revealed fences and openers use `--cf-muted` monospace text. While the selection is inside a fenced div, `.cf-fenced-div-range` draws a continuous `--cf-border` bar in the left margin; nested divs have separate bars. Closed proof divs display a `.cf-block-qed` tombstone on the final nonblank content line (or immediately after its block preview), including while their closing fence is being edited.

Selections use `--cf-selection`, which defaults to macOS-style light blue. Source spans have no opaque fill that could cover the selected text. Rendered inline math and references keep immediately following closing punctuation on the same visual line using a `.cf-inline-no-break` wrapper. Long rendered content wraps within the editor width, with punctuation beside its final visual line. This is presentation only: punctuation remains selectable source, and entering the inline node restores normal source wrapping.

Completion menus and `.cf-reference-preview` tooltips use the same `--cf-bg`, `--cf-fg`, `--cf-border`, `--cf-muted`, and `--cf-selection` tokens. Their width is bounded by the viewport, and long reference previews scroll within the popup.

`--cf-content-max-width` is the usable text measure; responsive inline padding
is added outside that width. The default document scale is 18px with a 1.4 line
height, 1em headings from h3 downward, 1.2em h2, 1.44em h1, and a 1.728em
normal-weight, centered paper title (`.cf-doc-title`). Headings h1 through h5
are bold.

`@chaoxu/coflat/document-surface.css` contains the reusable document tokens and
KaTeX surface styles. `@chaoxu/coflat/themes/blueprint-book.css` is an optional
preset.
