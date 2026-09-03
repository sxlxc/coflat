import { expect, test } from "@playwright/test";

interface EditorHarness {
  focus(): void;
  getCst(): { readonly text: string; readonly version: number } | null;
  getCursorContext(): {
    readonly block: { readonly kind: string } | null;
    readonly inline: { readonly kind: string } | null;
    readonly position: number;
  } | null;
  getDoc(): string;
  scrollToPosition(position: number): void;
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
