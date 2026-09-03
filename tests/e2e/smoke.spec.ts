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
  setDoc(doc: string): void;
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

test("keeps a padded code-block background while selecting its text", async ({ page }) => {
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
    const anchor = mounted.getDoc().indexOf("const selected");
    view.dispatch({
      selection: { anchor, head: anchor + "const selected = true;".length },
    });
  });

  const after = await page.evaluate(() => {
    const line = Array.from(document.querySelectorAll<HTMLElement>(
      ".cm-line.cf-cst-code-block",
    )).find((candidate) => candidate.textContent?.includes("const selected"));
    if (!line) throw new Error("Missing selected code-block fixture line");
    return {
      active: line.classList.contains("cf-cst-active-line"),
      backgroundColor: getComputedStyle(line).backgroundColor,
    };
  });

  expect(before.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(before.paddingLeft).toBeCloseTo(before.fontSize);
  expect(after.active).toBe(true);
  expect(after.backgroundColor).toBe(before.backgroundColor);
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
