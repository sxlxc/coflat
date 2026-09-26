import { parse as parseYaml } from "yaml";
import { parseInlines } from "../inline/parser.js";
import type { GreenNode, NodeKind } from "../nodes.js";
import type { SyntaxNode } from "../tree.js";

/** Inline semantics use decoded YAML text, not document source offsets. */
export interface MetadataInline {
  readonly kind: NodeKind;
  readonly text: string;
  readonly children: readonly MetadataInline[];
}

export interface MetadataTitle {
  readonly text: string;
  readonly children: readonly MetadataInline[];
}

function inlineNodes(text: string, nodes: readonly GreenNode[]): readonly MetadataInline[] {
  let offset = 0;
  return Object.freeze(nodes.map(node => {
    const source = text.slice(offset, offset + node.length);
    offset += node.length;
    return Object.freeze({ kind: node.kind, text: source, children: inlineNodes(source, node.children) });
  }));
}

export function readMetadataTitle(node: SyntaxNode): MetadataTitle | null {
  const children = [...node.children()];
  const firstEnding = children.find(child => child.kind === "LineEnding");
  const closer = children.filter(child => child.kind === "Delimiter").at(-1);
  if (!firstEnding || !closer) return null;
  let metadata: unknown;
  try {
    metadata = parseYaml(node.text().slice(firstEnding.to - node.from, closer.from - node.from));
  } catch {
    // Incomplete YAML is normal while editing; no metadata is published yet.
    return null;
  }
  if (typeof metadata !== "object" || metadata === null || !("title" in metadata)
    || typeof metadata.title !== "string" || !metadata.title) return null;
  return Object.freeze({ text: metadata.title, children: inlineNodes(metadata.title, parseInlines(metadata.title)) });
}
