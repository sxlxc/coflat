import { expect, type Page, test } from "@playwright/test";
import type { EditorFixtureWindow } from "./fixtures/entry";

async function selectionSnapshot(page: Page) {
  return page.evaluate(() => {
    const view = (window as unknown as EditorFixtureWindow).__coflatEditorView;
    const selection = document.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) throw new Error("Missing DOM selection");
    return {
      anchor: view.state.selection.main.anchor,
      head: view.state.selection.main.head,
      domAnchor: view.posAtDOM(selection.anchorNode, selection.anchorOffset),
      domHead: view.posAtDOM(selection.focusNode, selection.focusOffset),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/index.html");
  await expect(page.locator("#editor-root .cm-editor")).toBeVisible();
});

test("wraps keyboard selections with paired markup while preserving the DOM selection", async ({ page }) => {
  for (const [open, close] of [
    ["*", "*"], ["_", "_"], ["$", "$"], ["`", "`"], ["~", "~"], ["^", "^"],
    ["'", "'"], ['"', '"'], ["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"],
  ]) {
    const prefix = "Before ";
    const selected = "中文😀";
    await page.evaluate((doc) => {
      const fixture = window as unknown as EditorFixtureWindow;
      fixture.__coflatRemount({ doc });
      fixture.__coflatEditor.scrollToPosition(doc.length);
      fixture.__coflatEditor.focus();
    }, prefix + selected);
    for (const _character of selected) await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.type(open);
    const anchor = prefix.length + selected.length + 1;
    const head = prefix.length + 1;
    await expect.poll(() => selectionSnapshot(page)).toEqual({
      anchor, head, domAnchor: anchor, domHead: head,
    });
    expect(await page.evaluate(() => {
      const editor = (window as unknown as EditorFixtureWindow).__coflatEditor;
      return { doc: editor.getDoc(), cst: editor.getCst()?.text };
    })).toEqual({ doc: `${prefix}${open}${selected}${close}`, cst: `${prefix}${open}${selected}${close}` });
    await expect(page.locator(".cm-content")).toBeFocused();
  }
});

test("repeated markup typing keeps selected text through undo and redo", async ({ page }) => {
  await page.evaluate(() => {
    const fixture = window as unknown as EditorFixtureWindow;
    fixture.__coflatRemount({ doc: "text" });
    fixture.__coflatEditor.focus();
  });
  await page.keyboard.press("ControlOrMeta+a");
  const snapshot = () => page.evaluate(() => {
    const editor = (window as unknown as EditorFixtureWindow).__coflatEditor;
    return { doc: editor.getDoc(), cst: editor.getCst()?.text };
  });
  await page.keyboard.type("*");
  await expect.poll(snapshot).toEqual({ doc: "*text*", cst: "*text*" });
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(snapshot).toEqual({ doc: "text", cst: "text" });
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(snapshot).toEqual({ doc: "*text*", cst: "*text*" });
  await page.keyboard.type("*");
  await expect.poll(snapshot).toEqual({ doc: "**text**", cst: "**text**" });
  await expect.poll(() => selectionSnapshot(page)).toEqual({
    anchor: 2, head: 6, domAnchor: 2, domHead: 6,
  });
  await expect(page.locator(".cm-content")).toBeFocused();
});

for (const inline of [
  "*xxx*", "**xxx**", "`xxx`", "_xxx_", "__xxx__", "~~xxx~~", "^xxx^", "~xxx~",
  "``x`x``", "**_中文😀_**", "*xxx*`yyy`", "[xxx](doc.md)", "<https://example.org>",
]) {
  test(`arrows cross every source position in ${inline}`, async ({ page }) => {
    const prefix = "Before 中文 😀 ";
    const source = `${prefix}${inline} after.`;
    const from = prefix.length;
    const to = from + inline.length;
    await page.evaluate(({ doc, position }) => {
      const fixture = window as unknown as EditorFixtureWindow;
      fixture.__coflatRemount({ doc });
      fixture.__coflatEditor.scrollToPosition(position);
      fixture.__coflatEditor.focus();
    }, { doc: source, position: from - 1 });
    const positions = [from];
    for (const character of inline) positions.push(positions[positions.length - 1] + character.length);
    positions.push(to + 1);
    for (const next of positions) {
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => selectionSnapshot(page)).toEqual({
        anchor: next, head: next, domAnchor: next, domHead: next,
      });
    }
    for (const next of [from - 1, ...positions.slice(0, -1)].reverse()) {
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => selectionSnapshot(page)).toEqual({
        anchor: next, head: next, domAnchor: next, domHead: next,
      });
    }
    const state = await page.evaluate(() => {
      const editor = (window as unknown as EditorFixtureWindow).__coflatEditor;
      return { doc: editor.getDoc(), cst: editor.getCst()?.text };
    });
    expect(state).toEqual({ doc: source, cst: source });
  });
}

test("selects closing delimiters and types outside nested markup at line and document ends", async ({ page }) => {
  for (const suffix of ["\nAfter.", ""]) {
    const source = `Before.\n**_中文😀_**${suffix}`;
    const from = source.indexOf("_**");
    const to = from + 3;
    await page.evaluate(({ doc, position }) => {
      const fixture = window as unknown as EditorFixtureWindow;
      fixture.__coflatRemount({ doc });
      fixture.__coflatEditor.scrollToPosition(position);
      fixture.__coflatEditor.focus();
    }, { doc: source, position: from });
    for (let next = from + 1; next <= to; next += 1) {
      await page.keyboard.press("Shift+ArrowRight");
      await expect.poll(() => selectionSnapshot(page)).toEqual({
        anchor: from, head: next, domAnchor: from, domHead: next,
      });
    }
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => selectionSnapshot(page)).toEqual({
      anchor: to, head: to, domAnchor: to, domHead: to,
    });
    await page.keyboard.insertText("!");
    const snapshot = () => page.evaluate(() => {
      const editor = (window as unknown as EditorFixtureWindow).__coflatEditor;
      return { doc: editor.getDoc(), cst: editor.getCst()?.text };
    });
    const edited = `${source.slice(0, to)}!${source.slice(to)}`;
    await expect.poll(snapshot).toEqual({ doc: edited, cst: edited });
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(snapshot).toEqual({ doc: source, cst: source });
  }
});

test("inline fonts and revealed delimiters preserve prose line height", async ({ page }) => {
  const lines = ["Plain xxx text.", ...["*", "**", "`", "_", "__", "~~"].map(
    (markup) => `Plain ${markup}xxx${markup} text.`,
  ), "Plain **_xxx_** text."];
  await page.evaluate((doc) => {
    (window as unknown as EditorFixtureWindow).__coflatRemount({ doc });
  }, lines.join("\n"));
  await page.evaluate(() => document.fonts.ready);
  const rows = page.locator(".cm-content > .cm-line");
  const height = await rows.first().evaluate((element) => element.getBoundingClientRect().height);
  for (let index = 1; index < lines.length; index += 1) {
    const row = rows.nth(index);
    expect(await row.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(height, 1);
    await page.evaluate((number) => {
      const fixture = window as unknown as EditorFixtureWindow;
      const line = fixture.__coflatEditorView.state.doc.line(number);
      fixture.__coflatEditor.scrollToPosition(line.from + line.text.indexOf("xxx") + 1);
    }, index + 1);
    expect(await row.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(height, 1);
  }
});
