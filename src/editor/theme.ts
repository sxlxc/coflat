import { EditorView } from "@codemirror/view";
import { CSS } from "../core/constants/css-classes";

const sourceTypography = {
  color: "var(--cf-fg)",
  fontFamily: "var(--cf-code-font)",
  fontSize: "0.86em",
} as const;

const sourceText = {
  ...sourceTypography,
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
  ".cm-tooltip": {
    backgroundColor: "var(--cf-bg)",
    border: "1px solid var(--cf-border)",
    borderRadius: "6px",
    boxShadow: "0 4px 16px #0002",
    color: "var(--cf-fg)",
    fontFamily: "var(--cf-code-font)",
    fontSize: "14px",
    lineHeight: "1.5",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "inherit",
    maxWidth: "min(38rem, 90vw)",
    minWidth: "min(16rem, 80vw)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    lineHeight: "1.5",
    padding: "4px 8px",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--cf-selection)",
    color: "var(--cf-fg)",
  },
  ".cm-completionDetail": {
    color: "var(--cf-muted)",
    fontSize: "0.85em",
    fontStyle: "normal",
    marginLeft: "1em",
  },
  ".cm-tooltip.cm-completionInfo": {
    maxWidth: "min(28rem, 80vw)",
    padding: "10px 12px",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  // Keep stacked completion details inside the menu's border even when CM's
  // viewport measurements round a fractional menu width.
  ".cm-completionInfo.cm-completionInfo-right-narrow": {
    right: "4px",
    width: "auto",
  },
  ".cm-completionInfo.cm-completionInfo-left-narrow": {
    left: "4px",
    width: "auto",
  },
  [`.${CSS.referencePreview}`]: {
    boxSizing: "border-box",
    maxWidth: "min(32rem, 90vw)",
    maxHeight: "min(24rem, 60vh)",
    overflowY: "auto",
    overflowWrap: "anywhere",
    padding: "10px 14px",
    fontFamily: "var(--cf-content-font)",
    fontSize: "16px",
  },
  [`.${CSS.referencePreview} section + section`]: {
    borderTop: "1px solid var(--cf-border)",
    marginTop: "10px",
    paddingTop: "10px",
  },
  [`.${CSS.referencePreview} p`]: {
    margin: "6px 0 0",
    whiteSpace: "pre-wrap",
  },
  [`.${CSS.referencePreview} small`]: {
    color: "var(--cf-muted)",
    display: "block",
    fontFamily: "var(--cf-code-font)",
  },
  // CM6's positioning rectangle follows browser caret metrics, which Firefox
  // expands to the full line height on an empty row. Keep that rectangle for
  // placement, but paint a fixed text-height cursor at its center.
  ".cm-cursor": {
    borderLeft: "0",
  },
  ".cm-cursor::after": {
    borderLeft: "1.2px solid var(--cf-fg)",
    content: "\"\"",
    height: "1.2em",
    left: "0",
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
  },
  // CM6's synthetic multi-line rectangles fill out to the content edges.
  // Keep its cursor layer, but paint each selection over its actual text.
  ".cm-selectionLayer .cm-selectionBackground": {
    display: "none",
  },
  [`.${CSS.selectionRange}`]: {
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
  ".cm-line.cf-doc-heading[data-section-number]::before": {
    content: "attr(data-section-number) '.\\2002'",
    fontWeight: "400",
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
  [`.${CSS.inlineNoBreak}`]: {
    display: "inline-flex",
    alignItems: "last baseline",
    maxWidth: "100%",
    whiteSpace: "nowrap",
  },
  [`.${CSS.inlineNoBreak} .cf-math-inline, .${CSS.inlineNoBreak} .${CSS.citation}, .${CSS.inlineNoBreak} .${CSS.fencedDivReference}`]: {
    // Let content shrink and wrap while reserving space for the source punctuation.
    minWidth: "0",
    whiteSpace: "normal",
  },
  ".cm-line.cf-table-source, .cm-line.cf-math-source-line": {
    ...sourceTypography,
    backgroundColor: "var(--cf-subtle)",
  },
  ".cf-table-source .tok-punctuation, .cf-table-source .tok-meta": {
    color: "inherit",
  },
  ".cf-math-source-line .cf-math-source, .cf-math-source-line .cf-source-delimiter": {
    fontSize: "inherit",
  },
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
