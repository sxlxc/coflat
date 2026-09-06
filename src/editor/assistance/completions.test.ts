import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  CompletionContext,
  type CompletionResult,
  completionStatus,
  currentCompletions,
  nextSnippetField,
  prevSnippetField,
  setSelectedCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { EditorState, type Extension, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { citationResourceExtension, cstCitationSurface, getCitationItems } from "../citations/citation-surface";
import { cstDocumentPresentationField } from "../cst/document-presentation";
import { getPandocCstUpdateCountForTesting, getPandocTree, pandocCstField } from "../cst/pandoc-cst-field";
import { cstYamlMetadataField } from "../cst/yaml-metadata";
import { type CompletionOptions, editingCompletionExtension, editingCompletionSource } from "./completions";

const OPTIONS: CompletionOptions = { references: true, snippets: true, activateOnTyping: true };
const TARGET = "::: {.theorem #thm:main title=\"Central result\"}\nEvery finite set has a size.\n:::\n\n";

function markedState(marked: string, extensions: Extension = []): EditorState {
  const position = marked.indexOf("¦");
  if (position < 0) throw new Error("Missing cursor marker");
  const doc = marked.slice(0, position) + marked.slice(position + 1);
  return EditorState.create({
    doc: Text.of(doc.split("\n")),
    selection: { anchor: position },
    extensions: [pandocCstField, cstDocumentPresentationField, extensions],
  });
}

async function complete(
  marked: string,
  explicit = false,
  options: CompletionOptions = OPTIONS,
): Promise<CompletionResult | null> {
  const state = markedState(marked);
  return editingCompletionSource(options)(new CompletionContext(state, state.selection.main.head, explicit));
}

describe("CST editing completions", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const view of views) {
      view.destroy();
      view.dom.remove();
    }
    views.length = 0;
  });

  function mount(marked: string, options = OPTIONS, extensions: Extension = []): EditorView {
    const view = new EditorView({
      parent: document.body,
      state: markedState(marked, [
        history(),
        editingCompletionExtension(options),
        autocompletion({ interactionDelay: 0 }),
        extensions,
      ]),
    });
    views.push(view);
    view.focus();
    return view;
  }

  async function select(view: EditorView, label: string): Promise<void> {
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => expect(currentCompletions(view.state).map((item) => item.label)).toContain(label));
    const index = currentCompletions(view.state).findIndex((item) => item.label === label);
    view.dispatch({ effects: setSelectedCompletion(index) });
    expect(acceptCompletion(view)).toBe(true);
  }

  it.each(["@¦", "[@¦]", "-@¦", "[@other; -@thm:¦, p. 2]", "*@thm:¦*", "@Central¦"])(
    "suggests local targets in %s, including metadata search",
    async (text) => {
      const result = await complete(TARGET + text);
      expect(result?.options).toContainEqual(expect.objectContaining({
        label: "thm:main",
        displayLabel: "@thm:main",
        detail: "Theorem 1 · Central result",
      }));
    },
  );

  it.each([
    "`@thm:¦`", "```text\n@thm:¦\n```", "    @thm:¦", "$@thm:¦$", "$$\n@thm:¦\n$$",
    "[link](@thm:¦)", "![alt](@thm:¦)", "<https://host/@thm:¦>",
    "\\@thm:¦", "person@thm:¦", "中文@thm:¦", "<script>@thm:¦</script>",
    "::: {.theorem title=\"@thm:¦\"}\nText.\n:::",
  ])("suppresses references in non-prose context %s", async (text) => {
    expect(await complete(TARGET + text)).toBeNull();
  });

  it("suppresses frontmatter and raw inline contents", async () => {
    expect(await complete("---\ntitle: @thm:¦\n---\n" + TARGET, true)).toBeNull();
    expect(await complete(TARGET + "`@thm:¦`{=latex}", true)).toBeNull();
  });

  it.each(["[^@¦]", "[^str¦ong]", "[^@¦]: Body.", "[^str¦ong]: Body.", "[^¦note]: Body.", "[^note]¦: Body."])(
    "suppresses reference and markup completion in footnote identifiers: %s",
    async (text) => {
      expect(await complete(TARGET + text, true)).toBeNull();
    },
  );

  it.each(["[^note]: See @¦", "[^note]: Body.\n    See @¦", "An inline note^[See @¦]."])(
    "keeps references and inline snippets available in footnote prose: %s",
    async (text) => {
      expect((await complete(TARGET + text))?.options.map((item) => item.label)).toContain("thm:main");
      const snippets = await complete(text.replace("@¦", "¦"), true);
      expect(snippets?.options.map((item) => item.label)).toContain("strong");
      expect(snippets?.options.map((item) => item.label)).not.toContain("theorem");
    },
  );

  it("replaces the entire key in a cluster while preserving the suffix and synchronized undo", async () => {
    const marked = TARGET + "中文 😀 See [@other; -@thm:ma¦inOld, p. 42].\r\n";
    const view = mount(marked);
    const original = view.state.doc.toString();
    const oldTree = getPandocTree(view.state);
    await select(view, "thm:main");
    expect(view.state.doc.toString()).toBe(original.replace("thm:mainOld", "thm:main"));
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf(", p. 42"));
    expect(getPandocTree(view.state).text).toBe(view.state.doc.toString());
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(1);
    expect(getPandocTree(view.state)).not.toBe(oldTree);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(original);
    expect(getPandocTree(view.state).text).toBe(original);
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(2);
  });

  it.each(["@thm:ma¦in.", "_@thm:ma¦in_", "[@thm:ma¦in; @other]"])(
    "keeps CST-delimited punctuation and markup in %s",
    async (text) => {
      const view = mount(TARGET + text);
      const original = view.state.doc.toString();
      await select(view, "thm:main");
      expect(view.state.doc.toString()).toBe(original);
    },
  );

  it.each([
    ["_See @¦_", "_See @thm:main_"],
    ["~~See @¦~~", "~~See @thm:main~~"],
    ["_@¦_", "_@thm:main_"],
    ["__@¦__", "__@thm:main__"],
    ["~@¦~", "~@thm:main~"],
    ["[_@¦_](target)", "[_@thm:main_](target)"],
    ["_@thm:¦_", "_@thm:main_"],
    ["[@¦thm:old]", "[@thm:main]"],
    ["@¦:old", "@thm:main"],
  ])("bounds unfinished reference matching by the CST in %s", async (text, expected) => {
    const prefix = TARGET + "中文 😀 ";
    const view = mount(prefix + text + "\r\n");
    await select(view, "thm:main");
    expect(view.state.doc.toString()).toBe(prefix + expected + "\r\n");
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(prefix.length + expected.indexOf("@thm:main") + "@thm:main".length);
    expect(getPandocTree(view.state).text).toBe(view.state.doc.toString());
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(1);
  });

  it.each([
    ["**¦", "strong"], ["$$¦", "display math"], ["```¦", "code fence"], [":::¦", "theorem"],
  ])("offers canonical templates for %s", async (text, label) => {
    const result = await complete(text);
    expect(result?.from).toBe(0);
    expect(result?.options.map((option) => option.label)).toContain(label);
  });

  it("offers explicit snippets without automatic prose suggestions", async () => {
    expect(await complete("The theorem¦")).toBeNull();
    const result = await complete("¦", true);
    expect(result?.options.map((option) => option.label)).toEqual(expect.arrayContaining([
      "emphasis", "strong", "link", "inline math", "display math", "heading", "code fence", "fenced div", "equation",
    ]));
    expect((await complete("@unknown¦", true))?.options).toEqual([]);
  });

  it.each([
    "::: {.theorem #thm:a}\nBody.\n:::\n¦", "```\nx\n```\n¦", "A paragraph.\n¦", "# Heading\n¦", "#¦",
    "```\nx\n```\n¦\nFollowing.", "::: {.theorem}\nBody.\n:::\n¦\nFollowing.",
    "---\ntitle: Test\n---\n¦\nFollowing.",
  ])("offers block templates on a new root line or heading trigger: %s", async (marked) => {
    const result = await complete(marked, true);
    expect(result?.options.map((item) => item.label)).toContain("heading");
  });

  it("keeps unclosed div containers authoritative", async () => {
    const result = await complete("::: {.theorem}\nBody.\n¦", true);
    expect(result?.options.map((item) => item.label) ?? []).not.toContain("theorem");
  });

  it("suppresses prose suggestions on blank lines inside code blocks", async () => {
    expect(await complete("```\nx\n¦\ny\n```", true)).toBeNull();
  });

  it.each([
    "::: {.theorem}\n\n¦\n:::", "- ¦", "> ¦", "| A | B |\n|---|---|\n| ¦ | x |",
    "::: {.theorem}\n```\nx\n```\n¦\nFollowing.\n:::",
  ])("suppresses block snippets inside containers: %s", async (marked) => {
    const result = await complete(marked, true);
    expect(result?.options.map((item) => item.label) ?? []).not.toContain("theorem");
    expect(result?.options.map((item) => item.label) ?? []).not.toContain("code fence");
  });

  it("inserts a labeled theorem with navigable fields and one CST update", async () => {
    const view = mount(":::¦");
    await select(view, "theorem");
    expect(view.state.doc.toString()).toBe("::: {.theorem #thm:name title=\"Title\"}\nStatement.\n:::\n");
    const selectionText = (): string => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    expect(selectionText()).toBe("name");
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(1);
    expect(nextSnippetField(view)).toBe(true);
    expect(selectionText()).toBe("Title");
    expect(prevSnippetField(view)).toBe(true);
    expect(selectionText()).toBe("name");
    expect(nextSnippetField(view)).toBe(true);
    expect(nextSnippetField(view)).toBe(true);
    expect(selectionText()).toBe("Statement.");
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(1);
    expect(getPandocTree(view.state).text).toBe(view.state.doc.toString());
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(":::");
    expect(getPandocTree(view.state).text).toBe(":::");
  });

  it("creates a canonical equation wrapper", async () => {
    const view = mount(":::¦");
    await select(view, "equation");
    const kinds: string[] = [];
    getPandocTree(view.state).iterate((node) => { kinds.push(node.kind); });
    expect(kinds).toContain("FencedDiv");
    expect(kinds).toContain("Math");
    expect(view.state.doc.toString()).toBe("::: {.equation #eq:name}\n$$\nx = y\n$$\n:::\n");
  });

  it("separates a new block template from preceding prose", async () => {
    const view = mount("Paragraph.\n¦");
    await select(view, "heading");
    expect(view.state.doc.toString()).toBe("Paragraph.\n\n## Heading\n\n");
    expect(getPandocTree(view.state).text).toBe(view.state.doc.toString());
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(1);
  });

  it("inserts a block snippet between a closed fence and following prose", async () => {
    const view = mount("```\nx\n```\n¦\nFollowing.");
    await select(view, "heading");
    expect(view.state.doc.toString()).toBe("```\nx\n```\n\n## Heading\n\n\nFollowing.");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("Heading");
    expect(getPandocTree(view.state).text).toBe(view.state.doc.toString());
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(1);
  });

  it("respects independent switches, readonly state, and nonempty selection", async () => {
    expect(await complete(TARGET + "@¦", true, { ...OPTIONS, references: false })).toBeNull();
    expect(await complete(":::¦", true, { ...OPTIONS, snippets: false })).toBeNull();
    expect(editingCompletionExtension({ ...OPTIONS, references: false, snippets: false })).toEqual([]);
    const readonly = markedState(TARGET + "@¦", EditorState.readOnly.of(true));
    expect(await editingCompletionSource(OPTIONS)(new CompletionContext(readonly, readonly.selection.main.head, true))).toBeNull();
    const selected = markedState("strong¦").update({ selection: { anchor: 0, head: 3 } }).state;
    expect(await editingCompletionSource(OPTIONS)(new CompletionContext(selected, 3, true))).toBeNull();
  });

  it("supports manual completion when automatic activation is disabled", async () => {
    const view = mount(TARGET + "¦", { ...OPTIONS, activateOnTyping: false });
    view.dispatch({ changes: { from: view.state.doc.length, insert: "@" }, selection: { anchor: view.state.doc.length + 1 }, userEvent: "input.type" });
    expect(completionStatus(view.state)).toBeNull();
    await select(view, "thm:main");
    expect(view.state.doc.toString().endsWith("@thm:main")).toBe(true);
  });

  it.each(["renamed", "removed", "retitled"])("refreshes open references when a target is %s elsewhere", async (change) => {
    const view = mount(TARGET + "See @¦");
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state).map((item) => item.label)).toEqual(["thm:main"]));
    const oldText = change === "retitled" ? "Central result" : "#thm:main";
    const insert = change === "renamed" ? "#thm:renamed" : change === "retitled" ? "Updated result" : "";
    const from = view.state.doc.toString().indexOf(oldText);
    // A host update outside the active range has no typing user event.
    view.dispatch({ changes: { from, to: from + oldText.length, insert } });
    const expectedLabel = change === "renamed" ? "thm:renamed" : "thm:main";
    await vi.waitFor(() => {
      if (change === "removed") {
        expect(completionStatus(view.state)).toBeNull();
        expect(currentCompletions(view.state)).toEqual([]);
      } else {
        expect(currentCompletions(view.state).map((item) => item.label)).toEqual([expectedLabel]);
        expect(view.dom.querySelector(".cm-completionDetail")?.textContent)
          .toContain(change === "retitled" ? "Updated result" : "Central result");
      }
    });
    if (change !== "removed") {
      expect(acceptCompletion(view)).toBe(true);
      expect(view.state.doc.toString().endsWith(`See @${expectedLabel}`)).toBe(true);
    } else {
      expect(acceptCompletion(view)).toBe(false);
      expect(view.state.doc.toString().endsWith("See @")).toBe(true);
    }
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(getPandocTree(view.state).text).toBe(view.state.doc.toString());
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(change === "removed" ? 1 : 2);
  });

  it.each(["loaded", "dismissed", "edited", "destroyed"])("handles pending bibliography completion when %s", async (outcome) => {
    let release: ((value: string) => void) | undefined;
    const readTextResource = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const view = mount("---\nbibliography: refs.json\n---\n\n@¦", OPTIONS, [
      cstYamlMetadataField,
      cstCitationSurface,
      citationResourceExtension({ readTextResource }),
    ]);
    startCompletion(view);
    await vi.waitFor(() => expect(readTextResource).toHaveBeenCalled());
    // Let CM actually invoke the source (its explicit-query delay is 50 ms).
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(completionStatus(view.state)).toBe("pending");
    expect(currentCompletions(view.state)).toEqual([]);
    if (outcome === "dismissed") expect(closeCompletion(view)).toBe(true);
    if (outcome === "edited") {
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end - 1, to: end, insert: "plain" }, selection: { anchor: end + 4 }, userEvent: "input.type" });
    }
    if (outcome === "destroyed") {
      view.destroy();
      view.dom.remove();
      views.splice(views.indexOf(view), 1);
    }
    release?.(JSON.stringify([{ id: "smith2024", type: "book", title: "A useful book" }]));
    if (outcome === "destroyed") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(getCitationItems(view.state)).toEqual([]);
      return;
    }
    await vi.waitFor(() => expect(getCitationItems(view.state).length).toBe(1));
    if (outcome !== "loaded") {
      await vi.waitFor(() => expect(completionStatus(view.state)).toBeNull());
      expect(currentCompletions(view.state)).toEqual([]);
    } else {
      await vi.waitFor(() => expect(currentCompletions(view.state).map((item) => item.label)).toEqual(["smith2024"]));
      expect(view.dom.querySelector(".cm-completionLabel")?.textContent).toBe("@smith2024");
    }
    expect(getPandocCstUpdateCountForTesting(view.state)).toBe(outcome === "edited" ? 1 : 0);
  });
});
