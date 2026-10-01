import { expect, test } from "@playwright/test";
import type { EditorFixtureWindow } from "./fixtures/entry";

test("Option-click follows links while ordinary clicks edit them", async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/index.html");
  const doc = "Before.\n\n[jump](#destination) and [web](https://example.org)\n\n# Destination\n\nAfter.";
  await page.evaluate((doc) => {
    const fixture = window as unknown as EditorFixtureWindow;
    fixture.__coflatRemount({ doc });
    fixture.__coflatEditor.scrollToPosition(doc.length);
    fixture.__coflatEditor.focus();
  }, doc);
  await page.locator('a[href="#destination"]').click({ modifiers: ["Alt"] });
  await expect.poll(() => page.evaluate(() => (window as unknown as EditorFixtureWindow).__coflatEditorView.state.selection.main.head)).toBe(doc.indexOf("# Destination"));
  await page.evaluate(() => {
    document.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest('a[href="https://example.org"]')) {
        document.body.dataset.followed = String(!event.defaultPrevented);
        event.preventDefault();
      }
    });
  });
  await page.locator('a[href="https://example.org"]').click({ modifiers: ["Alt"] });
  await expect(page.locator("body")).toHaveAttribute("data-followed", "true");
  await expect.poll(() => page.evaluate(() => (window as unknown as EditorFixtureWindow).__coflatEditorView.state.selection.main.head)).toBe(doc.indexOf("# Destination"));
  await page.locator('a[href="#destination"]').click();
  await expect.poll(() => page.evaluate(() => {
    const view = (window as unknown as EditorFixtureWindow).__coflatEditorView;
    return view.state.selection.main.head;
  })).toBeLessThan(doc.indexOf(" and "));
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(await page.evaluate(() => {
    const editor = (window as unknown as EditorFixtureWindow).__coflatEditor;
    return { doc: editor.getDoc(), cst: editor.getCst()?.text };
  })).toEqual({ doc, cst: doc });
});
