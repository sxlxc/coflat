import { expect, type Page, test } from "@playwright/test";
import type { EditorFixtureWindow } from "./fixtures/entry";

async function mountMath(page: Page, latex: string, display: boolean, metadata = ""): Promise<string> {
  const source = `${metadata}Before 中文 😀.\n\n${display ? `$$\n${latex}\n$$` : `$${latex}$`}\n\nAfter.`;
  await page.evaluate((doc) => {
    (window as unknown as EditorFixtureWindow).__coflatRemount({ doc });
  }, source);
  await page.evaluate(() => document.fonts.ready);
  return source;
}

async function clickText(page: Page, text: string, character: number, side: "left" | "right"): Promise<void> {
  const point = await page.evaluate(({ text, character, side }) => {
    const symbol = [...document.querySelectorAll(".katex-html [data-loc-start]")].find(
      (element) => element.textContent === text && !element.querySelector("[data-loc-start]"),
    );
    if (!symbol?.firstChild) throw new Error(`Missing symbol: ${text}`);
    const range = document.createRange();
    range.setStart(symbol.firstChild, character);
    range.setEnd(symbol.firstChild, character + ((text.codePointAt(character) ?? 0) > 0xffff ? 2 : 1));
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width * (side === "left" ? 0.2 : 0.8), y: (rect.top + rect.bottom) / 2 };
  }, { text, character, side });
  await page.mouse.click(point.x, point.y);
}

async function expectCursor(page: Page, source: string, position: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const fixture = window as unknown as EditorFixtureWindow;
    return {
      doc: fixture.__coflatEditor.getDoc(),
      cst: fixture.__coflatEditor.getCst()?.text,
      anchor: fixture.__coflatEditorView.state.selection.main.anchor,
      head: fixture.__coflatEditorView.state.selection.main.head,
    };
  })).toEqual({ doc: source, cst: source, anchor: position, head: position });
  await expect(page.locator(".cm-content")).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/index.html");
  await expect(page.locator(".cm-editor")).toBeVisible();
});

for (const display of [false, true]) {
  test(`keeps unmapped ${display ? "display" : "inline"} math editable near its suffix`, async ({ page }) => {
    for (const [latex, suffix] of [["x^{", "{"], [String.raw`\verb|abc|`, "c"]]) {
      const source = await mountMath(page, latex, display);
      const surface = page.locator(display ? ".cf-math-display" : ".cf-math-inline");
      await expect(surface.locator("[data-loc-start]")).toHaveCount(0);
      const point = await surface.evaluate((element, suffix) => {
        const content = element.querySelector(".katex-html") ?? element;
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = (node.textContent ?? "").lastIndexOf(suffix);
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + suffix.length);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width * 0.8, y: (rect.top + rect.bottom) / 2 };
        }
        throw new Error(`Missing math suffix: ${suffix}`);
      }, suffix);
      await page.mouse.click(point.x, point.y);
      const position = await page.evaluate(() => (
        (window as unknown as EditorFixtureWindow).__coflatEditorView.state.selection.main.head
      ));
      expect(position).toBeGreaterThan(source.indexOf(latex));
      expect(position).toBeLessThanOrEqual(source.indexOf(latex) + latex.length);
      await expectCursor(page, source, position);
      await page.keyboard.insertText("z");
      await expectCursor(page, source.slice(0, position) + "z" + source.slice(position), position + 1);
      await page.keyboard.press("ControlOrMeta+z");
      await expectCursor(page, source, position);
    }
  });

  test(`preserves verbatim text and graphemes in unmapped ${display ? "display" : "inline"} math`, async ({ page }) => {
    for (const [latex, fraction, offset] of [
      [String.raw`\verb|\alpha|`, 0.7, 9],
      [String.raw`\verb*|\alpha|`, 0.7, 10],
      ["\\alpha\u0301{", 0.55, 7],
    ] as const) {
      const source = await mountMath(page, latex, display);
      const surface = page.locator(display ? ".cf-math-display" : ".cf-math-inline");
      await expect(surface.locator("[data-loc-start]")).toHaveCount(0);
      const point = await surface.evaluate((element, fraction) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width * fraction, y: (rect.top + rect.bottom) / 2 };
      }, fraction);
      await page.mouse.click(point.x, point.y);
      const position = source.indexOf(latex) + offset;
      await expectCursor(page, source, position);

      await page.keyboard.insertText("z");
      const edited = source.slice(0, position) + "z" + source.slice(position);
      await expectCursor(page, edited, position + 1);
      await page.keyboard.press("ControlOrMeta+z");
      await expectCursor(page, source, position);
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expectCursor(page, edited, position + 1);
    }
  });

  test(`places the caret on exact symbol boundaries in ${display ? "display" : "inline"} math`, async ({ page }) => {
    for (const [latex, text, character, sourceToken] of [
      ["x+1234", "1234", 2, "3"],
      ["x^{1234}", "1234", 2, "3"],
      ["x_{1234}", "1234", 2, "3"],
      [String.raw`\text{hello world}`, "hello\u00a0world", 8, "r"],
      [String.raw`\alpha+\beta`, "β", 0, String.raw`\beta`],
      [String.raw`\frac{a+b}{c+d}`, "b", 0, "b"],
      [String.raw`\frac{a+b}{c+d}`, "d", 0, "d"],
      [String.raw`\begin{matrix}a&b\\c&d\end{matrix}`, "d", 0, "d"],
      [String.raw`\text{中文😀}`, "😀", 0, "😀"],
    ] as const) {
      for (const side of ["left", "right"] as const) {
        const source = await mountMath(page, latex, display);
        const body = source.indexOf(latex);
        const expected = body + latex.indexOf(sourceToken) + (side === "right" ? sourceToken.length : 0);
        await clickText(page, text, character, side);
        await expectCursor(page, source, expected);
      }
    }
  });
}

test("maps macro output to the call and arguments to their own source", async ({ page }) => {
  const metadata = '---\nmath:\n  R: "\\\\mathbb{R}"\n  sq: "#1^2"\n---\n';
  for (const [latex, symbol, token] of [
    [String.raw`x+\R+y`, "R", String.raw`\R`],
    [String.raw`x+\sq{z}+y`, "2", String.raw`\sq`],
    [String.raw`x+\sq{z}+y`, "z", "z"],
  ] as const) {
    for (const side of ["left", "right"] as const) {
      const source = await mountMath(page, latex, true, metadata);
      await clickText(page, symbol, 0, side);
      await expectCursor(page, source, source.indexOf(latex) + latex.indexOf(token) + (side === "right" ? token.length : 0));
    }
  }
});

test("maps operatorname words to their own source", async ({ page }) => {
  for (const display of [false, true]) {
    const latex = String.raw`\operatorname{rank}`;
    const source = await mountMath(page, latex, display);
    const body = source.indexOf(latex);
    await clickText(page, "rank", 1, "left");
    await expectCursor(page, source, body + 15);
    await clickText(page, "rank", 2, "right");
    await expectCursor(page, source, body + 17);

    // KaTeX builds \argmin from a macro; its letters target the call site.
    const macroLatex = String.raw`x+\argmin`;
    const macroSource = await mountMath(page, macroLatex, display);
    const macroBody = macroSource.indexOf(macroLatex);
    await clickText(page, "g", 0, "left");
    await expectCursor(page, macroSource, macroBody + 2);
    await clickText(page, "g", 0, "right");
    await expectCursor(page, macroSource, macroBody + 9);
  }
});

test("targets commands from fraction bars and radical signs", async ({ page }) => {
  for (const [latex, selector] of [
    [String.raw`\frac{a}{b}`, ".frac-line"],
    [String.raw`\sqrt{x}`, "svg"],
  ] as const) {
    const source = await mountMath(page, latex, true);
    await page.locator(`.katex-html ${selector}`).click();
    await expectCursor(page, source, source.indexOf(latex));
  }
});

test("uses nearby symbols for whitespace clicks and keeps preview clicks editable", async ({ page }) => {
  const latex = String.raw`\frac{a}{b}\quad+z`;
  const source = await mountMath(page, latex, true);
  const point = await page.locator(".katex-html").getByText("+", { exact: true }).boundingBox();
  if (!point) throw new Error("Missing math operator");
  await page.mouse.click(point.x - 2, point.y + point.height / 2);
  await expectCursor(page, source, source.indexOf("+z"));
  await clickText(page, "z", 0, "right");
  const position = source.indexOf("+z") + 2;
  await expectCursor(page, source, position);
  await page.keyboard.insertText("+1");
  const edited = source.slice(0, position) + "+1" + source.slice(position);
  await expectCursor(page, edited, position + 2);
  await page.keyboard.press("ControlOrMeta+z");
  await expectCursor(page, source, position);
});

test("tracks wrapped inline math and source offsets after an earlier Unicode edit", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  const latex = `${"a+b+".repeat(14)}1234`;
  const original = await mountMath(page, latex, false);
  await page.evaluate(() => {
    const fixture = window as unknown as EditorFixtureWindow;
    fixture.__coflatEditorView.dispatch({ changes: { from: 0, insert: "追加 😀 " } });
  });
  const source = `追加 😀 ${original}`;
  const tops = await page.locator(".katex-html > .base").evaluateAll((elements) => (
    elements.map((element) => element.getBoundingClientRect().top)
  ));
  expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(20);
  await clickText(page, "1234", 2, "right");
  await expectCursor(page, source, source.indexOf("1234") + 3);
});

test("uses normalized source offsets for CRLF input", async ({ page }) => {
  const input = "Before 中文 😀.\r\n\r\n$$\r\n\\frac{a}{1234}\r\n$$\r\n\r\nAfter.";
  await page.evaluate((doc) => {
    (window as unknown as EditorFixtureWindow).__coflatRemount({ doc });
  }, input);
  await page.evaluate(() => document.fonts.ready);
  const source = input.replaceAll("\r\n", "\n");
  await clickText(page, "1234", 2, "right");
  await expectCursor(page, source, source.indexOf("1234") + 3);
});
