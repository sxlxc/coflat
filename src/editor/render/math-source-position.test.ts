import { describe, expect, it, vi } from "vitest";
import { renderKatexToHtml } from "./katex-render";
import { mathSourceOffsetFromPointer } from "./math-source-position";

function surfaceWithGeometry(): HTMLElement {
  const surface = document.createElement("div");
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 20, 100, 20));
  return surface;
}

function offsetAt(surface: HTMLElement, source: string, clientX: number): number {
  return mathSourceOffsetFromPointer(surface, new MouseEvent("click", { clientX, clientY: 30 }), source);
}

describe("math pointer placement without source locations", () => {
  it.each([
    ["x^{", 0, 2, 3],
    [String.raw`\verb|abc|`, 0, 5, 10],
  ] as const)("uses geometry for unmapped output from %s", (source, start, middle, end) => {
    const surface = surfaceWithGeometry();
    if (source === "x^{") {
      surface.textContent = source;
    } else {
      surface.innerHTML = renderKatexToHtml(source, false, {}, "html");
    }
    expect(surface.querySelector("[data-loc-start]")).toBeNull();
    expect(offsetAt(surface, source, 90)).toBe(start);
    expect(offsetAt(surface, source, 150)).toBe(middle);
    expect(offsetAt(surface, source, 210)).toBe(end);
  });

  it.each([
    ["中文😀x^{", 140, 2],
    ["中文😀x^{", 145, 4],
    ["xe\u0301^{", 135, 1],
    ["xe\u0301^{", 145, 3],
  ] as const)("keeps the fallback on grapheme boundaries in %s at %i", (source, clientX, expected) => {
    const surface = surfaceWithGeometry();
    surface.textContent = source;
    expect(offsetAt(surface, source, clientX)).toBe(expected);
  });

  it("uses geometry when mapped elements have no visible rectangles", () => {
    const surface = surfaceWithGeometry();
    surface.innerHTML = renderKatexToHtml(String.raw`\alpha`, false, {}, "html");
    expect(surface.querySelector("[data-loc-start]")).not.toBeNull();
    expect(offsetAt(surface, String.raw`\alpha`, 190)).toBe(5);
  });

  it("preserves a mapped offset of zero even when the fallback would choose the end", () => {
    const surface = surfaceWithGeometry();
    surface.innerHTML = renderKatexToHtml(String.raw`\alpha`, false, {}, "html");
    const symbol = surface.querySelector("[data-loc-start]");
    if (!symbol) throw new Error("Missing mapped symbol");
    const rects = [new DOMRect(180, 20, 20, 20)];
    vi.spyOn(symbol, "getClientRects").mockReturnValue(Object.assign(rects, {
      item: (index: number) => rects[index] ?? null,
    }));
    expect(offsetAt(surface, String.raw`\alpha`, 185)).toBe(0);
  });

  it("handles empty source and surfaces with no width", () => {
    const surface = surfaceWithGeometry();
    expect(offsetAt(surface, "", 190)).toBe(0);
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect());
    expect(offsetAt(surface, "x^{", 190)).toBe(0);
  });
});
