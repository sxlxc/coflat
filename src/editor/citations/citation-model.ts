import {
  citationMode,
  normalizedCitationKey,
  type SyntaxNode,
  type SyntaxTree,
} from "pandocmd-cst";
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
): CitationClusterPresentation[] {
  const clusters: CitationClusterPresentation[] = [];
  tree.iterate((node) => {
    if (node.kind !== "Citation" && node.kind !== "ExampleReference") return;
    if (
      node.kind === "ExampleReference"
      && tree.semantics.example(node).status === "resolved"
    ) return false;
    const cluster = clusterForNode(node);
    if (cluster) clusters.push(cluster);
    return false;
  });
  return clusters;
}
