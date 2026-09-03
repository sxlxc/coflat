import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { PandocParser, type SyntaxNode } from "pandocmd-cst";
import {
  createPandocNodeAnchor,
  mapPandocNodeAnchor,
  resolvePandocNodeAnchor,
} from "./pandoc-anchor";

function first(tree: ReturnType<PandocParser["parse"]>, kind: SyntaxNode["kind"]): SyntaxNode {
  let found: SyntaxNode | null = null;
  tree.iterate((node) => {
    if (node.kind === kind) {
      found = node;
      return false;
    }
  });
  if (!found) throw new Error(`Missing ${kind}`);
  return found;
}

describe("Pandoc CST node anchors", () => {
  it("rejects stale anchors and validates mapped anchors against the new snapshot", () => {
    const parser = new PandocParser();
    const before = parser.parse("prefix\n\n**bold**\n");
    const bold = first(before, "Strong");
    const anchor = createPandocNodeAnchor(before, bold);
    expect(resolvePandocNodeAnchor(before, anchor)?.text()).toBe("**bold**");

    const insert = "new ";
    const changes = ChangeSet.of({ from: 0, insert }, before.length);
    const after = parser.update(insert + before.text, before, [{
      oldFrom: 0,
      oldTo: 0,
      newFrom: 0,
      newTo: insert.length,
    }]).tree;
    expect(resolvePandocNodeAnchor(after, anchor)).toBeNull();

    const mapped = mapPandocNodeAnchor(anchor, changes, after.version);
    expect(resolvePandocNodeAnchor(after, mapped)?.text()).toBe("**bold**");
  });
});
