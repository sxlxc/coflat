import { describe, expect, it } from "vitest";
import { renderKatexToHtml } from "./katex-render";

function rendered(source: string, macros: Readonly<Record<string, string>> = {}): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = renderKatexToHtml(source, false, macros, "html");
  return element;
}

function mappedText(element: HTMLElement, text: string): HTMLElement {
  const match = [...element.querySelectorAll<HTMLElement>("[data-loc-start]")].find(
    (node) => node.textContent === text && !node.querySelector("[data-loc-start]"),
  );
  if (!match) throw new Error(`Missing mapped text: ${text}`);
  return match;
}

function expectRange(element: HTMLElement, from: number, to: number): void {
  expect(element.dataset.locStart).toBe(String(from));
  expect(element.dataset.locEnd).toBe(String(to));
}

describe("KaTeX source locations", () => {
  it.each([
    ["x+1234", "1234", 2, 6],
    ["x^{1234}", "1234", 3, 7],
    [String.raw`\text{hello world}`, "hello\u00a0world", 6, 17],
    [String.raw`\mathbb{R}`, "R", 8, 9],
    [String.raw`\alpha+\beta`, "β", 7, 12],
    ["\n\\alpha+\\beta\n", "β", 8, 13],
    [String.raw`\text{中文😀}`, "😀", 8, 10],
  ] as const)("preserves original character ranges in %s", (source, text, from, to) => {
    expectRange(mappedText(rendered(source), text), from, to);
  });

  it("maps each expansion to its own invocation without mutating shared macros", () => {
    const macros = Object.freeze({ "\\R": String.raw`\mathbb{R}` });
    const source = String.raw`x+\R+y+\R`;
    const element = rendered(source, macros);
    const symbols = element.querySelectorAll<HTMLElement>(".mathbb");
    expect(symbols).toHaveLength(2);
    expectRange(symbols[0], 2, 4);
    expectRange(symbols[1], 7, 9);
    expect(macros).toEqual({ "\\R": String.raw`\mathbb{R}` });
  });

  it("excludes ignored trailing whitespace from a macro invocation", () => {
    expectRange(mappedText(rendered("\\R  + x", { "\\R": String.raw`\mathbb{R}` }), "R"), 0, 2);
  });

  it.each([
    ["", { "\\sq": "#1^2" }],
    [String.raw`\def\sq#1{#1^2}`, {}],
    ["", { "\\sq": String.raw`\power{#1}`, "\\power": "#1^2" }],
  ])("keeps macro arguments separate from generated symbols with prefix %s", (prefix, macros) => {
    const source = `${prefix}x+\\sq{z}+y`;
    const element = rendered(source, macros);
    expectRange(mappedText(element, "z"), source.indexOf("{z}") + 1, source.indexOf("{z}") + 2);
    const call = source.lastIndexOf("\\sq");
    expectRange(mappedText(element, "2"), call, call + 3);
  });

  it.each([
    [String.raw`\frac{a}{b}`, ".frac-line", 5],
    [String.raw`\sqrt{x}`, "svg", 5],
  ])("maps generated shapes to their command in %s", (source, selector, end) => {
    const command = rendered(source).querySelector(selector)?.closest<HTMLElement>("[data-loc-start]");
    if (!command) throw new Error("Missing shape command");
    expectRange(command, 0, end);
  });
});
