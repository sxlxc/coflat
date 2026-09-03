/**
 * Parse a Pandoc table delimiter row into per-column alignments.
 * Table structure itself is owned by pandocmd-cst.
 */
export function parseTableDelimiterAlignments(
  delimiterRow: string,
): ("center" | "left" | "right" | null)[] {
  return delimiterRow
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map(cell => cell.trim())
    .map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return null;
    });
}

/** @deprecated Markdown parsing is owned by pandocmd-cst. */
export const tableExtension = undefined as never;
