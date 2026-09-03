import type { ChangeDesc } from "@codemirror/state";
import type { NodeKind, SyntaxNode, SyntaxTree } from "pandocmd-cst";

/** Version-bound source anchor for derived widgets and source reveals. */
export interface PandocNodeAnchor {
  readonly version: number;
  readonly kind: NodeKind;
  readonly from: number;
  readonly to: number;
}

export function createPandocNodeAnchor(
  tree: SyntaxTree,
  node: SyntaxNode,
): PandocNodeAnchor {
  if (node.treeToken !== tree.root.treeToken) {
    throw new TypeError("Cannot anchor a node from another CST snapshot");
  }
  return Object.freeze({
    version: tree.version,
    kind: node.kind,
    from: node.from,
    to: node.to,
  });
}

/**
 * Map only as a temporary optimization. Callers must resolve the result
 * against the new tree before reusing any widget or semantic cache entry.
 */
export function mapPandocNodeAnchor(
  anchor: PandocNodeAnchor,
  changes: ChangeDesc,
  newVersion: number,
): PandocNodeAnchor {
  const from = changes.mapPos(anchor.from, 1);
  const to = Math.max(from, changes.mapPos(anchor.to, -1));
  return Object.freeze({ ...anchor, version: newVersion, from, to });
}

export function resolvePandocNodeAnchor(
  tree: SyntaxTree,
  anchor: PandocNodeAnchor,
): SyntaxNode | null {
  if (
    anchor.version !== tree.version
    || anchor.from < 0
    || anchor.to < anchor.from
    || anchor.to > tree.length
  ) {
    return null;
  }

  let result: SyntaxNode | null = null;
  tree.iterate((node) => {
    if (
      result === null
      && node.kind === anchor.kind
      && node.from === anchor.from
      && node.to === anchor.to
    ) {
      result = node;
      return false;
    }
    return result === null;
  }, { from: anchor.from, to: anchor.to });
  return result;
}
