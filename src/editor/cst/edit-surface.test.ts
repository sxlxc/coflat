import { redo, undo } from "@codemirror/commands";
import { afterEach, describe, expect, it } from "vitest";

import { CSS } from "../../core/constants/css-classes";
import { createSimpleEditor } from "../simple-editor";

describe("CST edit surface list markers", () => {
  let editor: ReturnType<typeof createSimpleEditor> | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function mount(doc: string): HTMLElement {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = createSimpleEditor({ parent, doc });
    return parent;
  }

  it("renders unordered list source markers as bullet glyphs", () => {
    const doc = "- dash\n+ plus\n* star\n1. ordered";
    const parent = mount(doc);

    expect(
      [...parent.querySelectorAll(`.${CSS.listBullet}`)].map(
        (marker) => marker.textContent,
      ),
    ).toEqual(["•", "•", "•"]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("updates the rendered marker when the CST list kind changes", () => {
    const parent = mount("- item");
    expect(parent.querySelectorAll(`.${CSS.listBullet}`)).toHaveLength(1);

    editor?.dispatch({ changes: { from: 0, to: 1, insert: "1." } });
    expect(parent.querySelectorAll(`.${CSS.listBullet}`)).toHaveLength(0);
    expect(editor?.state.doc.toString()).toBe("1. item");

    editor?.dispatch({ changes: { from: 0, to: 2, insert: "-" } });
    expect(parent.querySelectorAll(`.${CSS.listBullet}`)).toHaveLength(1);
    expect(editor?.state.doc.toString()).toBe("- item");
  });
});

describe("CST edit surface tables", () => {
  let editor: ReturnType<typeof createSimpleEditor> | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function mount(doc: string): HTMLElement {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = createSimpleEditor({ parent, doc });
    return parent;
  }

  it("renders pipe tables with semantic rows, alignment, and inline math", () => {
    const doc = [
      "Before",
      "",
      "| Item | Value |",
      "| :--- | ---: |",
      "| **Alpha** | $x^2$ |",
    ].join("\n");
    const parent = mount(doc);
    const rendered = parent.querySelector<HTMLElement>(
      ".cf-cst-table:not(.cf-cst-table-preview)",
    );

    expect(rendered).not.toBeNull();
    expect(rendered?.querySelectorAll("thead th")).toHaveLength(2);
    expect(rendered?.querySelector("thead th")?.textContent).toBe("Item");
    expect(rendered?.querySelector("thead th")?.getAttribute("data-align")).toBe("left");
    expect(rendered?.querySelector("thead th:nth-child(2)")?.getAttribute("data-align"))
      .toBe("right");
    expect(rendered?.querySelector("tbody strong")?.textContent).toBe("Alpha");
    expect(rendered?.querySelector("tbody .katex")).not.toBeNull();
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("reveals source on click and keeps a live rendered preview", () => {
    const doc = [
      "Before",
      "",
      "| Item | Value |",
      "| --- | ---: |",
      "| Alpha | 1 |",
    ].join("\n");
    const parent = mount(doc);
    const cell = parent.querySelector<HTMLElement>(
      ".cf-cst-table:not(.cf-cst-table-preview) tbody td",
    );
    expect(cell).not.toBeNull();

    cell?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(parent.querySelector(".cf-cst-table-preview")).not.toBeNull();
    expect(parent.querySelector(".cf-cst-table:not(.cf-cst-table-preview)")).toBeNull();
    expect(parent.querySelectorAll(`.cm-line.${CSS.tableSource}`)).toHaveLength(3);

    if (!editor) throw new Error("Missing mounted editor");
    const insertAt = editor.state.doc.toString().indexOf("Alpha") + "Alpha".length;
    editor.dispatch({
      changes: { from: insertAt, insert: "X" },
      selection: { anchor: insertAt + 1 },
    });

    expect(editor?.state.doc.toString()).toContain("| AlphaX | 1 |");
    expect(parent.querySelector(".cf-cst-table-preview tbody td")?.textContent)
      .toBe("AlphaX");

    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toContain("| Alpha | 1 |");
    expect(parent.querySelector(".cf-cst-table-preview tbody td")?.textContent)
      .toBe("Alpha");

    expect(redo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toContain("| AlphaX | 1 |");
    expect(parent.querySelector(".cf-cst-table-preview tbody td")?.textContent)
      .toBe("AlphaX");
  });

  it("does not split pipes inside escapes, code spans, or math", () => {
    const parent = mount([
      "Before",
      "",
      "| Name | Code | Dollar | Backslash | Literal |",
      "| --- | --- | --- | --- | --- |",
      "| Row | `a|b` | $O(|E|)$ | \\(a|b\\) | a\\|b |",
      "| Next || 2 || tail |",
    ].join("\n"));
    const cells = parent.querySelectorAll(
      ".cf-cst-table:not(.cf-cst-table-preview) tbody tr:first-child td",
    );
    const emptyRow = parent.querySelectorAll(
      ".cf-cst-table:not(.cf-cst-table-preview) tbody tr:nth-child(2) td",
    );

    expect(cells).toHaveLength(5);
    expect(cells[0]?.textContent).toBe("Row");
    expect(cells[1]?.textContent).toBe("a|b");
    expect(cells[2]?.querySelector(".katex")).not.toBeNull();
    expect(cells[3]?.querySelector(".katex")).not.toBeNull();
    expect(cells[4]?.textContent).toBe("a|b");
    expect(emptyRow).toHaveLength(5);
    expect(emptyRow[0]?.textContent).toBe("Next");
    expect(emptyRow[1]?.textContent).toBe("");
    expect(emptyRow[2]?.textContent).toBe("2");
  });
});
