/** Test/source compatibility helpers retained after the `.algo` parser retired. */
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

/** @deprecated `.algo` is outside the fixed Pandoc dialect. */
export const algoLineExtension = undefined as never;
