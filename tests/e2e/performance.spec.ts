import { expect, test } from "@playwright/test";
import type { EditorView } from "@codemirror/view";
import type { MountedEditor } from "../../editor";

// Opt in so timing measurements do not compete with the interaction suite.
test.skip(process.env.COFLAT_CST_BENCHMARK !== "1", "Opt-in editing benchmark");

for (const [surface, suffix] of [
  ["prose", "Localized TARGET paragraph.\n"],
  ["display math", "Before preview.\n\n$$\nx + TARGET\n$$\n"],
  ["table", "Before preview.\n\n| Name | Value |\n| --- | --- |\n| TARGET | $x$ |\n"],
]) {
  test(`measures ${surface} typing and cursor movement in a 700 KiB document`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/tests/e2e/fixtures/index.html");
    await expect(page.locator("#editor-root .cm-editor")).toBeVisible();
    const measurements = await page.evaluate(async ({ surface, suffix }) => {
      const { __coflatEditor: editor, __coflatEditorView: view } = window as unknown as {
        __coflatEditor: MountedEditor;
        __coflatEditorView: EditorView;
      };
      const paragraph = "Ordinary prose with *emphasis*, [a link](doc.md), and $x+y$.\n\n";
      const doc = paragraph.repeat(Math.floor(700 * 1_024 / paragraph.length))
        + suffix;
      editor.setDoc(doc);
      const position = doc.indexOf("TARGET");
      editor.scrollToPosition(position);
      editor.focus();
      await document.fonts.ready;
      const frame = (): Promise<void> => new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      await frame();
      await frame();
      const results = [];
      for (const operation of ["replace", "insert/delete", "cursor", "enter/leave"] as const) {
        const dispatchTimes: number[] = [];
        const frameTimes: number[] = [];
        for (let index = 0; index < 70; index += 1) {
          await frame();
          const start = performance.now();
          if (operation === "replace") {
            view.dispatch({
              changes: { from: position, to: position + 1, insert: index % 2 ? "T" : "t" },
            });
          } else if (operation === "insert/delete") {
            view.dispatch({
              changes: { from: position, to: position + (index % 2), insert: index % 2 ? "" : "a" },
            });
          } else if (operation === "cursor") {
            view.dispatch({ selection: { anchor: position + index % 2 } });
          } else {
            view.dispatch({ selection: { anchor: index % 2 ? position : doc.length - suffix.length } });
          }
          const dispatchMs = performance.now() - start;
          await frame();
          if (index >= 20) {
            dispatchTimes.push(dispatchMs);
            frameTimes.push(performance.now() - start);
          }
        }
        const p95 = (values: number[]): number => {
          values.sort((a, b) => a - b);
          return values[Math.ceil(values.length * 0.95) - 1] ?? 0;
        };
        results.push({ operation, dispatchP95Ms: p95(dispatchTimes), nextFrameP95Ms: p95(frameTimes) });
      }
      return {
        surface,
        documentCodeUnits: doc.length,
        synchronized: editor.getCst()?.text === editor.getDoc(),
        sourceRestored: editor.getDoc() === doc,
        previewCurrent: surface === "prose" || Boolean(view.dom.querySelector(
          surface === "table" ? ".cf-cst-table" : ".cf-math-display",
        )?.textContent?.includes("TARGET")),
        results,
      };
    }, { surface, suffix });
    expect(measurements.synchronized).toBe(true);
    expect(measurements.sourceRestored).toBe(true);
    expect(measurements.previewCurrent).toBe(true);
    console.log(JSON.stringify(measurements));
  });
}
