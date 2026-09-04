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

`--cf-content-max-width` is the usable text measure; responsive inline padding
is added outside that width. The default document scale is 18px with a 1.4 line
height, 1em headings from h3 downward, 1.2em h2, 1.44em h1, and a 1.728em
normal-weight paper title (`.cf-doc-title`). Headings h1 through h5 are bold.

`@chaoxu/coflat/document-surface.css` contains the reusable document tokens and
KaTeX surface styles. `@chaoxu/coflat/themes/blueprint-book.css` is an optional
preset.
