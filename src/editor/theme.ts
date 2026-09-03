import { EditorView } from "@codemirror/view";

const sourceText = {
  color: "var(--cf-muted)",
  fontFamily: "var(--cf-code-font)",
  fontSize: "0.86em",
  fontStyle: "normal",
  fontWeight: "400",
  lineHeight: "0",
  verticalAlign: "baseline",
} as const;

/** Minimal Coflat theme for the single CST-backed editor. */
export const coflatTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--cf-bg)",
    color: "var(--cf-fg)",
    fontFamily: "var(--cf-content-font)",
    fontSize: "var(--cf-base-font-size)",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "var(--cf-line-height)",
    overflow: "auto",
  },
  ".cm-content": {
    boxSizing: "border-box",
    caretColor: "var(--cf-fg)",
    marginInline: "auto",
    maxWidth:
      "calc(var(--cf-content-max-width) + 2 * var(--cf-doc-content-padding-inline))",
    minHeight: "100%",
    padding: "var(--cf-content-padding)",
    width: "100%",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--cf-fg)",
  },
  // CM6's synthetic multi-line rectangles fill out to the content edges.
  // Keep its cursor layer, but paint each selection over its actual text.
  ".cm-selectionLayer .cm-selectionBackground": {
    display: "none",
  },
  ".cf-selection-range": {
    backgroundColor: "var(--cf-selection)",
  },
  ".cm-activeLine, .cf-cst-active-line": {
    backgroundColor: "transparent",
  },
  ".cf-heading-line-1": {
    fontSize: "var(--cf-h1-size, 1.44em)",
    fontWeight: "var(--cf-h1-weight, 700)",
    lineHeight: "1.2",
  },
  ".cf-heading-line-2": {
    fontSize: "var(--cf-h2-size, 1.2em)",
    fontWeight: "var(--cf-h2-weight, 700)",
    lineHeight: "1.25",
  },
  ".cf-heading-line-3": {
    fontSize: "var(--cf-h3-size, 1em)",
    fontWeight: "var(--cf-h3-weight, 700)",
  },
  ".cf-heading-line-4": {
    fontSize: "var(--cf-h4-size, 1em)",
    fontWeight: "var(--cf-h4-weight, 700)",
  },
  ".cf-heading-line-5": {
    fontSize: "var(--cf-h5-size, 1em)",
    fontWeight: "var(--cf-h5-weight, 700)",
  },
  ".cf-heading-line-6": {
    fontSize: "var(--cf-h6-size, 1em)",
    fontWeight: "var(--cf-h6-weight, 400)",
  },
  // CM6 brackets an inline replacement with 1em, text-top widget buffers.
  // Firefox otherwise lets those buffers enlarge an inactive heading's line
  // box, then shrinks the row when the replacement is revealed as source.
  ".cf-heading-source-hidden .cm-widgetBuffer": {
    height: "0",
    verticalAlign: "baseline",
  },
  ".cf-bold, .tok-strong": {
    fontWeight: "700",
  },
  ".cf-italic, .tok-emphasis": {
    fontStyle: "italic",
  },
  ".cf-strikethrough, .tok-strikethrough": {
    textDecoration: "line-through",
  },
  ".cf-inline-code, .tok-monospace": {
    fontFamily: "var(--cf-code-font)",
    fontSize: "0.9em",
  },
  ".cf-link-rendered, .tok-link, .tok-url": {
    color: "var(--cf-accent)",
    textDecoration: "underline",
    textDecorationStyle: "dotted",
    textUnderlineOffset: "0.16em",
  },
  ".cf-source-delimiter, .cf-inline-source, .cf-math-source": sourceText,
  ".tok-punctuation, .tok-meta": {
    color: "var(--cf-muted)",
  },
  ".tok-heading": {
    fontWeight: "inherit",
  },
  ".tok-string": {
    fontStyle: "italic",
  },
});

export const coflatDarkTheme = EditorView.theme(
  { "&": { colorScheme: "dark" } },
  { dark: true },
);
