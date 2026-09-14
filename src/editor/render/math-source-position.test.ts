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
    String.raw`\verb|\alpha|`,
    String.raw`\verb*|\alpha|`,
    String.raw`\verb!\alpha!`,
    String.raw`\verb*z\alphaz`,
    "\\verb\\alpha\\",
    String.raw`\verb+\verb|\alpha|+`,
  ])("keeps literal character offsets inside %s", (source) => {
    const surface = surfaceWithGeometry();
    surface.innerHTML = renderKatexToHtml(source, false, {}, "html");
    expect(surface.querySelector("[data-loc-start]")).toBeNull();
    const from = source.indexOf("alpha");
    for (let offset = from; offset <= from + 5; offset++) {
      expect(offsetAt(surface, source, 100 + 100 * offset / source.length)).toBe(offset);
    }
    // Only the actual command word remains atomic, not its verbatim payload.
    expect(offsetAt(surface, source, 100 + 300 / source.length)).toBe(5);
  });

  it("still snaps commands following verbatim text", () => {
    const surface = surfaceWithGeometry();
    const source = String.raw`\verb|\alpha|\beta`;
    surface.textContent = source;
    expect(offsetAt(surface, source, 100 + 100 * 15 / source.length)).toBe(13);
    expect(offsetAt(surface, source, 100 + 100 * 16 / source.length)).toBe(18);
  });

  it("does not treat an escaped backslash as a verbatim opener", () => {
    const surface = surfaceWithGeometry();
    const source = String.raw`\\verb|\alpha|`;
    surface.textContent = source;
    expect(offsetAt(surface, source, 100 + 100 * 9 / source.length)).toBe(7);
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

  it.each([
    ["\\alpha\u0301{", 150, 7],
    ["\\alpha\u0301", 160, 7],
    ["\\alpha\u0301\u0300{", 150, 8],
    ["\u0600\\alpha{", 125, 0],
  ] as const)("keeps command snapping on grapheme boundaries in %s", (source, clientX, expected) => {
    const surface = surfaceWithGeometry();
    surface.innerHTML = renderKatexToHtml(source, false, {}, "html");
    expect(surface.querySelector("[data-loc-start]")).toBeNull();
    expect(offsetAt(surface, source, clientX)).toBe(expected);

    const boundaries = new Set([source.length, ...Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(source),
      ({ index }) => index,
    )]);
    for (let x = 100; x <= 200; x++) {
      expect(boundaries.has(offsetAt(surface, source, x))).toBe(true);
    }
  });

  it("uses geometry when mapped elements have no visible rectangles", () => {
    const surface = surfaceWithGeometry();
    surface.innerHTML = renderKatexToHtml(String.raw`\alpha`, false, {}, "html");
    expect(surface.querySelector("[data-loc-start]")).not.toBeNull();
    // The proportional guess lands inside \alpha and snaps to its end.
    expect(offsetAt(surface, String.raw`\alpha`, 190)).toBe(6);
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

  it("keeps unmapped command words atomic in the proportional fallback", () => {
    const surface = surfaceWithGeometry();
    surface.textContent = String.raw`\operatorname{rank}`;
    // Clicks that proportionally land inside \operatorname snap to its ends;
    // positions inside the argument stay exact.
    expect(offsetAt(surface, String.raw`\operatorname{rank}`, 110)).toBe(0);
    expect(offsetAt(surface, String.raw`\operatorname{rank}`, 135)).toBe(13);
    expect(offsetAt(surface, String.raw`\operatorname{rank}`, 150)).toBe(13);
    expect(offsetAt(surface, String.raw`\operatorname{rank}`, 190)).toBe(17);
  });

  it("snaps control symbols out of the fallback", () => {
    const surface = surfaceWithGeometry();
    const source = String.raw`a\,b`;
    surface.textContent = source;
    expect(offsetAt(surface, source, 120)).toBe(1);
    expect(offsetAt(surface, source, 155)).toBe(1);
    expect(offsetAt(surface, source, 165)).toBe(3);
  });

  it("handles empty source and surfaces with no width", () => {
    const surface = surfaceWithGeometry();
    expect(offsetAt(surface, "", 190)).toBe(0);
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect());
    expect(offsetAt(surface, "x^{", 190)).toBe(0);
  });
});
