import { EditorState, type Extension } from "@codemirror/state";
import { activateHover, EditorView, hasHoverTooltips } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  citationResourceExtension,
  cstCitationSurface,
  getCitationItems,
} from "../citations/citation-surface";
import { CslProcessor } from "../citations/csl-processor";
import { cstDocumentPresentationField } from "../cst/document-presentation";
import {
  getPandocCstUpdateCountForTesting,
  getPandocTree,
  pandocCstField,
} from "../cst/pandoc-cst-field";
import { cstYamlMetadataField } from "../cst/yaml-metadata";
import { getReferenceCandidates, referencePreviewExtension } from "./references";

const localSource = [
  "中文 😀 before.",
  "",
  '::: {.theorem #thm:main title="Main result"}',
  "Every $x$ is useful.",
  ":::",
  "",
  "::: {.equation #eq:main}",
  "$$x=1$$",
  ":::",
  "",
  "See [@thm:main] and @eq:main.",
].join("\n");

const bibliography = JSON.stringify([
  {
    id: "thm:main",
    type: "book",
    title: "A bibliography collision",
  },
  {
    id: "uncited",
    type: "article-journal",
    title: "An uncited paper",
    author: [{ family: "Smith", given: "Alice" }],
    issued: { "date-parts": [[2024]] },
    "container-title": "Journal of Examples",
    DOI: "10.1234/example",
  },
]);

const baseExtensions = [pandocCstField, cstDocumentPresentationField, cstYamlMetadataField];
const views: EditorView[] = [];

function mount(doc: string, extensions: Extension = []): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [baseExtensions, extensions] }),
  });
  views.push(view);
  return view;
}

function key(view: EditorView, name: string, modifiers: KeyboardEventInit = {}): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  }));
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe("reference assistance", () => {
  it("uses CST target labels, titles, and UTF-16 offsets after CRLF normalization", () => {
    const state = EditorState.create({
      doc: localSource.replaceAll("\n", "\r\n"),
      extensions: baseExtensions,
    });
    expect(state.doc.toString()).toBe(localSource);
    expect(getReferenceCandidates(state)).toEqual([
      {
        id: "thm:main",
        label: "Theorem 1",
        detail: "Main result",
        preview: "Every $x$ is useful.",
        from: localSource.indexOf("::: {.theorem"),
      },
      {
        id: "eq:main",
        label: "(1)",
        detail: "Equation",
        preview: "$$x=1$$",
        from: localSource.indexOf("$$x=1$$"),
      },
    ]);
    expect(getPandocTree(state).text).toBe(state.doc.toString());
  });

  it("respects first-target resolution and excludes ambiguous equation wrappers", () => {
    const state = EditorState.create({
      doc: `${localSource}\n\n::: {.lemma #thm:main}\nDuplicate.\n:::\n\n::: {.equation #eq:ambiguous}\n$$x$$\n\n$$y$$\n:::`,
      extensions: baseExtensions,
    });
    const candidates = getReferenceCandidates(state);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].preview).toBe("Every $x$ is useful.");
    expect(candidates.some((candidate) => candidate.id === "eq:ambiguous")).toBe(false);
  });

  it("refreshes source excerpts and positions without additional CST updates", () => {
    const before = EditorState.create({ doc: localSource, extensions: baseExtensions });
    const after = before.update({ changes: [
      { from: 0, insert: "😀 " },
      { from: localSource.indexOf("useful"), to: localSource.indexOf("useful") + 6, insert: "new" },
    ] }).state;
    const candidates = getReferenceCandidates(after);
    expect(candidates[0].from).toBe(localSource.indexOf("::: {.theorem") + 3);
    expect(candidates[0].preview).toBe("Every $x$ is new.");
    expect(getPandocCstUpdateCountForTesting(after)).toBe(1);
    const selected = after.update({ selection: { anchor: after.doc.length } }).state;
    expect(getReferenceCandidates(selected)).toEqual(candidates);
    expect(getPandocTree(selected)).toBe(getPandocTree(after));
  });

  it("clips long target previews without splitting a Unicode character", () => {
    const body = `${"x".repeat(799)}😀 ending.`;
    const state = EditorState.create({
      doc: `::: {.theorem #thm:long}\n${body}\n:::`,
      extensions: baseExtensions,
    });
    expect(getReferenceCandidates(state)[0].preview).toBe(`${"x".repeat(799)}…`);
  });

  it("includes uncited bibliography metadata, prefers local labels, and never registers previews", async () => {
    const view = mount(`---\nbibliography: refs.json\n---\n\n${localSource}\n\nSee [@uncited].`, [
      citationResourceExtension({ readTextResource: async () => bibliography }),
      cstCitationSurface,
      referencePreviewExtension(0),
    ]);
    await vi.waitFor(() => expect(getCitationItems(view.state)).toHaveLength(2));
    const cite = vi.spyOn(CslProcessor.prototype, "cite");
    const register = vi.spyOn(CslProcessor.prototype, "registerCitations");
    const entries = vi.spyOn(CslProcessor.prototype, "bibliographyEntries");
    const candidates = getReferenceCandidates(view.state);
    expect(candidates).toHaveLength(3);
    expect(candidates.find((candidate) => candidate.id === "thm:main")?.label).toBe("Theorem 1");
    expect(candidates.find((candidate) => candidate.id === "uncited")).toEqual({
      id: "uncited",
      label: "An uncited paper",
      detail: "Alice Smith · 2024",
      preview: "Journal of Examples\nDOI: 10.1234/example",
    });
    activateHover(view, view.state.doc.toString().indexOf("[@uncited]") + 3, 1);
    await vi.waitFor(() => expect(view.dom.querySelector(".cf-reference-preview")?.textContent).toContain("Alice Smith"));
    expect(cite).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
    const pathFrom = view.state.doc.toString().indexOf("refs.json");
    view.dispatch({ changes: { from: pathFrom, to: pathFrom + 9, insert: "other.json" } });
    expect(getCitationItems(view.state)).toHaveLength(0);
    expect(getReferenceCandidates(view.state).some((candidate) => candidate.id === "uncited")).toBe(false);
    expect(hasHoverTooltips(view.state)).toBe(false);
  });

  it("shows an uncited entry before its first citation exists", async () => {
    const view = mount("---\nbibliography: refs.json\n---\n\nProse only.", [
      citationResourceExtension({ readTextResource: async () => bibliography }),
      cstCitationSurface,
    ]);
    await vi.waitFor(() => expect(getReferenceCandidates(view.state)).toHaveLength(2));
    expect(view.dom.querySelector(".cf-bibliography")).toBeNull();
    expect(getReferenceCandidates(view.state).map((item) => item.id)).toContain("uncited");
  });

  it("previews a citation cluster from its CST range and displays untrusted titles as text", async () => {
    const doc = `${localSource.replace("Main result", "<img src=x onerror=alert(1)>")}\n\nSee [@thm:main; @missing].`;
    const view = mount(doc, referencePreviewExtension(0));
    const from = doc.lastIndexOf("[@thm:main;");
    activateHover(view, from, 1);
    await vi.waitFor(() => expect(view.dom.querySelectorAll(".cf-reference-preview section")).toHaveLength(2));
    const preview = view.dom.querySelector(".cf-reference-preview");
    expect(preview?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(preview?.textContent).toContain("Every $x$ is useful.");
    expect(preview?.textContent).toContain("Unresolved reference");
    expect(preview?.querySelector("img")).toBeNull();
    expect(view.state.selection.main.head).toBe(0);
    expect(view.state.doc.toString()).toBe(doc);
    expect(getPandocTree(view.state).text).toBe(doc);
  });

  it("opens previews from the keyboard and dismisses them on Escape, movement, and editing", async () => {
    const view = mount(localSource, referencePreviewExtension(0));
    const from = localSource.indexOf("@eq:main");
    view.dispatch({ selection: { anchor: from + 3 } });
    key(view, " ", { ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(view.dom.querySelector(".cf-reference-preview")?.textContent).toContain("$$x=1$$"));
    expect(view.state.selection.main.head).toBe(from + 3);
    key(view, "Escape");
    expect(hasHoverTooltips(view.state)).toBe(false);
    key(view, " ", { ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(hasHoverTooltips(view.state)).toBe(true));
    view.dispatch({ selection: { anchor: from + 4 } });
    expect(hasHoverTooltips(view.state)).toBe(false);
    key(view, " ", { ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(hasHoverTooltips(view.state)).toBe(true));
    view.dispatch({ changes: { from: 0, insert: "New " } });
    expect(hasHoverTooltips(view.state)).toBe(false);
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(1);
    expect(getPandocTree(view.state).text).toBe(view.state.doc.toString());
  });

  it("does not preview escaped markers, code, or resolved example references", async () => {
    const doc = "(@item) An example.\n\nSee (@item), `@code`, and \\@escaped.";
    const view = mount(doc, referencePreviewExtension(0));
    for (const position of [doc.lastIndexOf("@item"), doc.indexOf("@code"), doc.indexOf("@escaped")]) {
      activateHover(view, position + 2, 1);
      await Promise.resolve();
      expect(hasHoverTooltips(view.state)).toBe(false);
    }
  });
});
