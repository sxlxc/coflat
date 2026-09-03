import type { LanguageDescription } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { pandocCstField, pandocCstHighlighting } from "./cst";
import {
  type ProjectConfig,
  type ProjectConfigStatus,
  projectConfigFacet,
  projectConfigStatusFacet,
} from "./project-config";

export { sharedInlineRenderExtensions } from "./render/inline-render-extensions";

// Inline editors use the same semantic Markdown profile as inactive inline
// rendering (`parseInlineFragments`) and the rich editor. Keeping this as an
// alias prevents table cells/block-title editing from drifting when FORMAT
// syntax extensions are added.
export const inlineMarkdownExtensions: readonly unknown[] = Object.freeze([]);

export function createProjectConfigExtensions(
  projectConfig?: ProjectConfig,
  projectConfigStatus?: ProjectConfigStatus,
): Extension[] {
  const extensions: Extension[] = [];
  if (projectConfig) extensions.push(projectConfigFacet.of(projectConfig));
  if (projectConfigStatus) extensions.push(projectConfigStatusFacet.of(projectConfigStatus));
  return extensions;
}

interface MarkdownLanguageOptions {
  extensions?: readonly unknown[];
  codeLanguages?: readonly LanguageDescription[];
  syntaxHighlighting?: boolean;
}

export function createMarkdownLanguageExtensions({
  extensions = inlineMarkdownExtensions,
  codeLanguages,
  syntaxHighlighting: includeSyntaxHighlighting = false,
}: MarkdownLanguageOptions = {}): Extension[] {
  // The option shape remains source-compatible during M6, but Markdown
  // structure now comes exclusively from the synchronous Pandoc CST field.
  void extensions;
  void codeLanguages;
  const languageExtensions: Extension[] = [pandocCstField];

  if (includeSyntaxHighlighting) {
    languageExtensions.push(pandocCstHighlighting);
  }

  return languageExtensions;
}
