import { expect, type Page, test } from "@playwright/test";

interface TypographySnapshot {
  readonly contentWidth: number;
  readonly bodyFontSize: string;
  readonly bodyLineHeight: string;
  readonly paperTitleFontSize: string;
  readonly paperTitleFontWeight: string;
  readonly headings: readonly {
    readonly fontSize: string;
    readonly fontWeight: string;
  }[];
}

interface TypographyEditorHarness {
  getDoc(): string;
  setDoc(doc: string): void;
  scrollToPosition(position: number): void;
}

async function typographySnapshot(page: Page): Promise<TypographySnapshot> {
  return page.evaluate(() => {
    const required = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing typography fixture element: ${selector}`);
      return element;
    };
    const style = (selector: string): CSSStyleDeclaration =>
      getComputedStyle(required(selector));
    const content = required(".cm-content");
    const body = style(".cm-line:first-child");
    const paperTitle = style(".cf-doc-title");

    return {
      contentWidth: content.clientWidth
        - Number.parseFloat(getComputedStyle(content).paddingLeft)
        - Number.parseFloat(getComputedStyle(content).paddingRight),
      bodyFontSize: body.fontSize,
      bodyLineHeight: body.lineHeight,
      paperTitleFontSize: paperTitle.fontSize,
      paperTitleFontWeight: paperTitle.fontWeight,
      headings: Array.from({ length: 6 }, (_, index) => {
        const heading = style(`.cf-heading-line-${index + 1}`);
        return {
          fontSize: heading.fontSize,
          fontWeight: heading.fontWeight,
        };
      }),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/typography.html");
  await expect(page.locator("#editor-root .cm-editor")).toBeVisible();
});

test("uses the requested document measure and typography scale", async ({ page }) => {
  const snapshot = await typographySnapshot(page);

  expect(snapshot.contentWidth).toBeCloseTo(800);
  expect(Number.parseFloat(snapshot.bodyFontSize)).toBeCloseTo(18);
  expect(Number.parseFloat(snapshot.bodyLineHeight)).toBeCloseTo(25.2);
  expect(Number.parseFloat(snapshot.paperTitleFontSize)).toBeCloseTo(31.104);
  expect(snapshot.paperTitleFontWeight).toBe("400");
  expect(snapshot.headings.map(({ fontSize }) => Number.parseFloat(fontSize)))
    .toEqual([
      expect.closeTo(25.92),
      expect.closeTo(21.6),
      expect.closeTo(18),
      expect.closeTo(18),
      expect.closeTo(18),
      expect.closeTo(18),
    ]);
  expect(snapshot.headings.map(({ fontWeight }) => fontWeight)).toEqual([
    "700",
    "700",
    "700",
    "700",
    "700",
    "400",
  ]);
});

test("renders hierarchical section numbers as heading presentation", async ({ page }) => {
  const headings = page.locator(".cm-line.cf-doc-heading");
  await expect(headings).toHaveCount(6);
  expect(await headings.evaluateAll((elements) => elements.map(
    (element) => (element as HTMLElement).dataset.sectionNumber,
  ))).toEqual(["1", "1.1", "1.1.1", "1.1.1.1", "1.1.1.1.1", "1.1.1.1.1.1"]);

  const generatedNumber = await headings.first().evaluate((element) =>
    getComputedStyle(element, "::before").content
  );
  expect(generatedNumber).toContain("1.");
});

test("renders inline and display KaTeX at the document font size", async ({ page }) => {
  await page.evaluate(() => {
    const editor = (window as unknown as {
      __coflatTypographyEditor: TypographyEditorHarness;
    }).__coflatTypographyEditor;
    editor.setDoc("Inline $x^2$.\n\n$$y^2$$");
  });

  const sizes = await page.evaluate(() => {
    const fontSize = (selector: string): string => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing math fixture element: ${selector}`);
      return getComputedStyle(element).fontSize;
    };
    return {
      inline: fontSize(".cf-math-inline .katex"),
      display: fontSize(".cf-math-display .katex"),
    };
  });

  expect(Number.parseFloat(sizes.inline)).toBeCloseTo(18);
  expect(Number.parseFloat(sizes.display)).toBeCloseTo(18);
});

test("keeps an inline math preview within the existing line height", async ({ page }) => {
  await page.evaluate(() => {
    const editor = (window as unknown as {
      __coflatTypographyEditor: TypographyEditorHarness;
    }).__coflatTypographyEditor;
    editor.setDoc("Before $x^2$ after.");
  });
  await page.evaluate(() => document.fonts.ready);

  const line = page.locator(".cm-line").first();
  const heightBefore = await line.evaluate((element) =>
    element.getBoundingClientRect().height
  );
  await page.locator(".cf-math-inline:not(.cf-cst-math-preview)").click();

  const preview = page.locator(".cf-math-inline.cf-cst-math-preview");
  await expect(preview).toBeVisible();
  const heightAfter = await line.evaluate((element) =>
    element.getBoundingClientRect().height
  );
  const previewHeight = await preview.evaluate((element) =>
    element.getBoundingClientRect().height
  );

  expect(Math.abs(heightAfter - heightBefore)).toBeLessThanOrEqual(0.5);
  expect(previewHeight).toBeLessThanOrEqual(heightAfter + 0.5);
});

test("keeps display math in place and reveals its source afterward", async ({ page }) => {
  await page.evaluate(() => {
    const editor = (window as unknown as {
      __coflatTypographyEditor: TypographyEditorHarness;
    }).__coflatTypographyEditor;
    editor.setDoc([
      "Before",
      "",
      "$$",
      "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
      "$$",
      "",
      "After",
    ].join("\n"));
  });
  await page.evaluate(() => document.fonts.ready);

  const rendered = page.locator(
    ".cf-math-display:not(.cf-cst-math-preview)",
  );
  await expect(rendered).toBeVisible();
  const before = await rendered.evaluate((element) => {
    const math = element.querySelector<HTMLElement>(".katex-display");
    if (!math) throw new Error("Missing rendered display math");
    const outerRect = element.getBoundingClientRect();
    const mathRect = math.getBoundingClientRect();
    return {
      label: element.getAttribute("aria-label"),
      outerTop: outerRect.top,
      mathWidth: mathRect.width,
      mathHeight: mathRect.height,
      paddingTop: getComputedStyle(element).paddingTop,
    };
  });

  await rendered.click();
  const preview = page.locator(".cf-math-display.cf-cst-math-preview");
  await expect(preview).toBeVisible();
  await expect(page.locator(".cf-math-source")).not.toHaveCount(0);
  const after = await preview.evaluate((element) => {
    const math = element.querySelector<HTMLElement>(".katex-display");
    const source = document.querySelector<HTMLElement>(
      ".cf-source-delimiter, .cf-math-source",
    );
    if (!math || !source) throw new Error("Missing active display math content");
    const outerRect = element.getBoundingClientRect();
    const mathRect = math.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
      label: element.getAttribute("aria-label"),
      outerTop: outerRect.top,
      outerBottom: outerRect.bottom,
      mathWidth: mathRect.width,
      mathHeight: mathRect.height,
      paddingTop: style.paddingTop,
      previewPrecedesSource: Boolean(
        element.compareDocumentPosition(source)
        & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      sourceTop: sourceRect.top,
    };
  });

  expect(after.label).toBe(before.label);
  expect(Math.abs(after.outerTop - before.outerTop)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.mathWidth - before.mathWidth)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.mathHeight - before.mathHeight)).toBeLessThanOrEqual(0.5);
  expect(after.paddingTop).toBe(before.paddingTop);
  expect(after.borderTopWidth).toBe("0px");
  expect(after.boxShadow).toBe("none");
  expect(after.previewPrecedesSource).toBe(true);
  expect(after.sourceTop).toBeGreaterThanOrEqual(after.outerBottom - 0.5);
});

test("keeps the same measure and scale in the blueprint theme", async ({ page }) => {
  await page.locator("body").evaluate((body) => {
    body.classList.add("cf-theme-blueprint-book");
  });

  const snapshot = await typographySnapshot(page);
  expect(snapshot.contentWidth).toBeCloseTo(800);
  expect(Number.parseFloat(snapshot.bodyFontSize)).toBeCloseTo(18);
  expect(Number.parseFloat(snapshot.bodyLineHeight)).toBeCloseTo(25.2);
  expect(snapshot.headings.map(({ fontSize }) => Number.parseFloat(fontSize)))
    .toEqual([
      expect.closeTo(25.92),
      expect.closeTo(21.6),
      expect.closeTo(18),
      expect.closeTo(18),
      expect.closeTo(18),
      expect.closeTo(18),
    ]);
});

test("reveals heading labels in monospace through keyboard navigation", async ({ page }) => {
  const doc = "# Introduction {#sec:introduction}\n\nBody";
  await page.evaluate((source) => {
    const editor = (window as unknown as {
      __coflatTypographyEditor: TypographyEditorHarness;
    }).__coflatTypographyEditor;
    editor.setDoc(source);
    editor.scrollToPosition(source.length);
  }, doc);
  const heading = page.locator(".cf-doc-heading");
  await expect(heading).not.toContainText("{#sec:introduction}");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  const label = heading.locator(".cf-inline-source");
  await expect(label).toHaveText("{#sec:introduction}");
  const fonts = await label.evaluate((element) => ({
    label: getComputedStyle(element).fontFamily,
    heading: getComputedStyle(element.closest(".cf-doc-heading") as HTMLElement).fontFamily,
  }));
  expect(fonts.label).toContain("monospace");
  expect(fonts.label).not.toBe(fonts.heading);
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.insertText("-edited");
  await expect(label).toHaveText("{#sec:introduction-edited}");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(heading).not.toContainText("{#sec:");
  expect(await page.evaluate(() => (window as unknown as {
    __coflatTypographyEditor: TypographyEditorHarness;
  }).__coflatTypographyEditor.getDoc())).toBe(doc.replace("introduction}", "introduction-edited}"));
});

test("keeps every heading row stable while revealing its source marker", async ({ page }) => {
  for (let level = 1; level <= 6; level += 1) {
    const heading = page.locator(`.cf-heading-line-${level}`);
    const hiddenBuffers = heading.locator(".cm-widgetBuffer");
    expect(await hiddenBuffers.count()).toBeGreaterThan(0);
    const hiddenBufferMetrics = await hiddenBuffers.evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          height: style.height,
          verticalAlign: style.verticalAlign,
        };
      })
    );
    expect(hiddenBufferMetrics).toEqual(
      hiddenBufferMetrics.map(() => ({
        height: "0px",
        verticalAlign: "baseline",
      })),
    );
    const heightBefore = await heading.evaluate((element) =>
      element.getBoundingClientRect().height
    );

    await page.evaluate((headingLevel) => {
      const editor = (window as unknown as {
        __coflatTypographyEditor: TypographyEditorHarness;
      }).__coflatTypographyEditor;
      const marker = `${"#".repeat(headingLevel)} Heading ${headingLevel}`;
      editor.scrollToPosition(editor.getDoc().indexOf(marker) + marker.length);
    }, level);

    const sourceMarker = heading.locator(".cf-source-delimiter").first();
    await expect(sourceMarker).toBeVisible();
    const markerMetrics = await sourceMarker.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        lineHeight: style.lineHeight,
        verticalAlign: style.verticalAlign,
      };
    });
    const heightAfter = await heading.evaluate((element) =>
      element.getBoundingClientRect().height
    );
    expect(markerMetrics).toEqual({
      lineHeight: "0px",
      verticalAlign: "baseline",
    });
    expect(heightAfter).toBe(heightBefore);
  }
});
