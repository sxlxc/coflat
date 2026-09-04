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
