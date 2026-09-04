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

describe("CST edit surface block presentation", () => {
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

  function sectionNumbers(parent: HTMLElement): Array<string | null> {
    return [...parent.querySelectorAll<HTMLElement>(".cf-doc-heading")].map(
      (heading) => heading.dataset.sectionNumber ?? null,
    );
  }

  it("renders hierarchical section numbers without changing source", () => {
    const doc = [
      "# One",
      "",
      "## First",
      "",
      "## Aside {-}",
      "",
      "### Detail",
      "",
      "# Two",
      "",
      "Setext subsection",
      "-----------------",
    ].join("\n");
    const parent = mount(doc);

    expect(sectionNumbers(parent)).toEqual([
      "1",
      "1.1",
      null,
      "1.1.1",
      "2",
      "2.1",
    ]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("uses appendix letters after a top-level appendix boundary", () => {
    const doc = [
      "# Main",
      "",
      "# Appendix {.appendix}",
      "",
      "## First appendix subsection",
      "",
      "# Data",
      "",
      "## Hidden {.unnumbered}",
      "",
      "## Tables",
    ].join("\n");
    const parent = mount(doc);

    expect(sectionNumbers(parent)).toEqual([
      "1",
      null,
      "A.1",
      "B",
      null,
      "B.1",
    ]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("updates following section numbers after an attribute edit", () => {
    const doc = "# One\n\n## First\n\n## Second";
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    expect(sectionNumbers(parent)).toEqual(["1", "1.1", "1.2"]);

    const insertAt = doc.indexOf("\n", doc.indexOf("## First"));
    editor.dispatch({ changes: { from: insertAt, insert: " {-}" } });

    expect(sectionNumbers(parent)).toEqual(["1", null, "1.1"]);
    expect(editor.state.doc.toString()).toBe(
      "# One\n\n## First {-}\n\n## Second",
    );
  });

  it("renders blockquote markers with the dedicated monospace class", () => {
    const doc = "> quoted\n> again";
    const parent = mount(doc);

    const markers = parent.querySelectorAll(`.${CSS.blockquoteMark}`);
    expect(markers).toHaveLength(2);
    expect([...markers].map((marker) => marker.textContent)).toEqual([">", ">"]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("keeps block-looking TeX inside display math with adjacent prose", () => {
    const doc = [
      "Before $$",
      "\\begin{aligned}",
      "x &= 1",
      "\\end{aligned}",
      "$$ after",
    ].join("\n");
    const parent = mount(doc);
    const rendered = parent.querySelector(
      ".cf-math-display:not(.cf-cst-math-preview)",
    );

    expect(rendered).not.toBeNull();
    expect(rendered?.querySelector(".katex-display")).not.toBeNull();
    expect(rendered?.classList.contains(CSS.mathError)).toBe(false);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("renders an unnumbered fenced-div header from its first class and title", () => {
    const doc = [
      "Before",
      "",
      '::: {#label .someRandomClass .theorem title="some title" someAttr="xxx"}',
      "Body.",
      ":::",
    ].join("\n");
    const parent = mount(doc);
    const header = parent.querySelector<HTMLElement>(`.${CSS.fencedDivHeader}`);

    expect(header?.textContent).toBe("SomeRandomClass (some title)");
    expect(header?.dataset.blockClass).toBe("someRandomClass");
    expect(header?.dataset.referenceId).toBe("label");
    expect(header?.textContent).not.toMatch(/\d/);
    expect(
      [...parent.querySelectorAll(".cm-line")].some((line) => line.textContent === ":::"),
    ).toBe(false);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("expands common fenced-div class abbreviations", () => {
    const doc = [
      "Before",
      "",
      "::: {.thm}",
      "Theorem body.",
      ":::",
      "",
      "::: lem",
      "Lemma body.",
      ":::",
    ].join("\n");
    const parent = mount(doc);

    expect(
      [...parent.querySelectorAll(`.${CSS.fencedDivHeader}`)].map(
        (header) => header.textContent,
      ),
    ).toEqual(["Theorem", "Lemma"]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("resolves simple narrative and bracketed references to div labels", () => {
    const doc = [
      "Before",
      "",
      '::: {#main-result .thm title="Main result"}',
      "Body.",
      ":::",
      "",
      "Use @main-result and [@main-result].",
    ].join("\n");
    const parent = mount(doc);
    const references = parent.querySelectorAll<HTMLElement>(
      `.${CSS.fencedDivReference}`,
    );

    expect([...references].map((reference) => reference.textContent))
      .toEqual(["Theorem", "Theorem"]);
    expect([...references].map((reference) => reference.dataset.referenceId))
      .toEqual(["main-result", "main-result"]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("keeps the rendered header while editing the body and reveals opener source on click", () => {
    const doc = [
      "Before",
      "",
      '::: {.thm #result title="Main result"}',
      "Body.",
      ":::",
    ].join("\n");
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");

    editor.dispatch({ selection: { anchor: doc.indexOf("Body") + 2 } });
    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)?.textContent)
      .toBe("Theorem (Main result)");

    const header = parent.querySelector<HTMLElement>(`.${CSS.fencedDivHeader}`);
    header?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));

    expect(editor.state.selection.main.head).toBe(doc.indexOf(":::"));
    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)).toBeNull();
    expect(parent.querySelector(`.${CSS.fencedDivSource}`)?.textContent)
      .toBe('::: {.thm #result title="Main result"}');
    expect(editor.state.doc.toString()).toBe(doc);
  });

  it("updates headers and references after an attribute edit", () => {
    const doc = [
      "Before",
      "",
      "::: {.thm #result}",
      "Body.",
      ":::",
      "",
      "See [@result].",
    ].join("\n");
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)?.textContent)
      .toBe("Theorem");
    expect(parent.querySelector(`.${CSS.fencedDivReference}`)?.textContent)
      .toBe("Theorem");

    const classFrom = doc.indexOf("thm");
    editor.dispatch({ changes: { from: classFrom, to: classFrom + 3, insert: "lem" } });

    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)?.textContent)
      .toBe("Lemma");
    expect(parent.querySelector(`.${CSS.fencedDivReference}`)?.textContent)
      .toBe("Lemma");
    expect(editor.state.doc.toString()).toContain("{.lem #result}");
  });

  it("renders fenced divs with CRLF source without changing their text", () => {
    const doc = "Before\r\n\r\n::: {.proof title='details'}\r\nBody.\r\n:::\r\n";
    const parent = mount(doc);

    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)?.textContent)
      .toBe("Proof (details)");
    expect(editor?.state.doc.toString()).toBe(doc.replaceAll("\r\n", "\n"));
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

  it("omits an empty table header but retains empty body rows", () => {
    const parent = mount([
      "Before",
      "",
      "||",
      "---|---",
      "||",
      "a|b",
    ].join("\n"));
    const rendered = parent.querySelector<HTMLElement>(
      ".cf-cst-table:not(.cf-cst-table-preview)",
    );
    expect(rendered).not.toBeNull();

    expect(rendered?.querySelector("thead") ?? null).toBeNull();
    expect(rendered?.querySelector("table")?.getAttribute("aria-label")).toBe("Table");
    expect(rendered?.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(rendered?.querySelectorAll("tbody tr:first-child td")).toHaveLength(2);
    expect(rendered?.querySelector("tbody tr:first-child")?.textContent).toBe("");
  });

  it("snaps table clicks to UTF-16 code-point boundaries", () => {
    const doc = [
      "Before",
      "",
      "| Item | Value |",
      "| --- | --- |",
      "| 😀 | 1 |",
    ].join("\n");
    const parent = mount(doc);
    const cell = parent.querySelector<HTMLElement>(
      ".cf-cst-table:not(.cf-cst-table-preview) tbody td",
    );
    if (!cell || !editor) throw new Error("Missing rendered table cell");
    cell.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);

    cell.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      clientX: 50,
    }));

    const emojiFrom = doc.indexOf("😀");
    expect(editor.state.selection.main.head).toBe(emojiFrom + 2);
    editor.dispatch({ changes: { from: emojiFrom + 2, insert: "X" } });
    expect(editor.state.doc.toString()).toContain("| 😀X | 1 |");
  });

  it("visibly marks inactive block replacements covered by a selection", () => {
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
    const parent = mount(doc);
    editor?.dispatch({ selection: { anchor: 0, head: doc.length } });

    expect(parent.querySelector(
      ".cf-math-display.cf-selection-range:not(.cf-cst-math-preview)",
    )).not.toBeNull();
    expect(parent.querySelector(
      ".cf-cst-table.cf-selection-range:not(.cf-cst-table-preview)",
    )).not.toBeNull();
  });
});
