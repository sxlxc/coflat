import { EditorView } from "@codemirror/view";

const sourceText = {
  color: "var(--cf-muted)",
  fontFamily: "var(--cf-code-font)",
  fontSize: "0.86em",
  fontStyle: "normal",
  fontWeight: "400",
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
    maxWidth: "var(--cf-content-max-width)",
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
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--cf-selection)",
  },
  ".cm-activeLine, .cf-cst-active-line": {
    backgroundColor: "transparent",
  },
  ".cf-heading-line-1": {
    fontSize: "2em",
    fontWeight: "700",
    lineHeight: "1.2",
  },
  ".cf-heading-line-2": {
    fontSize: "1.5em",
    fontWeight: "700",
    lineHeight: "1.25",
  },
  ".cf-heading-line-3": {
    fontSize: "1.25em",
    fontWeight: "650",
  },
  ".cf-heading-line-4, .cf-heading-line-5, .cf-heading-line-6": {
    fontWeight: "650",
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
    fontWeight: "650",
  },
  ".tok-string": {
    fontStyle: "italic",
  },
});

export const coflatDarkTheme = EditorView.theme(
  { "&": { colorScheme: "dark" } },
  { dark: true },
);
