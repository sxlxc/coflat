import { parseInlines } from "../inline/parser.js";
import type { GreenNode } from "../nodes.js";

interface SourceSpan {
  readonly from: number;
  readonly to: number;
}

const PIPE = 124;
const PIPE_PROTECTED_KINDS: ReadonlySet<GreenNode["kind"]> = new Set([
  "Code",
  "Escape",
  "HtmlTag",
  "Math",
  "RawInline",
]);

function protectedPipeSpans(
  nodes: readonly GreenNode[],
  offset: number,
  spans: SourceSpan[],
): number {
  let cursor = offset;
  for (const node of nodes) {
    const end = cursor + node.length;
    if (PIPE_PROTECTED_KINDS.has(node.kind)) {
      spans.push({ from: cursor, to: end });
    } else if (node.children.length > 0) {
      protectedPipeSpans(node.children, cursor, spans);
    }
    cursor = end;
  }
  return cursor;
}

/**
 * Pipe characters which delimit cells rather than belonging to inline syntax.
 * Reusing the inline parser keeps code, escape, and every supported math
 * delimiter in sync with the CST grammar.
 */
export function tablePipePositions(text: string): readonly number[] {
  const protectedSpans: SourceSpan[] = [];
  protectedPipeSpans(parseInlines(text), 0, protectedSpans);

  const positions: number[] = [];
  let spanIndex = 0;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) !== PIPE) continue;
    while (
      protectedSpans[spanIndex]
      && cursor >= protectedSpans[spanIndex]!.to
    ) spanIndex += 1;
    const span = protectedSpans[spanIndex];
    if (!span || cursor < span.from || cursor >= span.to) positions.push(cursor);
  }
  return positions;
}
