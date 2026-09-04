import { expect, type Page, test } from "@playwright/test";

interface EditorHarness {
  focus(): void;
  getCst(): { readonly text: string; readonly version: number } | null;
  getCursorContext(): {
    readonly block: { readonly kind: string } | null;
    readonly inline: { readonly kind: string } | null;
    readonly position: number;
  } | null;
  getDoc(): string;
  setDoc(doc: string): void;
  scrollToPosition(position: number): void;
}

async function cursorLineNumber(page: Page): Promise<number> {
  return page.evaluate(() => {
    const view = (window as unknown as {
      __coflatEditorView: {
        state: {
          doc: { lineAt(position: number): { number: number } };
          selection: { main: { head: number } };
        };
      };
    }).__coflatEditorView;
    return view.state.doc.lineAt(view.state.selection.main.head).number;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/index.html");
  await expect(page.locator("#editor-root .cm-editor")).toBeVisible();
});

test("mounts one editable CST-backed surface", async ({ page }) => {
  await expect(page.locator("#editor-root .cm-content"))
    .toHaveAttribute("contenteditable", "true");
  await expect(page.locator("#reader, [data-editor-mode], .cf-rich-readonly"))
    .toHaveCount(0);

  const snapshot = await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    return {
      cstText: mounted.getCst()?.text,
      doc: mounted.getDoc(),
      hasGetMode: "getMode" in mounted,
      hasSetMode: "setMode" in mounted,
    };
  });
  expect(snapshot.cstText).toBe(snapshot.doc);
  expect(snapshot.hasGetMode).toBe(false);
  expect(snapshot.hasSetMode).toBe(false);
});

test("renders unordered list source markers as bullet dots", async ({ page }) => {
  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.setDoc("- Bullet item");
  });

  const marker = page.locator(".cf-list-bullet");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveText("•");

  const doc = await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    return mounted.getDoc();
  });
  expect(doc).toContain("- Bullet item");
});

test("publishes a synchronized CST after keyboard input", async ({ page }) => {
  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.scrollToPosition(0);
    mounted.focus();
  });
  await page.keyboard.insertText("Typed ");

  const state = await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    return {
      cstText: mounted.getCst()?.text,
      doc: mounted.getDoc(),
      version: mounted.getCst()?.version,
    };
  });
  expect(state.doc).toMatch(/^Typed /);
  expect(state.cstText).toBe(state.doc);
  expect(state.version).toBeGreaterThan(0);
});

test("reveals emphasis source and edits it without a mouse", async ({ page }) => {
  await expect(page.locator(".cf-source-delimiter")).toHaveCount(0);
  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    const position = mounted.getDoc().indexOf("emphasis") + 2;
    mounted.scrollToPosition(position);
    mounted.focus();
  });

  await expect(page.locator(".cf-source-delimiter")).toHaveCount(2);
  await expect(page.locator("#editor-root .cm-content"))
    .toHaveAttribute("data-cst-inline", "Emphasis");
  await page.keyboard.insertText("X");

  const state = await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    return { cst: mounted.getCst()?.text, doc: mounted.getDoc() };
  });
  expect(state.doc).toContain("*emXphasis*");
  expect(state.cst).toBe(state.doc);
});

test("enters rendered math with an arrow key and edits its source", async ({ page }) => {
  await expect(page.locator(".cf-math-inline")).toHaveCount(1);
  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    const afterMath = mounted.getDoc().indexOf("$ after") + 1;
    mounted.scrollToPosition(afterMath);
    mounted.focus();
  });
  await page.keyboard.press("ArrowLeft");

  await expect(page.locator("#editor-root .cm-content"))
    .toHaveAttribute("data-cst-inline", "Math");
  await expect(page.locator(".cf-math-source")).not.toHaveCount(0);
  await expect(page.locator(".cf-cst-math-preview")).toHaveCount(1);
  await page.keyboard.insertText("+1");

  const state = await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    return {
      context: mounted.getCursorContext()?.inline?.kind,
      cst: mounted.getCst()?.text,
      doc: mounted.getDoc(),
    };
  });
  expect(state.context).toBe("Math");
  expect(state.doc).toContain("$x^2+1$");
  expect(state.cst).toBe(state.doc);
});

test("clicks rendered inline math to edit its source", async ({ page }) => {
  await page.locator(".cf-math-inline").click();

  await expect(page.locator("#editor-root .cm-content"))
    .toHaveAttribute("data-cst-inline", "Math");
  await expect(page.locator(".cf-math-source")).not.toHaveCount(0);
  await expect(page.locator(".cf-cst-math-preview.cf-math-inline"))
    .toHaveCount(1);
});

test("renders display math and opens its live editing popup on click", async ({ page }) => {
  const rendered = page.locator(
    ".cf-math-display:not(.cf-cst-math-preview)",
  );
  await expect(rendered).toHaveCount(1);
  await expect(rendered.locator(".katex-display")).toBeVisible();

  await rendered.click();

  await expect(page.locator("#editor-root .cm-content"))
    .toHaveAttribute("data-cst-inline", "Math");
  await expect(page.locator(".cf-math-source")).not.toHaveCount(0);
  const popup = page.locator(".cf-cst-math-preview.cf-math-display");
  await expect(popup).toHaveCount(1);
  await expect(popup.locator(".katex-display")).toBeVisible();

  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    const position = mounted.getDoc().indexOf("\\,dx");
    mounted.scrollToPosition(position);
    mounted.focus();
  });
  await page.keyboard.insertText("+1");

  const state = await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    return { cst: mounted.getCst()?.text, doc: mounted.getDoc() };
  });
  expect(state.doc).toContain("x^2+1\\,dx");
  expect(state.cst).toBe(state.doc);
  await expect(popup).toHaveAttribute("aria-label", /x\^2\+1/);
});

test("renders a table and opens its live editing preview on click", async ({ page }) => {
  const rendered = page.locator(
    ".cf-cst-table:not(.cf-cst-table-preview)",
  );
  await expect(rendered).toHaveCount(1);
  await expect(rendered.locator("thead th")).toHaveText(["Item", "Value"]);
  await expect(rendered.locator("thead th").first()).toHaveAttribute(
    "data-align",
    "left",
  );
  await expect(rendered.locator("thead th").last()).toHaveAttribute(
    "data-align",
    "right",
  );
  await expect(rendered.locator("tbody strong")).toHaveText("Alpha");

  await rendered.locator("tbody td").first().click();

  const preview = page.locator(".cf-cst-table-preview");
  await expect(preview).toHaveCount(1);
  await expect(page.locator("#editor-root .cm-content"))
    .toHaveAttribute("data-cst-block", "TableCell");
  const sourceLines = page.locator("#editor-root .cm-line.cf-table-source");
  await expect(sourceLines).toHaveCount(4);
  const sourceTypography = await sourceLines.first().evaluate((element) => {
    const source = getComputedStyle(element);
    const contentElement = element.closest(".cm-content");
    if (!contentElement) throw new Error("Missing editor content element");
    const content = getComputedStyle(contentElement);
    return {
      contentFontSize: Number.parseFloat(content.fontSize),
      fontFamily: source.fontFamily,
      fontSize: Number.parseFloat(source.fontSize),
    };
  });
  expect(sourceTypography.fontFamily).toContain("Monaco");
  expect(sourceTypography.fontSize / sourceTypography.contentFontSize)
    .toBeCloseTo(0.86, 2);

  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    const position = mounted.getDoc().indexOf("Alpha") + "Alpha".length;
    mounted.scrollToPosition(position);
    mounted.focus();
  });
  await page.keyboard.insertText("X");

  const state = await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    return { cst: mounted.getCst()?.text, doc: mounted.getDoc() };
  });
  expect(state.doc).toContain("| **AlphaX** | 1 |");
  expect(state.cst).toBe(state.doc);
  await expect(preview.locator("tbody strong")).toHaveText("AlphaX");
});

test("maps pointer clicks to the visible source line after a rendered table", async ({
  page,
}) => {
  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    const source = [
      "| Item | Value |",
      "| --- | --- |",
      "| Alpha | 1 |",
      "# Title after table",
      "First paragraph line.",
      "Click target paragraph.",
      "Last paragraph line.",
    ].join("\n");
    mounted.setDoc(source);
    mounted.scrollToPosition(source.indexOf("Last paragraph"));
  });

  const target = page.locator("#editor-root .cm-line", {
    hasText: "Click target paragraph.",
  });
  await expect(target).toHaveCount(1);
  await target.click({ position: { x: 40, y: 8 } });

  expect(await cursorLineNumber(page)).toBe(6);
});

test("moves the cursor to the preceding line above a paragraph after a table", async ({
  page,
}) => {
  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    const source = [
      "| Item | Value |",
      "| --- | --- |",
      "| Alpha | 1 |",
      "# Title after table",
      "Paragraph after title.",
    ].join("\n");
    mounted.setDoc(source);
    mounted.scrollToPosition(source.indexOf("Paragraph"));
    mounted.focus();
  });

  await page.keyboard.press("ArrowUp");

  expect(await cursorLineNumber(page)).toBe(4);
});

test("bounds multi-line code selection to text inside the padded background", async ({ page }) => {
  const before = await page.evaluate(() => {
    const line = Array.from(document.querySelectorAll<HTMLElement>(
      ".cm-line.cf-cst-code-block",
    )).find((candidate) => candidate.textContent?.includes("const selected"));
    if (!line) throw new Error("Missing code-block fixture line");
    const style = getComputedStyle(line);
    return {
      backgroundColor: style.backgroundColor,
      fontSize: Number.parseFloat(style.fontSize),
      paddingLeft: Number.parseFloat(style.paddingLeft),
      selectionColor: style.getPropertyValue("--cf-selection").trim(),
    };
  });

  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    const view = (window as unknown as {
      __coflatEditorView: {
        dispatch(spec: { selection: { anchor: number; head: number } }): void;
      };
    }).__coflatEditorView;
    const doc = mounted.getDoc();
    const anchor = doc.indexOf("selected = true");
    const secondLine = doc.indexOf("return selected");
    mounted.focus();
    view.dispatch({
      selection: { anchor, head: secondLine + "return selected".length },
    });
  });

  await expect(page.locator(".cm-selectionBackground")).not.toHaveCount(0);

  const after = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll<HTMLElement>(
      ".cm-line.cf-cst-code-block",
    )).filter((candidate) => (
      candidate.textContent?.includes("const selected")
      || candidate.textContent?.includes("return selected")
    ));
    if (lines.length !== 2) throw new Error("Missing selected code-block fixture lines");
    const selectionMarks = Array.from(document.querySelectorAll<HTMLElement>(
      ".cf-selection-range",
    ));
    return {
      active: lines.some((line) => line.classList.contains("cf-cst-active-line")),
      backgroundColors: lines.map((line) => getComputedStyle(line).backgroundColor),
      lineWidths: lines.map((line) => line.getBoundingClientRect().width),
      selectionMarkColors: selectionMarks.map((mark) => (
        getComputedStyle(mark).backgroundColor
      )),
      selectionMarkWidths: selectionMarks.flatMap((mark) => (
        Array.from(mark.getClientRects()).map((rect) => rect.width)
      )),
      syntheticSelectionDisplays: Array.from(document.querySelectorAll<HTMLElement>(
        ".cm-selectionLayer .cm-selectionBackground",
      )).map((marker) => getComputedStyle(marker).display),
    };
  });

  expect(before.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(before.paddingLeft).toBeCloseTo(before.fontSize);
  expect(after.active).toBe(true);
  expect(after.backgroundColors).toEqual([
    before.backgroundColor,
    before.backgroundColor,
  ]);
  expect(after.syntheticSelectionDisplays.length).toBeGreaterThan(0);
  expect(after.syntheticSelectionDisplays.every((display) => display === "none"))
    .toBe(true);
  expect(after.selectionMarkColors.length).toBeGreaterThan(0);
  expect(after.selectionMarkColors.every((color) => color === before.selectionColor))
    .toBe(true);
  expect(after.selectionMarkWidths.length).toBeGreaterThan(0);
  expect(Math.max(...after.selectionMarkWidths)).toBeLessThan(
    Math.min(...after.lineWidths) / 2,
  );
});

test("shows selected display-math and table replacements", async ({ page }) => {
  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    const view = (window as unknown as {
      __coflatEditorView: {
        dispatch(spec: { selection: { anchor: number; head: number } }): void;
      };
    }).__coflatEditorView;
    const doc = [
      "Before",
      "",
      "$$x+y$$",
      "",
      "| Item | Value |",
      "| --- | --- |",
      "| Alpha | 1 |",
      "",
      "After",
    ].join("\n");
    mounted.setDoc(doc);
    mounted.focus();
    view.dispatch({ selection: { anchor: 0, head: doc.length } });
  });

  const selectedMath = page.locator(
    ".cf-math-display.cf-selection-range:not(.cf-cst-math-preview)",
  );
  const selectedTable = page.locator(
    ".cf-cst-table.cf-selection-range:not(.cf-cst-table-preview)",
  );
  await expect(selectedMath).toHaveCount(1);
  await expect(selectedTable).toHaveCount(1);
  for (const replacement of [selectedMath, selectedTable]) {
    expect(await replacement.evaluate((element) => (
      getComputedStyle(element).backgroundColor
    ))).not.toBe("rgba(0, 0, 0, 0)");
  }
});

test("can replace the entire document using only the keyboard", async ({ page }) => {
  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.focus();
  });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("Everything is source-editable.");

  const state = await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    return { cst: mounted.getCst()?.text, doc: mounted.getDoc() };
  });
  expect(state).toEqual({
    cst: "Everything is source-editable.",
    doc: "Everything is source-editable.",
  });
});

test("showcase source layer displays the current document", async ({ page }) => {
  await page.goto("/examples/simple/");
  await expect(page.locator("#editor .cm-editor")).toBeVisible();

  const source = "# Current source\n\nEdited in the showcase.";
  await page.locator("#editor .cm-content").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await page.getByRole("button", { name: "View source" }).click();

  const dialog = page.getByRole("dialog", { name: "Document source" });
  await expect(dialog).toBeVisible();
  expect(await dialog.locator("code").textContent()).toBe(source);

  await page.getByRole("button", { name: "Close" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "View source" })).toBeFocused();
});
