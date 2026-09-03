/** Source-level fenced-div utilities; structural parsing belongs to pandocmd-cst. */

/** Count consecutive colons starting at `pos`. */
export function countColons(text: string, pos: number): number {
  let count = 0;
  while (text[pos + count] === ":") count++;
  return count;
}

export function closingFenceColonCountAt(text: string, pos: number): number {
  while (text[pos] === " " || text[pos] === "\t") pos++;
  const count = countColons(text, pos);
  if (count < 3) return -1;
  return text.slice(pos + count).trim().length === 0 ? count : -1;
}

export function closingFenceColonCountLine(text: string): number {
  return closingFenceColonCountAt(text, 0);
}

/** @deprecated Markdown parsing is owned by pandocmd-cst. */
export const fencedDiv = undefined as never;
