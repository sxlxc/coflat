interface SourceRange {
  readonly from: number;
  readonly to: number;
}

const locationSelector = "[data-loc-start][data-loc-end]";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function sourceRange(element: Element, sourceLength: number): SourceRange | null {
  const from = Number(element.getAttribute("data-loc-start"));
  const to = Number(element.getAttribute("data-loc-end"));
  return Number.isInteger(from) && Number.isInteger(to)
    && from >= 0 && to > from && to <= sourceLength ? { from, to } : null;
}

/** Map rendered KaTeX geometry to an offset in its original, unexpanded TeX. */
export function mathSourceOffsetFromPointer(
  surface: HTMLElement,
  event: MouseEvent,
  source: string,
): number {
  const target = event.target instanceof Element ? event.target : null;
  // Generated rules and SVG shapes belong to their enclosing TeX command.
  const shape = target?.closest("svg, .frac-line, .overline-line, .underline-line");
  const command = shape?.closest(locationSelector);
  if (command && surface.contains(command)) {
    const range = sourceRange(command, source.length);
    if (range) return range.from;
  }

  let bestOffset: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestArea = Number.POSITIVE_INFINITY;
  const consider = (rect: DOMRect, from: number, to: number): void => {
    if (rect.width <= 0 || rect.height <= 0) return;
    const dx = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right);
    const dy = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom);
    const distance = dx * dx + dy * dy;
    const area = rect.width * rect.height;
    if (distance < bestDistance || (distance === bestDistance && area < bestArea)) {
      bestDistance = distance;
      bestArea = area;
      bestOffset = event.clientX <= (rect.left + rect.right) / 2 ? from : to;
    }
  };

  for (const element of surface.querySelectorAll(locationSelector)) {
    if (element.querySelector(locationSelector)) continue;
    const location = sourceRange(element, source.length);
    if (!location) continue;
    const text = element.textContent ?? "";
    const original = source.slice(location.from, location.to);
    // KaTeX combines literal runs and changes ordinary text spaces to NBSP.
    // Commands and macro expansions stay atomic, even when they render letters.
    if (text && text.replaceAll("\u00a0", " ") === original) {
      const walker = surface.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let textFrom = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.textContent ?? "";
        for (const { segment, index } of graphemes.segment(value)) {
          const range = surface.ownerDocument.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + segment.length);
          for (const rect of range.getClientRects()) {
            consider(rect, location.from + textFrom + index, location.from + textFrom + index + segment.length);
          }
        }
        textFrom += value.length;
      }
    } else {
      for (const rect of element.getClientRects()) {
        consider(rect, location.from, location.to);
      }
    }
  }
  if (bestOffset !== null) return bestOffset;

  // Invalid TeX and some KaTeX output have no usable source locations.
  const rect = surface.getBoundingClientRect();
  const fraction = rect.width > 0
    ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    : 0;
  const offset = source.length * fraction;
  for (const { segment, index } of graphemes.segment(source)) {
    const end = index + segment.length;
    if (offset <= end) return offset < (index + end) / 2 ? index : end;
  }
  return source.length;
}
