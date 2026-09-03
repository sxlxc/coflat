export { countColons } from "./fenced-div";
export type { FencedDivAttrs } from "./fenced-div-attrs";
export { extractDivClass, parseFencedDivAttrs } from "./fenced-div-attrs";
export {
  type BlockConfig,
  extractRawFrontmatter,
  type FrontmatterConfig,
  type FrontmatterResult,
  type FrontmatterStatus,
  parseFrontmatter,
} from "./frontmatter";
import { Parser, type Input, type PartialParse, type Tree, type TreeFragment } from "@lezer/common";
import { parsePandocCstSource } from "../cst/pandoc-syntax-tree";

/**
 * M6 compatibility values for callers that still pass an `extensions` option
 * to CodeMirror's Markdown package in test-only feature harnesses. They are
 * deliberately empty: shipped Markdown structure comes from pandocmd-cst.
 */
export const coflatSharedMarkdownExtensions: readonly never[] = Object.freeze([]);
export const semanticOnlyMarkdownExtensions = coflatSharedMarkdownExtensions;
export const markdownExtensions = coflatSharedMarkdownExtensions;
export const htmlRenderExtensions = coflatSharedMarkdownExtensions;

// Source-compatible names for old test harnesses during their removal. These
// are not parser configurations and are never installed by the editor.
const retiredMarkdownExtension = undefined as never;
export const algoLineExtension = retiredMarkdownExtension;
export const equationLabelExtension = retiredMarkdownExtension;
export const fencedDiv = retiredMarkdownExtension;
export const footnoteExtension = retiredMarkdownExtension;
export const highlightExtension = retiredMarkdownExtension;
export const mathExtension = retiredMarkdownExtension;
export const removeBlockquote = retiredMarkdownExtension;
export const removeIndentedCode = retiredMarkdownExtension;
export const strikethroughExtension = retiredMarkdownExtension;
export const tableExtension = retiredMarkdownExtension;

export function algoLineIndentUnits(lineText: string): number {
  let units = 0;
  for (const char of lineText) {
    if (char === " ") units += 1;
    else if (char === "\t") units += 2;
    else break;
  }
  return units;
}

export function algoLineIndentDepth(lineText: string): number {
  return Math.floor(algoLineIndentUnits(lineText) / 2);
}

export type MarkdownParserMode = "semantic" | "html-render";

class PandocCstTraversalParser extends Parser {
  configure(_extensions?: unknown): PandocCstTraversalParser { return this; }

  createParse(
    input: Input,
    _fragments: readonly TreeFragment[],
    _ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    const tree = parsePandocCstSource(input.read(0, input.length));
    let done = false;
    let stoppedAt: number | null = null;
    return {
      get parsedPos() { return done ? tree.length : 0; },
      get stoppedAt() { return stoppedAt; },
      stopAt(position: number) { stoppedAt = position; },
      advance(): Tree | null {
        if (done) return null;
        done = true;
        return tree;
      },
    };
  }
}

const markdownParser = new PandocCstTraversalParser();

export function getMarkdownParser(mode: MarkdownParserMode = "semantic"): Parser & { configure(_extensions?: unknown): Parser } {
  void mode;
  return markdownParser;
}

export function parsePandocTraversalSource(source: string, mode: MarkdownParserMode = "semantic"): Tree {
  return getMarkdownParser(mode).parse(source);
}
