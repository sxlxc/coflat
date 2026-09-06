import { cursorCharLeft, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { afterEach, describe, expect, it } from "vitest";
import { CSS } from "../../core/constants/css-classes";
import { createSimpleEditor } from "../simple-editor";
import { getPandocTree, pandocCstField } from "./pandoc-cst-field";
import { cstYamlMetadataField, getYamlCitationMetadata } from "./yaml-metadata";

describe("CST YAML metadata presentation", () => {
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

  it("hides frontmatter behind an edit button and renders the paper title", () => {
    const doc = [
      "---",
      "title: A Paper Title",
      "bibliography: references.bib",
      "---",
      "",
      "# Introduction",
    ].join("\n");
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    const metadata = getPandocTree(editor.state).topLevelBlocks()[0];

    expect(metadata?.kind).toBe("YamlMetadata");
    expect(parent.querySelectorAll(`.cm-line.${CSS.yamlHidden}`)).toHaveLength(4);
    expect(parent.querySelectorAll(`.cm-line.${CSS.yamlSource}`)).toHaveLength(0);
    expect(parent.querySelector(`.${CSS.yamlToggle}`)?.textContent).toBe("YAML");
    expect(parent.querySelector(`.${CSS.yamlToggle}`)?.getAttribute("aria-expanded"))
      .toBe("false");
    expect(parent.querySelector(".cf-doc-title")?.textContent).toBe("A Paper Title");
    expect(editor.state.selection.main.head).toBe(metadata?.to);
    expect(editor.state.doc.toString()).toBe(doc);
  });

  it("expands editable YAML and updates the title without changing its source model", () => {
    const doc = "---\ntitle: First Title\n---\n\nBody";
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");

    const editButton = parent.querySelector<HTMLButtonElement>(`.${CSS.yamlToggle}`);
    editButton?.click();

    expect(parent.querySelectorAll(`.cm-line.${CSS.yamlHidden}`)).toHaveLength(0);
    expect(parent.querySelectorAll(`.cm-line.${CSS.yamlSource}`)).toHaveLength(3);
    expect(parent.querySelector(`.${CSS.yamlToggle}`)?.textContent).toBe("hide YAML");
    expect(parent.querySelector(`.${CSS.yamlToggle}`)?.getAttribute("aria-expanded"))
      .toBe("true");
    expect(editor.state.selection.main.head).toBe(doc.indexOf("title:"));

    const titleFrom = editor.state.doc.toString().indexOf("First Title");
    editor.dispatch({
      changes: {
        from: titleFrom,
        to: titleFrom + "First Title".length,
        insert: "Revised Title",
      },
      selection: { anchor: titleFrom + "Revised Title".length },
    });

    expect(parent.querySelector(".cf-doc-title")?.textContent).toBe("Revised Title");
    expect(editor.state.doc.toString()).toContain("title: Revised Title");

    parent.querySelector<HTMLButtonElement>(`.${CSS.yamlToggle}`)?.click();
    expect(parent.querySelectorAll(`.cm-line.${CSS.yamlHidden}`)).toHaveLength(3);
    expect(parent.querySelector(".cf-doc-title")?.textContent).toBe("Revised Title");

    expect(undo(editor)).toBe(true);
    expect(parent.querySelector(".cf-doc-title")?.textContent).toBe("First Title");
    expect(editor.state.doc.toString()).toBe(doc);
  });

  it("reveals the hidden source when keyboard navigation enters it", () => {
    const doc = "---\ntitle: Keyboard Title\n---\nBody";
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    const metadata = getPandocTree(editor.state).topLevelBlocks()[0];
    expect(editor.state.selection.main.head).toBe(metadata?.to);

    expect(cursorCharLeft(editor)).toBe(true);

    expect(editor.state.selection.main.head).toBeLessThan(metadata?.to ?? 0);
    expect(parent.querySelectorAll(`.cm-line.${CSS.yamlSource}`)).toHaveLength(3);
    expect(parent.querySelector(`.${CSS.yamlToggle}`)?.getAttribute("aria-expanded"))
      .toBe("true");
  });

  it("applies frontmatter macros to inline, display, and table math", () => {
    const doc = [
      "---",
      "title: Macro Paper",
      "math:",
      '  R: "\\\\mathbb{R}"',
      '  pair: "\\\\langle #1 \\\\rangle"',
      "---",
      "",
      "Inline $\\R$.",
      "",
      "$$\\pair{x}$$",
      "",
      "| Value |",
      "| --- |",
      "| $\\R$ |",
    ].join("\n");
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");

    expect(parent.querySelectorAll(".katex")).toHaveLength(3);
    expect(parent.querySelectorAll(`.${CSS.mathError}`)).toHaveLength(0);

    const macroBody = editor.state.doc.toString().indexOf("mathbb{R}");
    editor.dispatch({
      changes: {
        from: macroBody,
        to: macroBody + "mathbb{R}".length,
        insert: "mathbf{Q}",
      },
    });

    const renderedMath = [...parent.querySelectorAll<HTMLElement>(".katex")]
      .map((element) => element.textContent ?? "");
    expect(renderedMath).toHaveLength(3);
    expect(renderedMath.every((text) => text.includes("Q") || text.includes("x")))
      .toBe(true);
    expect(parent.querySelectorAll(`.${CSS.mathError}`)).toHaveLength(0);
  });

  it("keeps title-less bibliography metadata hidden and available to loaders", () => {
    const doc = "---\nbibliography: references.bib\n---\nBody";
    const parent = mount(doc);

    expect(parent.querySelector(".cf-doc-title")).toBeNull();
    expect(parent.querySelector(`.${CSS.yamlToggle}`)?.textContent).toBe("YAML");
    expect(parent.textContent).not.toContain("references.bib");
    if (!editor) throw new Error("Missing mounted editor");
    expect(getYamlCitationMetadata(editor.state)).toEqual({
      bibliographyPaths: ["references.bib"],
      nocite: [],
    });
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("handles a BOM, CRLF input, and a non-ASCII title", () => {
    const doc = "\ufeff---\r\ntitle: 数学 Résumé\r\n---\r\nBody";
    const parent = mount(doc);
    if (!editor) throw new Error("Missing mounted editor");
    const metadata = getPandocTree(editor.state).topLevelBlocks()[0];

    expect(metadata?.kind).toBe("YamlMetadata");
    expect(parent.querySelector(".cf-doc-title")?.textContent).toBe("数学 Résumé");
    expect(editor.state.selection.main.head).toBe(metadata?.to);
    expect(editor.state.doc.toString()).toBe(doc.replaceAll("\r\n", "\n"));
  });

  it("reuses metadata decorations until the source or revealed state changes", () => {
    const doc = "---\ntitle: 数学 😀\n---\n\nBody text";
    let state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [pandocCstField, cstYamlMetadataField],
    });
    const collapsed = state.field(cstYamlMetadataField);
    state = state.update({ selection: { anchor: doc.length - 1 } }).state;
    expect(state.field(cstYamlMetadataField)).toBe(collapsed);
    state = state.update({ changes: { from: doc.length, insert: "!" } }).state;
    expect(state.field(cstYamlMetadataField)).toBe(collapsed);

    state = state.update({ selection: { anchor: doc.indexOf("title") } }).state;
    const expanded = state.field(cstYamlMetadataField);
    expect(expanded.active).toBe(true);
    expect(expanded.decorations).not.toBe(collapsed.decorations);
    state = state.update({ selection: { anchor: doc.indexOf("数学") } }).state;
    expect(state.field(cstYamlMetadataField)).toBe(expanded);

    state = state.update({ changes: { from: 4, to: 9, insert: "other" } }).state;
    expect(state.field(cstYamlMetadataField).metadata?.title).toBeUndefined();
    expect(getPandocTree(state).text).toBe(state.doc.toString());
    state = state.update({ changes: { from: 0, to: doc.indexOf("Body") } }).state;
    expect(state.field(cstYamlMetadataField).metadata).toBeNull();
  });
});
