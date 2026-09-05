import {
  DOCUMENT_SURFACE_CLASS,
  documentSurfaceClassNames,
} from "../document-surface-classes";

export function mathSurfaceClassNames(
  isDisplay: boolean,
  ...classNames: Array<string | false | null | undefined>
): string {
  return documentSurfaceClassNames(
    isDisplay
      ? DOCUMENT_SURFACE_CLASS.displayMath
      : DOCUMENT_SURFACE_CLASS.inlineMath,
    isDisplay ? "cf-math-display" : "cf-math-inline",
    ...classNames,
  );
}

/** Class names used by the small CST-backed editing surface. */
export const CSS = {
  selectionRange: "cf-selection-range",
  headingLine: (level: number) => `cf-heading-line-${level}`,
  headingSourceHidden: "cf-heading-source-hidden",
  bold: "cf-bold",
  italic: "cf-italic",
  strikethrough: "cf-strikethrough",
  inlineCode: "cf-inline-code",
  linkRendered: "cf-link-rendered",
  listBullet: "cf-list-bullet",
  blockquoteMark: "cf-blockquote-mark",
  yamlMetadataHeader: "cf-yaml-metadata-header",
  yamlToggle: "cf-yaml-toggle",
  yamlSource: "cf-yaml-source",
  yamlHidden: "cf-yaml-hidden",
  fencedDivHeader: "cf-fenced-div-header",
  fencedDivSource: "cf-fenced-div-source",
  fencedDivReference: "cf-fenced-div-reference",
  citation: "cf-citation",
  citationNarrative: "cf-citation-narrative",
  bibliography: "cf-bibliography",
  bibliographyHeading: "cf-bibliography-heading",
  bibliographyList: "cf-bibliography-list",
  bibliographyEntry: "cf-bibliography-entry",
  sourceDelimiter: "cf-source-delimiter",
  inlineSource: "cf-inline-source",
  mathSource: "cf-math-source",
  tableSource: "cf-table-source",
  mathError: "cf-math-error",
  mathDisplayContent: "cf-math-display-content",
  mathDisplayNumbered: "cf-math-display-numbered",
  mathDisplayNumber: "cf-math-display-number",
  blockQed: "cf-block-qed",
} as const;
