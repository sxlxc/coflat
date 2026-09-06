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

test("tracks nested fenced divs across previews while editing from the keyboard", async ({ page }) => {
  const source = [
    "Before", "", ":::: {.theorem}", "Statement.", "",
    "::: {.proof}", "中文 😀 proof.", "", "$$", "x = 1", "$$", "",
    "| A | B |", "| --- | --- |", "| 1 | 2 |", "",
    "End of proof.", ":::", "::::", "", "After",
  ].join("\n");
  await page.evaluate((doc) => {
    const editor = (window as unknown as { __coflatEditor: EditorHarness }).__coflatEditor;
    editor.setDoc(doc);
    editor.scrollToPosition(0);
    editor.focus();
  }, source);
  const bars = page.locator(".cf-fenced-div-range");
  await expect(bars).toHaveCount(0);
  await expect(page.locator(".cf-block-qed")).toHaveText("∎");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(bars).toHaveCount(1);
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowDown");
  await expect(bars).toHaveCount(2);

  const measure = async () => page.evaluate(() => {
    const markers = [...document.querySelectorAll(".cf-fenced-div-range")]
      .map((element) => element.getBoundingClientRect());
    const headers = [...document.querySelectorAll(".cf-fenced-div-header")]
      .map((element) => element.closest(".cm-line")?.getBoundingClientRect());
    const qed = document.querySelector(".cf-block-qed");
    const qedLine = qed?.closest(".cm-line");
    const closer = qedLine?.nextElementSibling?.getBoundingClientRect();
    const previews = [...document.querySelectorAll(".cf-math-display, .cf-doc-table-block")]
      .map((element) => element.getBoundingClientRect());
    if (markers.length !== 2 || !headers[0] || !headers[1] || !qed || !closer) {
      throw new Error("Missing nested div presentation");
    }
    return {
      alignedTop: Math.abs(markers[0].top - headers[0].top) < 1
        && Math.abs(markers[1].top - headers[1].top) < 1,
      alignedBottom: Math.abs(markers[1].bottom - closer.bottom) < 1,
      qedOnText: qedLine?.textContent === "End of proof.∎",
      separate: markers[1].right < markers[0].left,
      inMargin: markers[0].right < headers[0].left,
      spansPreviews: previews.length >= 2 && previews.every((preview) => (
        markers[1].top < preview.top && markers[1].bottom > preview.bottom
      )),
    };
  });
  await expect.poll(measure).toEqual({
    alignedTop: true, alignedBottom: true, qedOnText: true, separate: true, inMargin: true, spansPreviews: true,
  });
  await page.keyboard.insertText("X");
  await page.setViewportSize({ width: 640, height: 720 });
  await expect.poll(measure).toEqual({
    alignedTop: true, alignedBottom: true, qedOnText: true, separate: true, inMargin: true, spansPreviews: true,
  });
  await page.evaluate(() => {
    const editor = (window as unknown as { __coflatEditor: EditorHarness }).__coflatEditor;
    editor.scrollToPosition(editor.getDoc().lastIndexOf("\n:::\n") + 1);
  });
  await expect(page.locator(".cf-fenced-div-source")).toHaveText(":::");
  await expect(page.locator(".cf-block-qed")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(bars).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(bars).toHaveCount(0);
  const result = await page.evaluate(() => {
    const editor = (window as unknown as { __coflatEditor: EditorHarness }).__coflatEditor;
    return { doc: editor.getDoc(), cst: editor.getCst()?.text };
  });
  expect(result.doc).toContain("X");
  expect(result.cst).toBe(result.doc);
});

for (const [name, body, previewSelector, sourceSelector] of [
  ["display math", "$$\nx = 1\n$$", ".cf-math-display", ".cf-math-source-line"],
  ["pipe table", "| A | B |\n| --- | --- |\n| 中文 😀 | 2 |", ".cf-doc-table-block", ".cf-table-source"],
]) {
  test(`keeps the proof tombstone after a terminal ${name} preview`, async ({ page }) => {
    const source = `Before\n\n::: {.proof}\n${body}\n:::\n\nAfter`;
    const closer = source.lastIndexOf(":::");
    await page.evaluate((doc) => {
      const editor = (window as unknown as { __coflatEditor: EditorHarness }).__coflatEditor;
      editor.setDoc(doc);
      editor.scrollToPosition(0);
      editor.focus();
    }, source);
    const qed = page.locator(".cf-block-qed");
    await expect(qed).toHaveCount(1);
    await expect(qed).toBeVisible();
    await expect.poll(async () => {
      const preview = await page.locator(previewSelector).boundingBox();
      const marker = await qed.boundingBox();
      return preview !== null && marker !== null && marker.y >= preview.y + preview.height - 1;
    }).toBe(true);

    await page.evaluate((position) => {
      (window as unknown as { __coflatEditor: EditorHarness }).__coflatEditor.scrollToPosition(position);
    }, closer);
    await expect(page.locator(".cf-fenced-div-source")).toHaveText(":::");
    await expect(qed).toBeVisible();
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(sourceSelector).first()).toBeVisible();
    await expect(qed).toHaveCount(1);
    await expect(qed).toBeVisible();
    await page.keyboard.insertText(" ");
    await expect(qed).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(qed).toBeVisible();
    const result = await page.evaluate(() => {
      const editor = (window as unknown as { __coflatEditor: EditorHarness }).__coflatEditor;
      return { doc: editor.getDoc(), cst: editor.getCst()?.text };
    });
    expect(result.doc.length).toBe(source.length + 1);
    expect(result.cst).toBe(result.doc);
  });
}

test("gives display math source full gray rows and dark monospace text", async ({ page }) => {
  await page.evaluate(() => {
    const editor = (window as unknown as { __coflatEditor: EditorHarness }).__coflatEditor;
    editor.setDoc("Before\n\n$$\nx = 1\n+ 2\n$$\n\nAfter");
    editor.scrollToPosition(editor.getDoc().indexOf("x = 1"));
    editor.focus();
  });
  const lines = page.locator(".cm-line.cf-math-source-line");
  await expect(lines).toHaveCount(4);
  for (const line of await lines.all()) {
    await expect(line).toHaveCSS("background-color", "rgb(245, 246, 248)");
    await expect(line).toHaveCSS("color", "rgb(32, 33, 36)");
    await expect(line).toHaveCSS("font-family", /Monaco/);
  }
  await expect(page.locator(".cf-math-source").first()).toHaveCSS("color", "rgb(32, 33, 36)");
  await page.keyboard.insertText("y + ");
  await expect(lines).toHaveCount(4);
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

test("keeps the cursor at text height on a blank line", async ({ page }) => {
  const metrics = await page.evaluate(async () => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    const source = "Text before.\n\nText after.";
    mounted.setDoc(source);
    mounted.focus();

    const measure = async (position: number, lineIndex: number) => {
      mounted.scrollToPosition(position);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const cursor = document.querySelector<HTMLElement>(".cm-cursor-primary");
      const line = document.querySelectorAll<HTMLElement>(".cm-line")[lineIndex];
      if (!cursor || !line) throw new Error("Missing cursor fixture geometry");
      const cursorRect = cursor.getBoundingClientRect();
      const lineRect = line.getBoundingClientRect();
      const visualCursor = getComputedStyle(cursor, "::after");
      const visualCursorHeight = Number.parseFloat(visualCursor.height);
      return {
        visualCursorHeight,
        visualCursorTopOffset: cursorRect.top
          + cursorRect.height / 2
          - visualCursorHeight / 2
          - lineRect.top,
        lineHeight: lineRect.height,
      };
    };

    return {
      text: await measure(1, 0),
      blank: await measure(source.indexOf("\n") + 1, 1),
    };
  });

  expect(metrics.blank.lineHeight).toBeCloseTo(metrics.text.lineHeight, 1);
  expect(Number.isFinite(metrics.text.visualCursorHeight)).toBe(true);
  expect(metrics.blank.visualCursorHeight).toBe(metrics.text.visualCursorHeight);
  expect(metrics.blank.visualCursorHeight).toBeLessThan(metrics.blank.lineHeight);
  expect(metrics.blank.visualCursorTopOffset)
    .toBeCloseTo(metrics.text.visualCursorTopOffset, 5);
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

test("renders and keyboard-edits collapsed YAML metadata", async ({ page }) => {
  const source = [
    "---",
    "title: Paper Title",
    "bibliography: references.bib",
    "math:",
    '  R: "\\\\mathbb{R}"',
    "---",
    "",
    "Body $\\R$.",
    "",
    "# First section",
  ].join("\n");
  await page.evaluate((doc) => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.setDoc(doc);
    mounted.scrollToPosition(doc.indexOf("Body"));
  }, source);

  const toggle = page.getByRole("button", { name: "Edit YAML metadata" });
  const title = page.locator(".cf-doc-title");
  await expect(toggle).toHaveText("YAML");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(title).toHaveText("Paper Title");
  await expect(page.locator(".cm-line.cf-yaml-hidden")).toHaveCount(6);
  await expect(page.locator(".cf-math-error")).toHaveCount(0);

  const typography = await page.evaluate(() => {
    const required = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing metadata fixture: ${selector}`);
      return element;
    };
    const titleStyle = getComputedStyle(required(".cf-doc-title"));
    const headingStyle = getComputedStyle(required(".cf-heading-line-1"));
    const toggleStyle = getComputedStyle(required(".cf-yaml-toggle"));
    return {
      ratio: Number.parseFloat(titleStyle.fontSize)
        / Number.parseFloat(headingStyle.fontSize),
      titleAlign: titleStyle.textAlign,
      titleStyle: titleStyle.fontStyle,
      titleWeight: titleStyle.fontWeight,
      toggleColor: toggleStyle.color,
      toggleFont: toggleStyle.fontFamily,
    };
  });
  expect(typography.ratio).toBeCloseTo(1.2);
  expect(typography.titleAlign).toBe("center");
  expect(typography.titleStyle).toBe("normal");
  expect(typography.titleWeight).toBe("400");
  expect(typography.toggleColor).toBe("rgb(107, 114, 128)");
  expect(typography.toggleFont).toContain("Monaco");

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Hide YAML metadata" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".cm-line.cf-yaml-source")).toHaveCount(6);

  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.scrollToPosition(mounted.getDoc().indexOf("Paper Title"));
    mounted.focus();
  });
  await page.keyboard.insertText("Revised ");
  await expect(title).toHaveText("Revised Paper Title");

  const state = await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.scrollToPosition(mounted.getDoc().indexOf("Body"));
    return { cst: mounted.getCst()?.text, doc: mounted.getDoc() };
  });
  await expect(page.locator(".cm-line.cf-yaml-hidden")).toHaveCount(6);
  await expect(title).toHaveText("Revised Paper Title");
  expect(state.doc).toContain("title: Revised Paper Title");
  expect(state.cst).toBe(state.doc);
});

test("renders blockquote markers and editable numbered fenced-div references", async ({
  page,
}) => {
  const source = [
    "> Quoted text.",
    "",
    '::: {#result .thm title="Main result" someAttr="xxx"}',
    "Statement.",
    ":::",
    "",
    "Use @result and [@result].",
  ].join("\n");
  await page.evaluate((doc) => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.setDoc(doc);
    mounted.scrollToPosition(doc.indexOf("Statement") + 2);
    mounted.focus();
  }, source);

  const quoteMark = page.locator(".cf-blockquote-mark");
  const header = page.locator(".cf-fenced-div-header");
  const references = page.locator(".cf-fenced-div-reference");
  await expect(quoteMark).toHaveText(">");
  await expect(header).toHaveText("Theorem 1 (Main result)");
  await expect(references).toHaveText(["Theorem 1", "Theorem 1"]);

  const typography = await page.evaluate(() => {
    const marker = document.querySelector<HTMLElement>(".cf-blockquote-mark");
    const blockHeader = document.querySelector<HTMLElement>(".cf-fenced-div-header");
    if (!marker || !blockHeader) throw new Error("Missing block presentation");
    return {
      headerWeight: getComputedStyle(blockHeader).fontWeight,
      markerFont: getComputedStyle(marker).fontFamily,
    };
  });
  expect(typography.markerFont).toContain("Monaco");
  expect(Number.parseInt(typography.headerWeight, 10)).toBeGreaterThanOrEqual(700);

  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    const reference = "[@result]";
    mounted.scrollToPosition(mounted.getDoc().lastIndexOf(reference) + reference.length);
    mounted.focus();
  });
  await page.keyboard.press("ArrowLeft");
  await expect(references).toHaveCount(1);
  await expect(page.locator("#editor-root .cm-content"))
    .toHaveAttribute("data-cst-inline", "Citation");
  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.scrollToPosition(mounted.getDoc().indexOf("Statement") + 2);
  });
  await expect(references).toHaveCount(2);

  await header.click();
  await expect(header).toHaveCount(0);
  await expect(page.locator(".cf-fenced-div-source"))
    .toHaveText('::: {#result .thm title="Main result" someAttr="xxx"}');

  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.scrollToPosition(mounted.getDoc().indexOf(".thm") + 1);
    mounted.focus();
  });
  await page.keyboard.insertText("x");
  await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.scrollToPosition(mounted.getDoc().indexOf("Statement") + 2);
  });

  await expect(header).toHaveText("Xthm (Main result)");
  await expect(references).toHaveText(["Xthm", "Xthm"]);
  const state = await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    return { cst: mounted.getCst()?.text, doc: mounted.getDoc() };
  });
  expect(state.doc).toContain(".xthm");
  expect(state.cst).toBe(state.doc);
});

test("keeps fenced-div layout stable when revealing its opener source", async ({
  page,
}) => {
  const source = [
    "Before.",
    "",
    '::: {.thm #result title="Main result"}',
    "Statement.",
    ":::",
    "",
    "After.",
  ].join("\n");
  await page.evaluate((doc) => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.setDoc(doc);
    mounted.scrollToPosition(doc.indexOf("Statement") + 2);
    mounted.focus();
  }, source);

  const header = page.locator(".cf-fenced-div-header");
  await expect(header).toHaveText("Theorem 1 (Main result)");
  const renderedLayout = await header.evaluate((element) => {
    const openerLine = element.closest<HTMLElement>(".cm-line");
    const statementLine = [...document.querySelectorAll<HTMLElement>(".cm-line")]
      .find((line) => line.textContent === "Statement.");
    if (!openerLine || !statementLine) throw new Error("Missing fenced div lines");
    return {
      openerHeight: openerLine.getBoundingClientRect().height,
      statementTop: statementLine.getBoundingClientRect().top,
    };
  });

  await header.click();
  const openerSource = page.locator(".cf-fenced-div-source");
  await expect(openerSource)
    .toHaveText('::: {.thm #result title="Main result"}');
  const sourceLayout = await openerSource.evaluate((element) => {
    const openerLine = element.closest<HTMLElement>(".cm-line");
    const statementLine = [...document.querySelectorAll<HTMLElement>(".cm-line")]
      .find((line) => line.textContent === "Statement.");
    if (!openerLine || !statementLine) throw new Error("Missing fenced div lines");
    return {
      openerHeight: openerLine.getBoundingClientRect().height,
      statementTop: statementLine.getBoundingClientRect().top,
    };
  });

  expect(sourceLayout.openerHeight).toBeCloseTo(renderedLayout.openerHeight, 5);
  expect(sourceLayout.statementTop).toBeCloseTo(renderedLayout.statementTop, 5);
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

test("numbers only equation-div math and keeps its edit preview on one row", async ({ page }) => {
  const source = [
    "::: {.equation #eq:first}",
    "$$\\frac{a_1+a_2+a_3+a_4+a_5+a_6+a_7+a_8}{b_1+b_2+b_3+b_4+b_5+b_6+b_7+b_8} = y$$",
    ":::",
    "",
    "$$z = 2$$",
    "",
    "See [@eq:first].",
  ].join("\n");
  await page.evaluate((doc) => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.setDoc(doc);
    mounted.scrollToPosition(doc.indexOf("See"));
  }, source);

  const equations = page.locator(
    ".cf-math-display-numbered:not(.cf-cst-math-preview)",
  );
  await expect(page.locator(
    ".cf-math-display:not(.cf-cst-math-preview)",
  )).toHaveCount(2);
  await expect(equations).toHaveCount(1);
  await expect(equations.locator(".cf-math-display-number"))
    .toHaveText("(1)");
  await expect(page.locator(".cf-fenced-div-reference")).toHaveText("(1)");
  await expect(equations.first()).toHaveAttribute("id", "eq:first");
  await expect(page.locator(
    ".cf-math-display:not(.cf-math-display-numbered):not(.cf-cst-math-preview)",
  )).toHaveCount(1);

  const bounds = await equations.evaluateAll((elements) => elements.map((element) => {
    const surface = element.getBoundingClientRect();
    const article = element.closest(".cm-content")?.getBoundingClientRect();
    const number = element.querySelector(".cf-math-display-number")
      ?.getBoundingClientRect();
    if (!article || !number) throw new Error("Missing equation layout geometry");
    return {
      articleRight: article.right,
      articleWidth: article.width,
      numberRight: number.right,
      surfaceRight: surface.right,
      surfaceWidth: surface.width,
    };
  }));
  for (const bound of bounds) {
    expect(bound.surfaceWidth).toBeLessThanOrEqual(bound.articleWidth + 1);
    expect(bound.surfaceRight).toBeLessThanOrEqual(bound.articleRight + 1);
    expect(bound.numberRight).toBeLessThanOrEqual(bound.surfaceRight + 1);
    expect(bound.surfaceRight - bound.numberRight).toBeLessThanOrEqual(1);
  }

  const renderedHeight = await equations.first().evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await equations.first().click();

  const preview = page.locator(
    ".cf-math-display-numbered.cf-cst-math-preview",
  );
  await expect(preview).toHaveCount(1);
  await expect(preview.locator(".cf-math-display-number")).toHaveText("(1)");
  const previewLayout = await preview.evaluate((element) => {
    const surface = element.getBoundingClientRect();
    const number = element.querySelector(".cf-math-display-number")
      ?.getBoundingClientRect();
    if (!number) throw new Error("Missing active equation number");
    return {
      height: surface.height,
      numberBottom: number.bottom,
      numberTop: number.top,
      surfaceBottom: surface.bottom,
      surfaceTop: surface.top,
    };
  });
  expect(Math.abs(previewLayout.height - renderedHeight)).toBeLessThanOrEqual(1);
  expect(previewLayout.numberTop).toBeGreaterThanOrEqual(previewLayout.surfaceTop - 1);
  expect(previewLayout.numberBottom)
    .toBeLessThanOrEqual(previewLayout.surfaceBottom + 1);
});

test("keeps citation and math source reachable after unrelated prose typing", async ({ page }) => {
  const source = "---\nbibliography: references.bib\n---\nProse.\n\n::: {.eq #eq:first}\n$$x = 1$$\n:::\n\nSee [@smith2024].";
  await page.evaluate((doc) => {
    const editor = (window as unknown as { __coflatEditor: EditorHarness }).__coflatEditor;
    editor.setDoc(doc);
    editor.scrollToPosition(doc.indexOf("Prose."));
    editor.focus();
  }, source);
  await expect(page.locator(".cf-citation")).toHaveText("[1]");
  await page.keyboard.insertText("中文 😀 ");
  await expect(page.locator(".cf-math-display-number")).toHaveText("(1)");
  await page.locator(".cf-math-display").click();
  const mathPosition = await page.evaluate(() => {
    const editor = (window as unknown as { __coflatEditor: EditorHarness }).__coflatEditor;
    return { position: editor.getCursorContext()?.position, body: editor.getDoc().indexOf("x = 1") };
  });
  expect(mathPosition.position).toBeGreaterThanOrEqual(mathPosition.body);
  expect(mathPosition.position).toBeLessThanOrEqual(mathPosition.body + 5);
  await page.evaluate(() => {
    const editor = (window as unknown as { __coflatEditor: EditorHarness }).__coflatEditor;
    editor.scrollToPosition(editor.getDoc().indexOf("[@smith2024]") + "[@smith2024]".length);
  });
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".cf-citation")).toHaveCount(0);
  await page.keyboard.insertText("X");
  const result = await page.evaluate(() => {
    const editor = (window as unknown as { __coflatEditor: EditorHarness }).__coflatEditor;
    return { doc: editor.getDoc(), cst: editor.getCst()?.text };
  });
  expect(result.doc).toBe(source.replace("Prose.", "中文 😀 Prose.").replace("@smith2024", "@smith2024X"));
  expect(result.cst).toBe(result.doc);
});

test("loads YAML citations and enters rendered citation source from the keyboard", async ({ page }) => {
  const source = [
    "---",
    "bibliography: references.bib",
    "---",
    "See [@smith2024].",
  ].join("\n");
  await page.evaluate((doc) => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.setDoc(doc);
    mounted.scrollToPosition(doc.indexOf("]") + 1);
    mounted.focus();
  }, source);

  const citation = page.locator(".cf-citation");
  await expect(citation).toContainText("1");
  await expect(page.locator(".cf-bibliography-entry"))
    .toContainText("A Useful Result");

  await page.keyboard.press("ArrowLeft");
  await expect(citation).toHaveCount(0);
  await expect(page.locator("#editor-root .cm-content"))
    .toHaveAttribute("data-cst-inline", "Citation");

  const state = await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    return { cst: mounted.getCst()?.text, doc: mounted.getDoc() };
  });
  expect(state.doc).toBe(source);
  expect(state.cst).toBe(source);
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
  await expect(sourceLines.first()).toHaveCSS("background-color", "rgb(245, 246, 248)");
  await expect(sourceLines.first()).toHaveCSS("color", "rgb(32, 33, 36)");
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

test("keeps the table in place above its source and navigates by cell", async ({ page }) => {
  const source = "Before\n\n| Item | Value |\n| --- | --- |\n| 😀 中文 | **value** |\n\nAfter";
  await page.evaluate((doc) => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    mounted.setDoc(doc);
    mounted.scrollToPosition(0);
  }, source);
  const table = page.locator(".cf-cst-table table");
  const original = await table.boundingBox();
  if (!original) throw new Error("Missing table geometry");
  const cell = table.locator("tbody td").first();
  const cellBox = await cell.boundingBox();
  if (!cellBox) throw new Error("Missing cell geometry");
  await cell.click({ position: { x: cellBox.width - 3, y: cellBox.height / 2 } });

  const sourceLines = page.locator(".cm-line.cf-table-source");
  await expect(sourceLines).toHaveCount(3);
  await expect.poll(async () => {
    const current = await table.boundingBox();
    return current && Math.abs(current.y - original.y);
  }).toBeLessThan(1);
  const active = await table.boundingBox();
  const firstSource = await sourceLines.first().boundingBox();
  if (!active || !firstSource) throw new Error("Missing editing geometry");
  expect(active.x).toBeCloseTo(original.x, 0);
  expect(active.width).toBeCloseTo(original.width, 0);
  expect(active.height).toBeCloseTo(original.height, 0);
  expect(firstSource.y).toBeGreaterThanOrEqual(active.y + active.height);

  const cursorPosition = () => page.evaluate(() => (
    (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor.getCursorContext()?.position
  ));
  expect(await cursorPosition()).toBe(source.indexOf("😀"));
  await cell.click({ position: { x: 3, y: cellBox.height / 2 } });
  expect(await cursorPosition()).toBe(source.indexOf("😀"));
  await table.locator("tbody strong").click();
  expect(await cursorPosition()).toBe(source.indexOf("**value**"));
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.insertText("X");
  await expect(table.locator("tbody strong")).toHaveText("Xvalue");
  const edited = source.replace("**value**", "**Xvalue**");
  expect(await page.evaluate(() => {
    const mounted = (window as unknown as { __coflatEditor: EditorHarness })
      .__coflatEditor;
    return { doc: mounted.getDoc(), cst: mounted.getCst()?.text };
  })).toEqual({ doc: edited, cst: edited });

  await page.keyboard.press("ControlOrMeta+End");
  await expect(sourceLines).toHaveCount(0);
  for (let step = 0; step < "\n\nAfter".length; step += 1) {
    await page.keyboard.press("ArrowLeft");
  }
  await expect(sourceLines).toHaveCount(3);
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

test("keeps demo undo and redo within the active file", async ({ page }) => {
  await page.goto("/examples/simple/?doc=example");
  const content = page.locator("#editor .cm-content");
  const example = page.locator('[data-doc-id="example"]');
  const format = page.locator('[data-doc-id="format"]');
  const readSource = async (): Promise<string | null> => {
    await page.getByRole("button", { name: "View source" }).click();
    const source = await page.locator("#document-source").textContent();
    await page.getByRole("button", { name: "Close" }).click();
    return source;
  };
  const originalExample = await readSource();
  await content.focus();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await readSource()).toBe(originalExample);

  const draft = "# Example draft\n\n中文 😀 changes stay in this file.";
  await content.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(draft);
  await format.click();
  const originalFormat = await readSource();
  await content.focus();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await readSource()).toBe(originalFormat);
  await expect(format).toHaveAttribute("aria-current");
  await expect(page).toHaveURL(/\?doc=format$/);

  await content.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("# Format draft\n\nOnly this file changes.");
  await format.click();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await readSource()).toBe(originalFormat);

  await content.focus();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect(await readSource()).toBe("# Format draft\n\nOnly this file changes.");
  await content.focus();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await readSource()).toBe(originalFormat);

  await example.click();
  expect(await readSource()).toBe(draft);
  for (const key of ["ControlOrMeta+z", "ControlOrMeta+Shift+z"]) {
    await content.focus();
    await page.keyboard.press(key);
    expect(await readSource()).toBe(draft);
  }
  await expect(example).toHaveAttribute("aria-current");
  await expect(page).toHaveURL(/\?doc=example$/);
});
