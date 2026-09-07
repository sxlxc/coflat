import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BibliographyStatus,
  mountEditor,
} from "../../../editor";
import { CslProcessor } from "./csl-processor";
import { CSS } from "../../core/constants/css-classes";
import { getPandocTree, pandocCstField } from "../cst/pandoc-cst-field";
import { cstYamlMetadataField } from "../cst/yaml-metadata";
import { citationResourceExtension, cstCitationSurface } from "./citation-surface";

const BIBTEX = `
@article{smith2024,
  author = {Smith, Alice},
  title = {A Useful Result},
  journal = {Journal of Examples},
  year = {2024}
}
@book{jones2020,
  author = {Jones, Bob},
  title = {An Uncited Book},
  year = {2020}
}
`;

describe("CST citation surface", () => {
  let editor: ReturnType<typeof mountEditor> | null = null;

  afterEach(() => {
    editor?.unmount();
    editor = null;
    vi.restoreAllMocks();
  });

  function mount(
    body: string,
    statuses: BibliographyStatus[] = [],
  ): HTMLElement {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = mountEditor({
      parent,
      doc: [
        "---",
        "bibliography: references.bib",
        "---",
        body,
      ].join("\n"),
      readTextResource: async (path) => {
        if (path === "references.bib") return BIBTEX;
        throw new Error(`Unexpected resource: ${path}`);
      },
      statusEvents: {
        onBibliographyStatusChange: (status) => statuses.push(status),
      },
    });
    return parent;
  }

  it("loads YAML bibliography data and renders citations plus a bibliography", async () => {
    const statuses: BibliographyStatus[] = [];
    const parent = mount("See [@smith2024, p. 7].", statuses);

    await vi.waitFor(() => {
      expect(parent.querySelector(`.${CSS.citation}`)?.textContent).toContain("1");
    });
    expect(parent.querySelector(`.${CSS.citation}`)?.textContent).toContain("7");
    expect(parent.querySelector(`.${CSS.bibliographyHeading}`)?.textContent)
      .toBe("Bibliography");
    expect(parent.querySelector(`.${CSS.bibliographyEntry}`)?.textContent)
      .toContain("A Useful Result");
    expect(statuses.map((status) => status.state)).toEqual(["loading", "ok"]);
    expect(editor?.getDoc()).toContain("See [@smith2024, p. 7].");

    parent.querySelector<HTMLElement>(`.${CSS.citation}`)?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    expect(parent.querySelector(`.${CSS.citation}`)).toBeNull();
    editor?.scrollToPosition(editor.getDoc().length);
    expect(parent.querySelector(`.${CSS.citation}`)?.textContent).toContain("1");
  });

  it("gives a local numbered target precedence over a bibliography key", async () => {
    const parent = mount([
      "::: {.lem #smith2024}",
      "Local result.",
      ":::",
      "",
      "See [@smith2024].",
    ].join("\n"));

    await vi.waitFor(() => {
      expect(parent.querySelector(`.${CSS.fencedDivReference}`)?.textContent)
        .toBe("Lemma 1");
    });
    expect(parent.querySelector(`.${CSS.citation}`)).toBeNull();
    expect(parent.querySelector(`.${CSS.bibliography}`)).toBeNull();
  });

  it("renders title citations on load, shares body numbering, and keeps opener source literal", async () => {
    const opener = '::: {.theorem title="中文 😀 *Result* [@jones2020, p. 7] and @smith2024"}';
    const statuses: BibliographyStatus[] = [];
    const parent = mount(`Before.\n\n${opener}\nBody [@smith2024].\n:::`, statuses);
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe("ok"));
    const header = parent.querySelector(`.${CSS.fencedDivHeader}`);
    expect(header?.querySelectorAll(`.${CSS.citation}`)).toHaveLength(2);
    expect(header?.querySelector(`.${CSS.citation}`)?.textContent).toContain("7");
    expect(header?.querySelector(`.${CSS.citationNarrative}`)?.textContent).toContain("Smith");
    expect(parent.querySelectorAll(`.${CSS.citation}`)).toHaveLength(3);
    expect(parent.querySelectorAll(`.${CSS.bibliographyEntry}`)).toHaveLength(2);
    expect(parent.querySelector(`.${CSS.bibliographyEntry}`)?.textContent).toContain("An Uncited Book");

    editor?.scrollToPosition(editor.getDoc().indexOf("Result"));
    expect(parent.querySelector(`.${CSS.fencedDivSource}`)?.textContent).toBe(opener);
    expect(parent.querySelectorAll(`.${CSS.citation}`)).toHaveLength(1);
    editor?.scrollToPosition(editor.getDoc().indexOf("Body"));
    expect(parent.querySelectorAll(`.${CSS.fencedDivHeader} .${CSS.citation}`)).toHaveLength(2);
    const original = editor?.getDoc() ?? "";
    editor?.setDoc(original.replace("Before.", "Before 中文 😀 [@smith2024]."));
    expect(parent.querySelector(`.${CSS.fencedDivHeader} .${CSS.citation}`)?.textContent).toContain("2");
    parent.querySelector<HTMLElement>(`.${CSS.fencedDivHeader} .${CSS.citation}`)?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    expect(parent.querySelector(`.${CSS.fencedDivSource}`)?.textContent).toBe(opener);
    editor?.insertText("X");
    expect(editor?.getDoc()).toContain("[X@jones2020, p. 7]");
    expect(editor?.getCst()?.text).toBe(editor?.getDoc());
  });

  it.each(["\n", "\r\n"])("updates title citation reveal when selections collapse at opener boundaries (%j)", async (lineEnding) => {
    const opener = '::: {.theorem title="中文 😀 Result [@smith2024]"}';
    const parent = mount(["Before.", "", opener, "Body.", ":::"].join(lineEnding));
    const view = EditorView.findFromDOM(parent.querySelector(".cm-editor") ?? parent);
    if (!view) throw new Error("Missing mounted editor view");
    await vi.waitFor(() => expect(parent.querySelector(`.${CSS.citation}`)?.textContent).toBe("[1]"));
    const source = view.state.doc.toString();
    const tree = getPandocTree(view.state);
    const from = source.indexOf(opener);
    const to = from + opener.length;
    for (const [anchor, head, boundary] of [[from - 1, from, from], [to, to + 1, to]]) {
      view.dispatch({ selection: { anchor, head } });
      expect(parent.querySelector(`.${CSS.fencedDivHeader} .${CSS.citation}`)?.textContent).toBe("[1]");
      view.dispatch({ selection: { anchor: boundary } });
      expect(view.state.selection.main.empty).toBe(true);
      expect(view.state.selection.main.head).toBe(boundary);
      expect(parent.querySelector(`.${CSS.fencedDivSource}`)?.textContent).toBe(opener);
      expect(parent.querySelector(`.${CSS.citation}`)).toBeNull();
      view.dispatch({ selection: { anchor, head } });
      expect(parent.querySelector(`.${CSS.fencedDivHeader} .${CSS.citation}`)?.textContent).toBe("[1]");
      expect(view.state.doc.toString()).toBe(source);
      expect(getPandocTree(view.state)).toBe(tree);
      expect(tree.text).toBe(source);
    }
  });

  it("keeps unknown title citations literal and excludes other attributes and inline code", async () => {
    const statuses: BibliographyStatus[] = [];
    const parent = mount('Before.\n\n::: {.remark title="[@missing] `[@smith2024]`" note="[@jones2020]"}\nBody.\n:::', statuses);
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe("ok"));
    expect(parent.querySelector(`.${CSS.fencedDivHeader}`)?.textContent).toBe("Remark ([@missing] [@smith2024])");
    expect(parent.querySelector(`.${CSS.citation}`)).toBeNull();
    expect(parent.querySelector(`.${CSS.bibliography}`)).toBeNull();
  });

  it("renders citations exposed beyond the first block of a split code fence", async () => {
    const statuses: BibliographyStatus[] = [];
    const parent = mount("Prose.\n\n~~~\n\n[@smith2024]\n~~~\n\nTail.", statuses);
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe("ok"));
    expect(parent.querySelector(`.${CSS.citation}`)).toBeNull();
    expect(parent.querySelector(`.${CSS.bibliography}`)).toBeNull();
    const original = editor?.getDoc() ?? "";
    const from = original.indexOf("~~~") - 1;

    editor?.setDoc(`${original.slice(0, from)}x${original.slice(from + 1)}`);

    expect(parent.querySelector(`.${CSS.citation}`)?.textContent).toBe("[1]");
    expect(parent.querySelector(`.${CSS.bibliographyEntry}`)?.textContent).toContain("A Useful Result");
    expect(editor?.getCst()?.text).toBe(editor?.getDoc());
  });

  it("assigns numeric labels in document order and recomputes them after edits", async () => {
    const parent = mount("First [@jones2020], then [@smith2024].");
    const citationText = (): string[] => [
      ...parent.querySelectorAll<HTMLElement>(`.${CSS.citation}`),
    ].map((citation) => citation.textContent ?? "");

    await vi.waitFor(() => {
      expect(citationText()).toEqual(["[1]", "[2]"]);
    });
    expect(parent.querySelector(`.${CSS.bibliographyEntry}`)?.textContent)
      .toContain("An Uncited Book");

    editor?.setDoc([
      "---",
      "bibliography: references.bib",
      "---",
      "First [@smith2024], then [@jones2020].",
    ].join("\n"));
    await vi.waitFor(() => {
      expect(citationText()).toEqual(["[1]", "[2]"]);
      expect(parent.querySelector(`.${CSS.bibliographyEntry}`)?.textContent)
        .toContain("A Useful Result");
    });
  });

  it("reuses formatted output across prose edits and maps source reveal positions", async () => {
    const register = vi.spyOn(CslProcessor.prototype, "registerCitations");
    const cite = vi.spyOn(CslProcessor.prototype, "cite");
    const bibliography = vi.spyOn(CslProcessor.prototype, "bibliographyEntries");
    const parent = mount("Prose.\n\nSee [@smith2024].");
    await vi.waitFor(() => expect(parent.querySelector(`.${CSS.citation}`)).not.toBeNull());
    const calls = [register.mock.calls.length, cite.mock.calls.length, bibliography.mock.calls.length];
    const original = editor?.getDoc() ?? "";
    editor?.setDoc(original.replace("Prose.", "中文 😀 Prose."));
    expect([register.mock.calls.length, cite.mock.calls.length, bibliography.mock.calls.length]).toEqual(calls);
    expect(editor?.getCst()?.text).toBe(editor?.getDoc());
    parent.querySelector<HTMLElement>(`.${CSS.citation}`)?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    editor?.insertText("X");
    expect(editor?.getDoc()).toContain("[X@smith2024]");
    expect(editor?.getCst()?.text).toBe(editor?.getDoc());
  });

  it("invalidates citation output when local target resolution changes", async () => {
    const statuses: BibliographyStatus[] = [];
    const parent = mount("See [@smith2024].", statuses);
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe("ok"));
    expect(parent.querySelector(`.${CSS.citation}`)).not.toBeNull();
    const original = editor?.getDoc() ?? "";
    editor?.setDoc(`${original}\n\n::: {.lem #smith2024}\nLocal.\n:::`);
    expect(parent.querySelector(`.${CSS.citation}`)).toBeNull();
    expect(parent.querySelector(`.${CSS.bibliography}`)).toBeNull();
    editor?.setDoc(original);
    expect(parent.querySelector(`.${CSS.citation}`)?.textContent).toBe("[1]");
  });

  it("retains citation decorations during prose typing and cursor movement", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const doc = "---\nbibliography: references.bib\n---\nProse.\n\nSee [@smith2024] and [@jones2020].";
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.indexOf("Prose") },
        extensions: [
          pandocCstField,
          cstYamlMetadataField,
          EditorState.allowMultipleSelections.of(true),
          citationResourceExtension({ readTextResource: async () => BIBTEX }),
          cstCitationSurface,
        ],
      }),
    });
    try {
      await vi.waitFor(() => expect(parent.querySelectorAll(`.${CSS.citation}`)).toHaveLength(2));
      const citation = parent.querySelector(`.${CSS.citation}`);
      const bibliography = parent.querySelector(`.${CSS.bibliography}`);
      const replace = vi.spyOn(Decoration, "replace");
      const widget = vi.spyOn(Decoration, "widget");
      const proseFrom = view.state.doc.toString().indexOf("Prose");
      for (let index = 0; index < 100; index += 1) {
        view.dispatch({ selection: { anchor: proseFrom + index % 5 } });
      }
      view.dispatch({ changes: { from: proseFrom, insert: "中文 😀 " } });
      expect(replace).not.toHaveBeenCalled();
      expect(widget).not.toHaveBeenCalled();
      expect(parent.querySelector(`.${CSS.citation}`)).toBe(citation);
      expect(parent.querySelector(`.${CSS.bibliography}`)).toBe(bibliography);

      const firstFrom = view.state.doc.toString().indexOf("[@smith2024]");
      const secondFrom = view.state.doc.toString().indexOf("[@jones2020]");
      view.dispatch({ selection: EditorSelection.create([
        EditorSelection.cursor(firstFrom + 1),
        EditorSelection.cursor(secondFrom + 1),
      ]) });
      expect(parent.querySelectorAll(`.${CSS.citation}`)).toHaveLength(0);
      view.dispatch({ selection: { anchor: firstFrom } });
      expect(parent.querySelectorAll(`.${CSS.citation}`)).toHaveLength(2);
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(view.state.selection.main.head).toBeGreaterThan(firstFrom);
      expect(view.state.selection.main.head).toBeLessThan(firstFrom + "[@smith2024]".length);
      expect(parent.querySelectorAll(`.${CSS.citation}`)).toHaveLength(1);
      expect(getPandocTree(view.state).text).toBe(view.state.doc.toString());
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("does not cite a bibliography key resolved as an example reference", async () => {
    const statuses: BibliographyStatus[] = [];
    const parent = mount("(@smith2024) First item.\n\nSee (@smith2024).", statuses);
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe("ok"));
    expect(parent.querySelector(`.${CSS.citation}`)).toBeNull();
    expect(parent.querySelector(`.${CSS.bibliography}`)).toBeNull();
    editor?.setDoc((editor.getDoc()).replace("(@smith2024) First item.", "Ordinary prose."));
    expect(parent.querySelector(`.${CSS.citation}`)).not.toBeNull();
    expect(parent.querySelector(`.${CSS.bibliographyEntry}`)?.textContent).toContain("A Useful Result");
  });

  it("reports a missing host resource loader without changing source", async () => {
    const statuses: BibliographyStatus[] = [];
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = mountEditor({
      parent,
      doc: "---\nbibliography: references.bib\n---\nSee [@smith2024].",
      statusEvents: {
        onBibliographyStatusChange: (status) => statuses.push(status),
      },
    });

    await vi.waitFor(() => {
      expect(statuses.at(-1)?.state).toBe("error");
    });
    expect(parent.querySelector(`.${CSS.citation}`)).toBeNull();
    expect(editor.getDoc()).toContain("[@smith2024]");
  });

  it("includes YAML nocite entries after in-text citations", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = mountEditor({
      parent,
      doc: [
        "---",
        "bibliography: references.bib",
        "nocite: '@*'",
        "---",
        "See [@smith2024].",
      ].join("\n"),
      readTextResource: async () => BIBTEX,
    });

    await vi.waitFor(() => {
      expect(parent.querySelectorAll(`.${CSS.bibliographyEntry}`)).toHaveLength(2);
    });
    expect([...parent.querySelectorAll(`.${CSS.bibliographyEntry}`)].map(
      (entry) => entry.textContent,
    ).join(" ")).toContain("An Uncited Book");
  });

  it("refreshes cached bibliography entries when nocite or resources change", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = mountEditor({
      parent,
      doc: "---\nbibliography: first.bib\n---\nSee [@smith2024].",
      readTextResource: async (path) => path === "first.bib"
        ? BIBTEX
        : BIBTEX.replace("A Useful Result", "A Revised Result"),
    });
    await vi.waitFor(() => expect(parent.querySelector(`.${CSS.citation}`)).not.toBeNull());
    editor.setDoc(editor.getDoc().replace("first.bib", "first.bib\nnocite: '@*'"));
    expect(parent.querySelectorAll(`.${CSS.bibliographyEntry}`)).toHaveLength(2);
    editor.setDoc(editor.getDoc().replace("first.bib", "second.bib"));
    await vi.waitFor(() => {
      expect(parent.querySelector(`.${CSS.bibliographyEntry}`)?.textContent).toContain("A Revised Result");
    });
    expect(editor.getCst()?.text).toBe(editor.getDoc());
  });

  it("does not append unused bibliography entries", async () => {
    const statuses: BibliographyStatus[] = [];
    const parent = mount("No citations in this document.", statuses);

    await vi.waitFor(() => {
      expect(statuses.at(-1)?.state).toBe("ok");
    });
    expect(parent.querySelector(`.${CSS.bibliography}`)).toBeNull();
    expect(editor?.getDoc()).toContain("No citations");
  });
});
import { EditorSelection, EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
