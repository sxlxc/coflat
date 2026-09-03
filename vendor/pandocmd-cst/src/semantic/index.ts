import {
  exampleLabel, explicitIdentifier, footnoteLabel, headingLevel, normalizedCitationKey, normalizedReferenceLabel,
  orderedListStyle, referenceDestination, referenceForm, referenceTitle,
  type ReferenceForm,
} from "../nodes.js";
import type { SyntaxNode } from "../tree.js";

export interface ReferenceResolution {
  readonly status: "resolved" | "unresolved";
  readonly form: ReferenceForm;
  readonly definition: SyntaxNode | null;
  readonly destination: string | null;
  readonly title: string | null;
}

export interface HeadingInfo {
  readonly level: number;
  readonly identifier: string;
  readonly explicit: boolean;
}

export interface FootnoteResolution {
  readonly status: "resolved" | "unresolved";
  readonly definition: SyntaxNode | null;
}

export interface ExampleResolution {
  readonly status: "resolved" | "unresolved";
  readonly number: number | null;
}

export interface DocumentSemantics {
  reference(candidate: SyntaxNode): ReferenceResolution;
  heading(node: SyntaxNode): HeadingInfo;
  footnote(reference: SyntaxNode): FootnoteResolution;
  example(reference: SyntaxNode): ExampleResolution;
}

interface DefinitionRecord { node: SyntaxNode; destination: string; title: string }
export interface SemanticSnapshot {
  readonly references: ReadonlyMap<string, string>;
  readonly headings: ReadonlyMap<string, string>;
  readonly footnotes: ReadonlySet<string>;
  readonly examples: ReadonlyMap<string, number>;
}

function slug(value: string): string {
  const stripped = value
    .replace(/\{[^}]*\}\s*$/, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~^\[\]()]|&(?:#\d+|#x[\da-f]+|\w+);/gi, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return stripped || "section";
}

function entityText(source: string): string {
  if (/^&#x/i.test(source)) return String.fromCodePoint(Number.parseInt(source.slice(3, -1), 16));
  if (source.startsWith("&#")) return String.fromCodePoint(Number.parseInt(source.slice(2, -1), 10));
  return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" } as Record<string, string>)[source.slice(1, -1)] ?? source;
}

/** Pandoc identifiers use rendered inline content, not lossless marker text. */
function headingInlineText(node: SyntaxNode): string {
  switch (node.kind) {
    case "InlineText": return node.text();
    case "Space": case "SoftBreak": case "LineBreak": return " ";
    case "Escape": return node.text().slice(1);
    case "Entity": return entityText(node.text());
    case "Code": return [...node.children()].find(child => child.kind === "OpaqueBody")?.text() ?? "";
    case "AutoLink": return node.text().slice(1, -1).replace(/^mailto:/, "");
    case "Math": case "RawInline": case "Citation": case "FootnoteReference": case "ExampleReference": return "";
    case "AttributeList": case "LinkDestination": case "LinkTitle": case "ReferenceLabel": case "CitationKey":
    case "Delimiter": case "BracketMark": case "ParenMark": case "CodeMark": case "MathMark": case "HtmlTag":
    case "Whitespace": case "LineEnding": return "";
    default: return [...node.children()].map(headingInlineText).join("");
  }
}

export class DocumentSemanticsImpl implements DocumentSemantics {
  readonly snapshot: SemanticSnapshot;
  readonly #treeToken: object;
  readonly #definitions = new Map<string, DefinitionRecord>();
  readonly #implicitHeadings = new Map<string, { node: SyntaxNode; destination: string }>();
  readonly #headings = new Map<string, HeadingInfo>();
  readonly #footnotes = new Map<string, SyntaxNode>();
  readonly #examples = new Map<string, number>();

  constructor(treeToken: object, nodes: readonly SyntaxNode[]) {
    this.#treeToken = treeToken;
    const used = new Map<string, number>();
    for (const node of nodes) {
      if (node.kind === "ReferenceDefinition") {
        const label = node.prop(normalizedReferenceLabel);
        if (label !== undefined && !this.#definitions.has(label)) this.#definitions.set(label, {
          node, destination: node.prop(referenceDestination) ?? "", title: node.prop(referenceTitle) ?? "",
        });
      } else if (node.kind === "FootnoteDefinition") {
        const label = node.prop(footnoteLabel);
        if (label !== undefined && !this.#footnotes.has(label)) this.#footnotes.set(label, node);
      } else if (node.kind === "AtxHeading" || node.kind === "SetextHeading") {
        const explicit = node.prop(explicitIdentifier);
        const headingText = headingInlineText(node).trim().replace(/[\t\r\n ]+/g, " ");
        const base = explicit ?? slug(headingText);
        const seen = used.get(base) ?? 0;
        used.set(base, seen + 1);
        const identifier = explicit ?? (seen === 0 ? base : `${base}-${seen}`);
        this.#headings.set(`${node.from}:${node.to}`, { level: node.prop(headingLevel) ?? 1, identifier, explicit: explicit !== undefined });
        const normalizedHeading = headingText.trim().replace(/[\t\r\n ]+/g, " ").toLocaleLowerCase();
        if (normalizedHeading && !this.#implicitHeadings.has(normalizedHeading)) this.#implicitHeadings.set(normalizedHeading, { node, destination: `#${identifier}` });
      }
    }
    let exampleNumber = 0;
    for (const node of nodes) {
      if (node.kind !== "ListItem" || node.parent?.prop(orderedListStyle) !== "example") continue;
      exampleNumber++;
      const label = node.prop(exampleLabel);
      if (label !== undefined && !this.#examples.has(label)) this.#examples.set(label, exampleNumber);
    }
    const effectiveReferences = new Map([...this.#implicitHeadings].map(([label, record]) => [label, `${record.destination}\u0000`]));
    for (const [label, record] of this.#definitions) effectiveReferences.set(label, `${record.destination}\u0000${record.title}`);
    this.snapshot = Object.freeze({
      references: effectiveReferences,
      headings: new Map([...this.#headings].map(([range, info]) => [range, info.identifier])),
      footnotes: new Set(this.#footnotes.keys()),
      examples: new Map(this.#examples),
    });
  }

  #assert(node: SyntaxNode): void {
    if (node.treeToken !== this.#treeToken) throw new TypeError("Semantic queries require a node from the same SyntaxTree snapshot");
  }

  reference(candidate: SyntaxNode): ReferenceResolution {
    this.#assert(candidate);
    if (candidate.kind !== "ReferenceCandidate" && candidate.kind !== "ImageReferenceCandidate") throw new TypeError("reference() requires a reference-candidate node");
    const form = candidate.prop(referenceForm) ?? "shortcut";
    const label = candidate.prop(normalizedReferenceLabel) ?? "";
    const definition = this.#definitions.get(label);
    if (definition) return { status: "resolved", form, definition: definition.node, destination: definition.destination, title: definition.title };
    const heading = form === "shortcut" ? this.#implicitHeadings.get(label) : undefined;
    return heading
      ? { status: "resolved", form: "implicit-heading", definition: heading.node, destination: heading.destination, title: null }
      : { status: "unresolved", form, definition: null, destination: null, title: null };
  }

  heading(node: SyntaxNode): HeadingInfo {
    this.#assert(node);
    const info = this.#headings.get(`${node.from}:${node.to}`);
    if (!info) throw new TypeError("heading() requires a heading node");
    return info;
  }

  footnote(reference: SyntaxNode): FootnoteResolution {
    this.#assert(reference);
    if (reference.kind !== "FootnoteReference") throw new TypeError("footnote() requires a footnote-reference node");
    const label = reference.text().slice(2, -1).trim().toLocaleLowerCase();
    const definition = this.#footnotes.get(label) ?? null;
    return { status: definition ? "resolved" : "unresolved", definition };
  }

  example(reference: SyntaxNode): ExampleResolution {
    this.#assert(reference);
    if (reference.kind !== "ExampleReference") throw new TypeError("example() requires an example-reference node");
    const label = reference.prop(normalizedCitationKey) ?? "";
    const number = this.#examples.get(label) ?? null;
    return { status: number === null ? "unresolved" : "resolved", number };
  }
}
