import type { Tree } from "@lezer/common";
import { parsePandocCstSource } from "../../core/cst/pandoc-syntax-tree";

/**
 * Standalone semantic analysis parser backed by pandocmd-cst. The startParse
 * shape is retained only for old analysis tests; CST parsing is synchronous
 * and complete, so stopAt cannot create a production parse frontier.
 */
export const markdownSemanticsParser = {
  parse: parsePandocCstSource,
  startParse(source: string) {
    let result: Tree | null = null;
    return {
      get parsedPos() { return result?.length ?? 0; },
      stopAt(_position: number): void {},
      advance(): Tree {
        return result ??= parsePandocCstSource(source);
      },
    };
  },
};
