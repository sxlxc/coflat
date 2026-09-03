/**
 * Shared class names used by the editable CM6 surface and its math widgets.
 */

export const DOCUMENT_SURFACE_CLASS = {
  surface: "cf-doc-surface",
  flow: "cf-doc-flow",
  heading: "cf-doc-heading",
  headingLevel: (level: number) => `cf-doc-heading--h${level}`,
  inlineMath: "cf-doc-inline-math",
  displayMath: "cf-doc-display-math",
} as const;

export function documentSurfaceClassNames(
  ...classNames: Array<string | false | null | undefined>
): string {
  return classNames.filter(Boolean).join(" ");
}
