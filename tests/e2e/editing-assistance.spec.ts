import { expect, type Page, test } from "@playwright/test";
import type { MountEditorOptions } from "../../editor";
import type { EditorFixtureWindow } from "./fixtures/entry";

const theorem = [
  '::: {.theorem #thm:main title="Main result"}',
  "Every finite example has a witness.",
  ":::",
].join("\n");

const referencesDocument = [
  "---",
  "bibliography: references.bib",
  "---",
  "中文 😀 introduction.",
  "",
  theorem,
  "",
  "See [@thm:main] and [@smith2024].",
  "",
  "Editing starts here.",
].join("\n");

async function mount(
  page: Page,
  doc: string,
  editingAssistance?: MountEditorOptions["editingAssistance"],
): Promise<void> {
  await page.evaluate((options) => {
    const fixture = window as unknown as EditorFixtureWindow;
    fixture.__coflatRemount(options);
    fixture.__coflatEditor.scrollToPosition(options.doc.length);
    fixture.__coflatEditor.focus();
  }, { doc, editingAssistance });
}

async function expectDocument(page: Page, expected: string): Promise<void> {
  expect(await page.evaluate(() => {
    const editor = (window as unknown as EditorFixtureWindow).__coflatEditor;
    return { doc: editor.getDoc(), cst: editor.getCst()?.text };
  })).toEqual({ doc: expected, cst: expected });
}

async function selectedSource(page: Page): Promise<string> {
  return page.evaluate(() => {
    const { state } = (window as unknown as EditorFixtureWindow).__coflatEditorView;
    const { from, to } = state.selection.main;
    return state.doc.sliceString(from, to);
  });
}

async function acceptOption(page: Page, label: string, key = "Enter"): Promise<void> {
  const options = page.getByRole("option");
  const option = options.filter({ has: page.getByText(label, { exact: true }) });
  await expect(option).toBeVisible();
  // CodeMirror ignores completion keys for 75ms after opening the popup.
  await page.waitForTimeout(100);
  const count = await options.count();
  for (let index = 0; index < count; index += 1) {
    if (await option.getAttribute("aria-selected") === "true") break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(option).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press(key);
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/index.html");
  await expect(page.locator("#editor-root .cm-editor")).toBeVisible();
});

test("completes bracket pairs and supports closer skipping and paired deletion", async ({ page }) => {
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"]]) {
    await mount(page, "");
    await page.keyboard.type(open);
    await expectDocument(page, open + close);
    expect(await page.evaluate(() => (
      (window as unknown as EditorFixtureWindow).__coflatEditorView.state.selection.main.head
    ))).toBe(1);
    await page.keyboard.press("Backspace");
    await expectDocument(page, "");
    await page.keyboard.type(`${open}text${close}!`);
    await expectDocument(page, `${open}text${close}!`);
    await expect(page.locator(".cm-content")).toBeFocused();
  }
});

test("inserts a link snippet into an automatically completed bracket pair", async ({ page }) => {
  await mount(page, "");
  await page.keyboard.type("[");
  await page.keyboard.press("Control+Space");
  await acceptOption(page, "link");
  await expectDocument(page, "[text](https://example.com)");
  expect(await selectedSource(page)).toBe("text");
  await page.keyboard.type("*");
  await expectDocument(page, "[*text*](https://example.com)");
  expect(await selectedSource(page)).toBe("text");
  await page.keyboard.press("Tab");
  expect(await selectedSource(page)).toBe("https://example.com");
});

test("pairs braces after a fenced-div opener without opening the snippet menu", async ({ page }) => {
  const opener = theorem.split("\n")[0];
  const suffix = theorem.slice(opener.length);
  await mount(page, theorem);
  await page.evaluate((position) => {
    const editor = (window as unknown as EditorFixtureWindow).__coflatEditor;
    editor.scrollToPosition(position);
    editor.focus();
  }, opener.length);
  await page.keyboard.type("{");
  await expectDocument(page, `${opener}{}${suffix}`);
  await page.waitForTimeout(250);
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  expect(await page.evaluate(() => (
    (window as unknown as EditorFixtureWindow).__coflatEditorView.state.selection.main.head
  ))).toBe(opener.length + 1);
  await page.keyboard.press("Control+Space");
  await acceptOption(page, "strong");
  await expectDocument(page, `${opener}{**text**}${suffix}`);
  expect(await selectedSource(page)).toBe("text");
});

test("keeps automatic Markdown snippet triggers available", async ({ page }) => {
  for (const [trigger, label] of [["**", "strong"], ["$$", "display math"], ["```", "code fence"]]) {
    await mount(page, "");
    await page.keyboard.type(trigger);
    await expectDocument(page, trigger);
    await acceptOption(page, label);
    expect(await selectedSource(page)).not.toBe("");
  }
});

test("respects markup switches independently of suggestion menu activation", async ({ page }) => {
  for (const options of [false, { markupCompletion: false }] as const) {
    await mount(page, "text", options);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("*");
    await expectDocument(page, "*");
    await page.keyboard.type("[");
    await expectDocument(page, "*[");
  }
  await mount(page, "", { activateOnTyping: false });
  await page.keyboard.type("[");
  await expectDocument(page, "[]");
});

test("completes local labels from typing and preserves source, cursor, and undo", async ({ page }, testInfo) => {
  const source = `中文 😀 introduction.\n\n${theorem}\n\nSee `;
  await mount(page, source);
  await page.keyboard.type("@thm:ma");
  await expect(page.getByRole("option")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("reference-completion.png") });
  await acceptOption(page, "@thm:main");
  await expectDocument(page, `${source}@thm:main`);
  expect(await selectedSource(page)).toBe("");
  expect(await page.evaluate(() => (
    (window as unknown as EditorFixtureWindow).__coflatEditor.getCursorContext()?.position
  ))).toBe(`${source}@thm:main`.length);

  await page.keyboard.press("ControlOrMeta+z");
  await expectDocument(page, `${source}@thm:ma`);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expectDocument(page, `${source}@thm:main`);
});

test("preserves formatting delimiters when completing an unfinished reference by keyboard", async ({ page }) => {
  for (const [before, after] of [["_See ", "_"], ["~~See ", "~~"], ["_", "_"]]) {
    const source = `中文 😀 introduction.\n\n${theorem}\n\n${before}`;
    await mount(page, source + after);
    for (let index = 0; index < after.length; index += 1) await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("@");
    await acceptOption(page, "@thm:main", "Tab");
    await expectDocument(page, `${source}@thm:main${after}`);
    expect(await selectedSource(page)).toBe("");
    expect(await page.evaluate(() => (
      (window as unknown as EditorFixtureWindow).__coflatEditor.getCursorContext()?.position
    ))).toBe(`${source}@thm:main`.length);
    await expect(page.locator(".cm-content")).toBeFocused();
  }
});

test("refreshes open reference options after the host renames or removes a target", async ({ page }) => {
  const source = `${theorem}\n\nSee @`;
  for (const replacement of ["#thm:renamed", ""]) {
    await mount(page, source);
    await page.keyboard.press("Control+Space");
    await expect(page.getByRole("option")).toContainText("@thm:main");
    const updated = source.replace("#thm:main", replacement);
    await page.evaluate((doc) => {
      (window as unknown as EditorFixtureWindow).__coflatEditor.setDoc(doc);
    }, updated);
    await expect(page.getByRole("option").filter({ hasText: "@thm:main" })).toHaveCount(0);
    if (replacement) {
      await acceptOption(page, "@thm:renamed");
      await expectDocument(page, `${updated}thm:renamed`);
    } else {
      await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
      await expectDocument(page, updated);
    }
    await expect(page.locator(".cm-content")).toBeFocused();
  }
});

test("excludes footnote identifiers while completing citations in footnote bodies", async ({ page }) => {
  for (const footnote of ["[^@]", "[^@]: Body."]) {
    const source = `${referencesDocument}\n\n${footnote}`;
    await mount(page, source);
    await expect(page.locator(".cf-bibliography-entry")).toContainText("A Useful Result");
    await page.evaluate(() => {
      const editor = (window as unknown as EditorFixtureWindow).__coflatEditor;
      editor.scrollToPosition(editor.getDoc().lastIndexOf("@") + 1);
      editor.focus();
    });
    await page.keyboard.press("Control+Space");
    await page.waitForTimeout(200);
    await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
    await expectDocument(page, source);
  }

  const source = `${referencesDocument}\n\n[^note]: See @`;
  await mount(page, source);
  await page.keyboard.press("Control+Space");
  await acceptOption(page, "@smith2024");
  await expectDocument(page, `${source}smith2024`);
});

test("opens and inserts a block snippet on a blank line between document blocks", async ({ page }) => {
  await mount(page, "```text\nx\n```\n\nFollowing.");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Control+Space");
  await acceptOption(page, "heading");
  expect(await selectedSource(page)).toBe("Heading");
  await page.keyboard.insertText("中文 😀 heading");
  await page.keyboard.press("Tab");
  await expectDocument(page, "```text\nx\n```\n\n## 中文 😀 heading\n\n\nFollowing.");
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("completes loaded bibliography keys with Tab and dismisses choices with Escape", async ({ page }) => {
  const source = `${referencesDocument}\n\nAnother citation: [`;
  await mount(page, source);
  await expect(page.locator(".cf-bibliography-entry")).toContainText("A Useful Result");
  await page.keyboard.type("@sm");
  await expect(page.getByRole("option")).toContainText("A Useful Result");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await expectDocument(page, `${source}@sm`);

  await page.keyboard.press("Control+Space");
  await acceptOption(page, "@smith2024", "Tab");
  await page.keyboard.type("].");
  await expectDocument(page, `${source}@smith2024].`);
  await page.keyboard.press("Enter");
  await expect(page.locator(".cf-citation")).toHaveCount(2);
});

test("keeps long reference suggestions usable in a narrow dark viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 640 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  const id = "thm:long-reference-identifier-for-a-narrow-editor-viewport";
  const source = [
    `::: {.theorem #${id} title="A theorem with a long descriptive title about completing references in a narrow editor viewport"}`,
    "Every finite example has a witness.",
    ":::",
    "",
    "See ",
  ].join("\n");
  await mount(page, source);
  await page.keyboard.type("@thm:long");
  await expect(page.getByRole("option")).toBeVisible();
  await expect(page.locator(".cm-completionInfo")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("narrow-dark-completion.png") });

  const tooltips = await page.locator(".cm-tooltip").evaluateAll((elements) => (
    elements.map((element) => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { className: element.className, left, right, top, bottom };
    })
  ));
  await acceptOption(page, `@${id}`);
  await expectDocument(page, `${source}@${id}`);
  await expect(page.locator(".cm-content")).toBeFocused();
  for (const tooltip of tooltips) {
    expect(tooltip.left, tooltip.className).toBeGreaterThanOrEqual(0);
    expect(tooltip.right, tooltip.className).toBeLessThanOrEqual(375);
    expect(tooltip.top, tooltip.className).toBeGreaterThanOrEqual(0);
    expect(tooltip.bottom, tooltip.className).toBeLessThanOrEqual(640);
  }
});

test("inserts canonical fenced divs and moves through snippet fields by keyboard", async ({ page }) => {
  await mount(page, "");
  await page.keyboard.type(":::");
  await acceptOption(page, "theorem");
  expect(await selectedSource(page)).toBe("name");
  await page.keyboard.type("main");
  await page.keyboard.press("Tab");
  expect(await selectedSource(page)).toBe("Title");
  await page.keyboard.type("Main result");
  await page.keyboard.press("Tab");
  expect(await selectedSource(page)).toBe("Statement.");
  await page.keyboard.insertText("中文 😀 statement.");
  await page.keyboard.press("Tab");
  await page.keyboard.type("After.");

  await expectDocument(page, [
    '::: {.theorem #thm:main title="Main result"}',
    "中文 😀 statement.",
    ":::",
    "After.",
  ].join("\n"));
  await expect(page.locator(".cf-fenced-div-header")).toContainText("Main result");
});

test("offers common markup on explicit completion", async ({ page }) => {
  await mount(page, "");
  await page.keyboard.press("Control+Space");
  await acceptOption(page, "strong");
  await page.keyboard.type("important");
  await page.keyboard.press("Tab");
  await page.keyboard.type(" text");
  await expectDocument(page, "**important** text");
  await expect(page.locator(".cm-content .cf-bold")).toHaveText("important");
});

test("previews rendered cross-references and citations without changing source", async ({ page }, testInfo) => {
  await mount(page, referencesDocument, { hoverTime: 50 });
  const preview = page.locator(".cf-reference-preview");
  await page.locator(".cf-fenced-div-reference").hover();
  await expect(preview).toContainText("Theorem 1");
  await expect(preview).toContainText("Main result");
  await expect(preview).toContainText("Every finite example has a witness.");
  await page.screenshot({ path: testInfo.outputPath("reference-preview.png") });
  await page.mouse.move(0, 0);
  await expect(preview).toHaveCount(0);

  await page.locator(".cf-citation").hover();
  await expect(preview).toContainText("A Useful Result");
  await expect(preview).toContainText("Smith");
  await expect(preview).toContainText("2024");
  await expectDocument(page, referencesDocument);
});

test("opens and dismisses reference previews from the keyboard", async ({ page }) => {
  await mount(page, referencesDocument);
  await expect(page.locator(".cf-bibliography-entry")).toContainText("A Useful Result");
  for (const [key, content] of [
    ["thm:main", "Every finite example has a witness."],
    ["smith2024", "A Useful Result"],
  ]) {
    await page.evaluate((id) => {
      const editor = (window as unknown as EditorFixtureWindow).__coflatEditor;
      editor.scrollToPosition(editor.getDoc().indexOf(`@${id}`) + 2);
      editor.focus();
    }, key);
    await page.keyboard.press("ControlOrMeta+Shift+Space");
    await expect(page.locator(".cf-reference-preview")).toContainText(content);
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".cf-reference-preview")).toHaveCount(0);
  }
  await expectDocument(page, referencesDocument);
});

test("allows manual completion while automatic activation is disabled", async ({ page }) => {
  const source = `${theorem}\n\nSee `;
  await mount(page, source, { activateOnTyping: false });
  await page.keyboard.type("@thm:ma");
  await page.waitForTimeout(400);
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await page.keyboard.press("Control+Space");
  await acceptOption(page, "@thm:main");
  await expectDocument(page, `${source}@thm:main`);
});

test("lets hosts disable all assistance", async ({ page }) => {
  await mount(page, referencesDocument, false);
  await page.locator(".cf-fenced-div-reference").hover();
  await page.waitForTimeout(400);
  await expect(page.locator(".cf-reference-preview")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.keyboard.type(" @thm:ma");
  await page.keyboard.press("Control+Space");
  await page.waitForTimeout(400);
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await page.evaluate(() => {
    const editor = (window as unknown as EditorFixtureWindow).__coflatEditor;
    editor.scrollToPosition(editor.getDoc().indexOf("@thm:main") + 2);
  });
  await page.keyboard.press("ControlOrMeta+Shift+Space");
  await expect(page.locator(".cf-reference-preview")).toHaveCount(0);
  await expectDocument(page, `${referencesDocument} @thm:ma`);
});

test("configures reference completion, markup completion, and previews independently", async ({ page }) => {
  await mount(page, `${referencesDocument}\n\n`, {
    referenceCompletion: false,
    referencePreviews: false,
  });
  await page.locator(".cf-fenced-div-reference").hover();
  await page.waitForTimeout(400);
  await expect(page.locator(".cf-reference-preview")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.keyboard.type("@thm:ma");
  await page.keyboard.press("Control+Space");
  await expect(page.getByRole("option").filter({ hasText: "@thm:main" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.type(":::");
  await expect(page.getByRole("option").filter({ has: page.getByText("theorem", { exact: true }) }))
    .toBeVisible();

  await mount(page, `${theorem}\n\n`, { markupCompletion: false });
  await page.keyboard.type(":::");
  await page.keyboard.press("Control+Space");
  await page.waitForTimeout(400);
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("See @thm:ma");
  await acceptOption(page, "@thm:main");
});
