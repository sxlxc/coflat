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

  it.each([
    "# Introduction 中文 😀 {#sec:introduction}",
    "Introduction 中文 😀 {#sec:introduction}\n==========",
  ])("includes explicit heading IDs and titles without heading markers or attributes: %s", (heading) => {
    const doc = `Before 中文 😀.\n\n${heading}\n\n# No explicit ID\n\nSee [@sec:introduction].`;
    const state = EditorState.create({ doc: doc.replaceAll("\n", "\r\n"), extensions: baseExtensions });
    const candidates = getReferenceCandidates(state);
    expect(candidates).toEqual([{
      id: "sec:introduction",
      label: "Section 1",
      detail: "Introduction 中文 😀",
      preview: heading,
      from: doc.indexOf(heading),
    }]);
    const after = state.update({ changes: [
      { from: 0, insert: "😀 " },
      { from: doc.indexOf("Introduction"), to: doc.indexOf("Introduction") + 12, insert: "Background" },
    ] }).state;
    expect(getReferenceCandidates(after)[0]).toMatchObject({
      ...candidates[0],
      detail: "Background 中文 😀",
      preview: heading.replace("Introduction", "Background"),
      from: doc.indexOf(heading) + 3,
    });
    expect(getPandocTree(after).text).toBe(after.doc.toString());
    expect(getPandocCstUpdateCountForTesting(after)).toBe(1);
  });

  it.each([
    ["# First {#same}", "Section 1"],
    ["::: {.theorem #same}\nFirst.\n:::", "Theorem 1"],
    ["::: {.equation #same}\n$$x=1$$\n:::", "(1)"],
  ])("uses the first target for labels and previews across target kinds: %s", (first, label) => {
    const doc = `${first}\n\n# Later {#same}\n\n::: {.lemma #same}\nLater.\n:::\n\n::: {.equation #same}\n$$y=2$$\n:::`;
    const state = EditorState.create({ doc, extensions: baseExtensions });
    const candidates = getReferenceCandidates(state);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: "same", label });
    expect(candidates[0].preview).not.toContain("Later");
    expect(candidates[0].preview).not.toContain("y=2");
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
    await vi.waitFor(() => expect(view.dom.querySelector(".cf-reference-preview .csl-entry")?.textContent).toContain("An uncited paper"));
    expect(view.dom.querySelector(".cf-reference-preview i")?.textContent).toBe("Journal of Examples");
    expect(view.dom.querySelector(".cf-reference-preview .csl-left-margin")).toBeNull();
    expect(view.dom.querySelector(".cf-reference-preview")?.textContent).not.toContain("[1]");
    expect(view.dom.querySelector(".cf-bibliography .csl-left-margin")?.textContent).toBe("[1]");
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
    expect(preview?.querySelector(".katex")).not.toBeNull();
    expect(preview?.textContent).not.toContain("$x$");
    expect(preview?.textContent).toContain("Unresolved reference");
    expect(preview?.querySelector("img")).toBeNull();
    expect(view.state.selection.main.head).toBe(0);
    expect(view.state.doc.toString()).toBe(doc);
    expect(getPandocTree(view.state).text).toBe(doc);
  });

  it.each([
    "## A *useful* result $x$ {#sec:result}",
    "A *useful* result $x$ {#sec:result}\n----------",
  ])("previews heading targets from the keyboard with rendered inline content: %s", async (heading) => {
    const doc = `# Introduction\n\n${heading}\n\nSee [@sec:result].`;
    const view = mount(doc, referencePreviewExtension(0));
    const tree = getPandocTree(view.state);
    const anchor = doc.lastIndexOf("sec:result") + 4;
    view.dispatch({ selection: { anchor } });
    key(view, " ", { ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(view.dom.querySelector(".cf-reference-preview h2 em")?.textContent).toBe("useful"));
    const preview = view.dom.querySelector(".cf-reference-preview");
    expect(preview?.querySelector("section > strong")?.textContent).toBe("Section 1.1");
    expect(preview?.querySelector("small")?.textContent).toBe("@sec:result");
    expect(preview?.querySelector("h2 .katex")).not.toBeNull();
    expect(preview?.textContent).not.toContain("{#sec:result}");
    expect(preview?.textContent).not.toContain("*useful*");
    expect(view.state.selection.main.head).toBe(anchor);
    expect(view.state.doc.toString()).toBe(doc);
    expect(getPandocTree(view.state)).toBe(tree);
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(0);
    key(view, "Escape");
    expect(hasHoverTooltips(view.state)).toBe(false);
  });

  it("opens previews from the keyboard and dismisses them on Escape, movement, and editing", async () => {
    const view = mount(localSource, referencePreviewExtension(0));
    const from = localSource.indexOf("@eq:main");
    view.dispatch({ selection: { anchor: from + 3 } });
    key(view, " ", { ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(view.dom.querySelector(".cf-reference-preview .katex-display")).not.toBeNull());
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

  it("renders target titles, prose, lists, and math from the existing CST and document macros", async () => {
    const doc = [
      "---",
      "math:",
      '  R: "\\\\mathbb{R}"',
      "---",
      "",
      '::: {.theorem #thm:rich title="A **strong** result over $\\R$"}',
      "Every *finite* `example` has $x \\in \\R$.",
      "A second source line with [a link](https://example.org).",
      "",
      "- First item",
      "- See [@thm:rich].",
      ":::",
      "",
      "See [@thm:rich].",
    ].join("\n");
    const view = mount(doc, referencePreviewExtension(0));
    const tree = getPandocTree(view.state);
    activateHover(view, doc.lastIndexOf("[@thm:rich]"), 1);
    await vi.waitFor(() => expect(view.dom.querySelector(".cf-reference-preview em")?.textContent).toBe("finite"));
    const preview = view.dom.querySelector(".cf-reference-preview");
    const heading = preview?.querySelector("section > strong");
    expect(heading?.textContent).toMatch(/^Theorem \(A strong result over .+\)$/);
    expect(heading?.querySelector("strong")?.textContent).toBe("strong");
    expect(heading?.querySelector(".katex")).not.toBeNull();
    expect(heading?.nextElementSibling?.textContent).toBe("@thm:rich");
    expect(heading?.nextElementSibling?.nextElementSibling?.querySelector("em")?.textContent).toBe("finite");
    expect(preview?.querySelector("code")?.textContent).toBe("example");
    expect(preview?.querySelectorAll(".katex")).toHaveLength(2);
    expect(preview?.querySelector(".katex-error")).toBeNull();
    expect(preview?.querySelector("p br")).not.toBeNull();
    expect(preview?.querySelector(".cf-link-rendered")?.textContent).toBe("a link");
    expect(preview?.querySelectorAll("li")).toHaveLength(2);
    expect(preview?.querySelector("li .cf-fenced-div-reference")?.textContent).toBe("Theorem 1");
    expect(preview?.textContent).not.toContain(":::");
    expect(preview?.textContent).not.toContain("$\\R$");
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.head).toBe(0);
    expect(getPandocTree(view.state)).toBe(tree);
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(0);
  });
});
