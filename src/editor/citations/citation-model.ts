import type { Transaction } from "@codemirror/state";
import {
  citationMode,
  normalizedCitationKey,
  type SourceRange,
  type SyntaxNode,
  type SyntaxTree,
} from "pandocmd-cst";
import { changedBlockRanges } from "../cst/decoration-ranges";
import { containingFencedDivOpener, fencedDivTitleRange } from "../cst/document-presentation";
import { getPandocInvalidations, getPandocTree } from "../cst/pandoc-cst-field";
import type {
  CitationClusterPresentation,
  CitationItemPresentation,
} from "./types";

function childOfKind(node: SyntaxNode, kind: SyntaxNode["kind"]): SyntaxNode | null {
  for (const child of node.children()) {
    if (child.kind === kind) return child;
  }
  return null;
}

function citationItem(node: SyntaxNode): CitationItemPresentation | null {
  const key = childOfKind(node, "CitationKey")?.text()
    ?? node.prop(normalizedCitationKey);
  if (!key) return null;
  const prefix = childOfKind(node, "CitationPrefix")?.text().trim();
  const locator = childOfKind(node, "CitationSuffix")?.text().trim();
  return {
    id: key,
    ...(locator ? { locator } : {}),
    ...(prefix ? { prefix } : {}),
    ...(node.prop(citationMode) === "suppress-author"
      ? { suppressAuthor: true }
      : {}),
  };
}

function clusterForNode(node: SyntaxNode): CitationClusterPresentation | null {
  if (node.kind === "ExampleReference") {
    const id = childOfKind(node, "CitationKey")?.text()
      ?? node.prop(normalizedCitationKey);
    if (!id) return null;
    return {
      from: node.from,
      items: [{ id }],
      narrative: true,
      raw: node.text(),
      to: node.to,
    };
  }
  if (node.kind !== "Citation") return null;
  const items = [...node.children()]
    .filter((child) => child.kind === "CitationItem")
    .map(citationItem)
    .filter((item): item is CitationItemPresentation => item !== null);
  if (items.length === 0) return null;
  return {
    from: node.from,
    items,
    narrative: false,
    raw: node.text(),
    to: node.to,
  };
}

export function collectCitationClusters(
  tree: SyntaxTree,
  range?: SourceRange,
): CitationClusterPresentation[] {
  const clusters: CitationClusterPresentation[] = [];
  tree.iterate((node) => {
    if (node.kind !== "Citation" && node.kind !== "ExampleReference") return;
    if (
      node.kind === "ExampleReference"
      && tree.semantics.example(node).status === "resolved"
    ) return false;
    const cluster = clusterForNode(node);
    if (cluster) {
      const div = containingFencedDivOpener(node);
      if (div) {
        const title = fencedDivTitleRange(div);
        if (!title || node.from < title.from || node.to > title.to) return false;
        const ending = childOfKind(div, "LineEnding");
        clusters.push({ ...cluster, opener: { from: div.from, to: ending?.from ?? div.to } });
      } else clusters.push(cluster);
    }
    return false;
  }, range);
  return clusters;
}

export function updateCitationClusters(
  transaction: Transaction,
  previous: readonly CitationClusterPresentation[],
): CitationClusterPresentation[] {
  const tree = getPandocTree(transaction.state);
  const { changes } = transaction;
  const { oldRanges, newRanges } = changedBlockRanges(
    transaction,
    getPandocInvalidations(transaction.state).semanticChangedRanges.filter((range) => (
      range.kinds.includes("example-number")
    )),
  );
  const clusters = new Map<number, CitationClusterPresentation>();
  for (const cluster of previous) {
    const from = changes.mapPos(cluster.from, 1);
    const to = changes.mapPos(cluster.to, -1);
    if (oldRanges.some((range) => (
      cluster.from < range.to && range.from < cluster.to
    )) || newRanges.some((range) => (
      from < range.to && range.from < to
    ))) continue;
    clusters.set(from, from === cluster.from && to === cluster.to
      ? cluster
      : {
        ...cluster, from, to,
        ...(cluster.opener ? { opener: {
          from: changes.mapPos(cluster.opener.from, 1),
          to: changes.mapPos(cluster.opener.to, -1),
        } } : {}),
      });
  }
  for (const range of newRanges) {
    for (const cluster of collectCitationClusters(tree, range)) {
      // Structural and example-resolution invalidations can overlap.
      clusters.set(cluster.from, cluster);
    }
  }
  return [...clusters.values()].sort((left, right) => left.from - right.from);
}
