import { type ChangeSpec, EditorState } from "@codemirror/state";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  buildDocumentPresentation,
  cstDocumentPresentationField,
  getDocumentPresentation,
} from "./document-presentation";
import { getPandocTree, pandocCstField } from "./pandoc-cst-field";

const source = [
  "Before 中文 😀.",
  "",
  ":::: {.theorem #thm:first}",
  "Statement with $x$.",
  "",
  "::: {.equation #eq:first}",
  "$$x=1$$",
  ":::",
  "::::",
  "",
  "::: {.lemma #thm:second}",
  "Another statement.",
  ":::",
  "",
  "::: {.equation #eq:second}",
  "$$y=2$$",
  ":::",
  "",
  "After [@thm:first] and [@eq:first].",
].join("\n");

function stateFor(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [pandocCstField, cstDocumentPresentationField],
  });
}

describe("incremental document presentation", () => {
  it("removes remote targets when a YAML edit reparses the full CST", () => {
    const doc = "---\ntitle: Old\n---\n\nUnrelated.\n\nText.\n::: {.theorem #thm:a}\n$$x$$\n:::";
    const before = stateFor(doc);
    const edited = before.update({ changes: { from: doc.indexOf("Text.") + 1, insert: "$$" } }).state;
    expect(getDocumentPresentation(edited)).toEqual(buildDocumentPresentation(getPandocTree(edited)));

    const after = edited.update({ changes: { from: doc.indexOf("Old"), to: doc.indexOf("Old") + 3, insert: "New" } }).state;
    expect(getPandocTree(after).topLevelBlocks().some((node) => node.kind === "FencedDiv")).toBe(false);
    expect(getDocumentPresentation(after).localTargets.has("thm:a")).toBe(false);
    expect(getDocumentPresentation(after)).toEqual(buildDocumentPresentation(getPandocTree(after)));
    expect(getPandocTree(after).text).toBe(after.doc.toString());
  });

  it("matches a full rebuild across syntax and Unicode replacements", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: source.length }),
      fc.integer({ min: 0, max: source.length }),
      fc.constantFrom("", "😀", "\n", "\n\n", "$$", "::: {.equation #eq:new}\n", "::::", "theorem"),
      (left, right, insert) => {
        const before = stateFor(source);
        const after = before.update({
          changes: { from: Math.min(left, right), to: Math.max(left, right), insert },
        }).state;
        expect(getDocumentPresentation(after)).toEqual(
          buildDocumentPresentation(getPandocTree(after)),
        );
      },
    ), { numRuns: 200, seed: 417 });
  });

  it.each([
    "x::: {.theorem #thm:new}\nBody.\n:::\n\n::: {.lemma #thm:next}\nNext.\n:::",
    "x::: {.equation #eq:new}\n$$x=1$$\n:::\n\n::: {.equation #eq:next}\n$$y=2$$\n:::",
  ])("finds targets in the remainder of a split paragraph", (doc) => {
    const before = stateFor(doc);
    const after = before.update({ changes: { from: 0, to: 1, insert: "\n" } }).state;
    expect(getDocumentPresentation(after)).toEqual(
      buildDocumentPresentation(getPandocTree(after)),
    );
    expect(getDocumentPresentation(after).localTargets.size).toBeGreaterThan(
      getDocumentPresentation(before).localTargets.size,
    );
  });

  it.each<readonly [string, ChangeSpec]>([
    ["prose before all targets", { from: 3, insert: "中文 😀" }],
    ["prose inside a theorem", { from: source.indexOf("Statement") + 3, insert: " more" }],
    ["equation body", { from: source.indexOf("x=1") + 1, insert: "+z" }],
    ["block kind", { from: source.indexOf("theorem"), to: source.indexOf("theorem") + 7, insert: "proof" }],
    ["target id", { from: source.indexOf("thm:first"), to: source.indexOf("thm:first") + 9, insert: "thm:renamed" }],
    ["new first block", { from: 0, insert: "::: {.lemma #thm:new}\nNew.\n:::\n\n" }],
    ["new first equation", { from: 0, insert: "::: {.equation #eq:new}\n$$z=0$$\n:::\n\n" }],
    ["multiple equations in a wrapper", { from: source.indexOf("$$x=1$$") + 7, insert: "\n\n$$z=0$$" }],
    ["remove equation wrapper", { from: source.indexOf("::: {.equation"), to: source.indexOf("$$x=1$$"), insert: "" }],
    ["remove first target", { from: source.indexOf(":::: {.theorem"), to: source.indexOf("::: {.lemma"), insert: "" }],
    ["move wrapper boundary", { from: source.indexOf("$$x=1$$"), insert: ":::\n\n" }],
    ["separate edits", [
      { from: 3, insert: "中文 😀" },
      { from: source.indexOf("y=2") + 1, insert: "+w" },
    ]],
    ["replace whole document", { from: 0, to: source.length, insert: "" }],
  ])("matches a full rebuild after %s", (_name, changes) => {
    const before = stateFor(source);
    const after = before.update({ changes }).state;
    expect(getDocumentPresentation(after)).toEqual(
      buildDocumentPresentation(getPandocTree(after)),
    );
    expect(getPandocTree(after).text).toBe(after.doc.toString());
    expect(getDocumentPresentation(before)).toEqual(
      buildDocumentPresentation(getPandocTree(before)),
    );
  });

  it("keeps target identities when prose and equation bodies change", () => {
    const before = stateFor(source);
    const presentation = getDocumentPresentation(before);
    const transaction = before.update({ changes: [
      { from: 3, insert: "中文 😀" },
      { from: source.indexOf("Statement") + 3, insert: " more" },
      { from: source.indexOf("x=1") + 1, insert: "+z" },
    ] });
    const after = getDocumentPresentation(transaction.state);
    expect(after.localTargets).toBe(presentation.localTargets);
    for (const [from, value] of presentation.fencedDivsByFrom) {
      expect(after.fencedDivsByFrom.get(transaction.changes.mapPos(from, 1))).toBe(value);
    }
    for (const [from, value] of presentation.equationsByMathFrom) {
      expect(after.equationsByMathFrom.get(transaction.changes.mapPos(from, 1))).toBe(value);
    }
  });

  it("limits presentation traversal to the changed CST region in a large paper", () => {
    const doc = `${"Ordinary *prose* with $x$.\n\n".repeat(24_000)}${source}`;
    const before = stateFor(doc);
    const tree = getPandocTree(before);
    const prototype: Pick<typeof tree, "iterate"> = Object.getPrototypeOf(tree);
    const iterate = tree.iterate;
    let visited = 0;
    const spy = vi.spyOn(prototype, "iterate").mockImplementation(function (
      this: typeof tree,
      visitor: Parameters<typeof tree.iterate>[0],
      range: Parameters<typeof tree.iterate>[1],
    ) {
      iterate.call(this, {
        enter(node) {
          visited += 1;
          return typeof visitor === "function" ? visitor(node) : visitor.enter?.(node);
        },
        leave: typeof visitor === "function" ? undefined : visitor.leave,
      }, range);
    });
    try {
      const after = before.update({ changes: { from: doc.indexOf("Statement") + 3, insert: " more" } }).state;
      expect(visited).toBeLessThan(200);
      expect(getDocumentPresentation(after).localTargets).toBe(getDocumentPresentation(before).localTargets);
      expect(getPandocTree(after).text).toBe(after.doc.toString());
    } finally {
      spy.mockRestore();
    }
  });
});
