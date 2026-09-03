import { PANDOCMD_PARSER_VERSION, PANDOCMD_READER_FORMAT } from "./dialect.js";
import type { ChangedRange, SemanticChangedRange, TextChange, UnchangedSegment } from "./changes.js";
import { mergeChangedRanges, validateChanges } from "./changes.js";
import { LineIndex } from "./line-index.js";
import { green, greenDocumentChildAt, greenDocumentReplace, normalizedReferenceLabel, sameGreenShape, type GreenNode, type NodeKind, type NodeProperty, type SourceRange } from "./nodes.js";
import { parseBlocks, type BlockCheckpoint, type BlockParseResult } from "./block/parser.js";
import { DocumentSemanticsImpl, type DocumentSemantics, type SemanticSnapshot } from "./semantic/index.js";

export type ResolveBias = "left" | "right";

export interface TreeVisitor {
  readonly enter?: (node: SyntaxNode) => boolean | void;
  readonly leave?: (node: SyntaxNode) => void;
}

export interface TreeCursor {
  readonly node: SyntaxNode;
  firstChild(): boolean;
  lastChild(): boolean;
  nextSibling(): boolean;
  previousSibling(): boolean;
  parent(): boolean;
}

export interface SyntaxNode {
  readonly kind: NodeKind;
  readonly from: number;
  readonly to: number;
  readonly parent: SyntaxNode | null;
  readonly childCount: number;
  /** Opaque version token used to reject cross-snapshot semantic queries. */
  readonly treeToken: object;
  firstChild(): SyntaxNode | null;
  lastChild(): SyntaxNode | null;
  nextSibling(): SyntaxNode | null;
  previousSibling(): SyntaxNode | null;
  child(index: number): SyntaxNode | null;
  children(): Iterable<SyntaxNode>;
  text(): string;
  prop<T>(property: NodeProperty<T>): T | undefined;
}

export interface SyntaxTree {
  readonly version: number;
  readonly parserVersion: string;
  readonly dialect: typeof PANDOCMD_READER_FORMAT;
  readonly text: string;
  readonly length: number;
  readonly root: SyntaxNode;
  readonly semantics: DocumentSemantics;
  readonly lines: LineIndex;
  resolve(offset: number, bias?: ResolveBias): SyntaxNode;
  topLevelBlocks(): readonly SyntaxNode[];
  cursor(): TreeCursor;
  iterate(visitor: TreeVisitor | ((node: SyntaxNode) => boolean | void), range?: SourceRange): void;
  changedRanges(previous: SyntaxTree): readonly ChangedRange[];
  semanticChangedRanges(previous: SyntaxTree): readonly SemanticChangedRange[];
  sameSubtree(a: SyntaxNode, b: SyntaxNode): boolean;
  checkInvariants(): void;
}

const internalGreen = Symbol("pandocmd.green");
const internalTree = Symbol("pandocmd.tree");

class SyntaxNodeImpl implements SyntaxNode {
  readonly [internalGreen]: GreenNode;
  readonly [internalTree]: SyntaxTreeImpl;
  readonly #parent: SyntaxNodeImpl | null;
  readonly #index: number;
  readonly from: number;
  #children: readonly SyntaxNodeImpl[] | null = null;

  constructor(tree: SyntaxTreeImpl, node: GreenNode, parent: SyntaxNodeImpl | null, index: number, from: number) {
    this[internalTree] = tree; this[internalGreen] = node; this.#parent = parent; this.#index = index; this.from = from;
  }
  get kind(): NodeKind { return this[internalGreen].kind; }
  get to(): number { return this.from + this[internalGreen].length; }
  get parent(): SyntaxNode | null { return this.#parent; }
  get childCount(): number { return this[internalGreen].children.length; }
  get treeToken(): object { return this[internalTree].token; }
  #childNodes(): readonly SyntaxNodeImpl[] {
    if (this.#children) return this.#children;
    let offset = this.from;
    const result = this[internalGreen].children.map((child, index) => {
      const red = new SyntaxNodeImpl(this[internalTree], child, this, index, offset);
      offset += child.length; return red;
    });
    return this.#children = Object.freeze(result);
  }
  child(index: number): SyntaxNode | null { return this.#childNodes()[index] ?? null; }
  firstChild(): SyntaxNode | null { return this.child(0); }
  lastChild(): SyntaxNode | null { return this.child(this.childCount - 1); }
  nextSibling(): SyntaxNode | null { return this.#parent?.child(this.#index + 1) ?? null; }
  previousSibling(): SyntaxNode | null { return this.#parent?.child(this.#index - 1) ?? null; }
  *children(): Iterable<SyntaxNode> { yield* this.#childNodes(); }
  text(): string { return this[internalTree].text.slice(this.from, this.to); }
  prop<T>(property: NodeProperty<T>): T | undefined { return this[internalGreen].properties[property.id] as T | undefined; }
}

class TreeCursorImpl implements TreeCursor {
  #current: SyntaxNode;
  constructor(root: SyntaxNode) { this.#current = root; }
  get node(): SyntaxNode { return this.#current; }
  firstChild(): boolean { const node = this.#current.firstChild(); if (!node) return false; this.#current = node; return true; }
  lastChild(): boolean { const node = this.#current.lastChild(); if (!node) return false; this.#current = node; return true; }
  nextSibling(): boolean { const node = this.#current.nextSibling(); if (!node) return false; this.#current = node; return true; }
  previousSibling(): boolean { const node = this.#current.previousSibling(); if (!node) return false; this.#current = node; return true; }
  parent(): boolean { const node = this.#current.parent; if (!node) return false; this.#current = node; return true; }
}

interface UpdateMetadata {
  /** Identity only: never retain the previous tree or its source text. */
  readonly previousToken: object;
  changed: readonly ChangedRange[];
  semantic: readonly SemanticChangedRange[];
}

function allNodes(root: SyntaxNode): readonly SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const visit = (node: SyntaxNode): void => { result.push(node); for (const child of node.children()) visit(child); };
  visit(root); return result;
}

export class SyntaxTreeImpl implements SyntaxTree {
  readonly parserVersion = PANDOCMD_PARSER_VERSION;
  readonly dialect = PANDOCMD_READER_FORMAT;
  readonly length: number;
  readonly root: SyntaxNode;
  readonly lines: LineIndex;
  readonly token = Object.freeze({});
  readonly checkpoints: readonly BlockCheckpoint[];
  readonly greenRoot: GreenNode;
  #semantics: DocumentSemanticsImpl | null = null;
  readonly #update: UpdateMetadata | null;

  constructor(readonly text: string, readonly version: number, root: GreenNode, checkpoints: readonly BlockCheckpoint[], update: UpdateMetadata | null = null, lines?: LineIndex) {
    this.length = text.length; this.greenRoot = root; this.checkpoints = checkpoints; this.#update = update;
    this.lines = lines ?? new LineIndex(text);
    this.root = new SyntaxNodeImpl(this, root, null, 0, 0);
  }

  get semantics(): DocumentSemanticsImpl {
    return this.#semantics ??= new DocumentSemanticsImpl(this.token, allNodes(this.root));
  }
  get semanticSnapshot(): SemanticSnapshot { return this.semantics.snapshot; }

  resolve(offset: number, bias: ResolveBias = "right"): SyntaxNode {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.length) throw new RangeError(`Offset ${offset} is outside 0..${this.length}`);
    let node = this.root;
    if (this.length === 0) return node;
    if (offset === 0 && bias === "left") bias = "right";
    if (offset === this.length && bias === "right") bias = "left";
    while (node.childCount) {
      let found: SyntaxNode | null = null;
      for (const child of node.children()) {
        if (bias === "right" ? child.from <= offset && offset < child.to : child.from < offset && offset <= child.to) { found = child; break; }
      }
      if (!found) break;
      node = found;
    }
    return node;
  }

  topLevelBlocks(): readonly SyntaxNode[] { return Object.freeze([...this.root.children()]); }
  cursor(): TreeCursor { return new TreeCursorImpl(this.root); }
  iterate(visitor: TreeVisitor | ((node: SyntaxNode) => boolean | void), range: SourceRange = { from: 0, to: this.length }): void {
    if (range.from < 0 || range.to < range.from || range.to > this.length) throw new RangeError("Invalid iteration range");
    const enter = typeof visitor === "function" ? visitor : visitor.enter;
    const leave = typeof visitor === "function" ? undefined : visitor.leave;
    const visit = (node: SyntaxNode): void => {
      if (node.to < range.from || node.from > range.to || (node !== this.root && node.to === range.from) || node.from === range.to) return;
      const descend = enter?.(node) !== false;
      if (descend) for (const child of node.children()) visit(child);
      leave?.(node);
    };
    visit(this.root);
  }
  changedRanges(previous: SyntaxTree): readonly ChangedRange[] {
    if (previous === this) return Object.freeze([]);
    if (
      previous instanceof SyntaxTreeImpl
      && this.#update?.previousToken === previous.token
    ) return this.#update.changed;
    if (previous.text === this.text && this.sameSubtree(previous.root, this.root)) return Object.freeze([]);
    return Object.freeze([{ oldFrom: 0, oldTo: previous.length, newFrom: 0, newTo: this.length }]);
  }
  semanticChangedRanges(previous: SyntaxTree): readonly SemanticChangedRange[] {
    if (previous === this) return Object.freeze([]);
    if (
      previous instanceof SyntaxTreeImpl
      && this.#update?.previousToken === previous.token
    ) return this.#update.semantic;
    const result: SemanticChangedRange = { oldFrom: 0, oldTo: previous.length, newFrom: 0, newTo: this.length, kinds: Object.freeze(["reference-resolution", "heading-identifier", "footnote-target", "example-number"]) };
    return Object.freeze([result]);
  }
  sameSubtree(a: SyntaxNode, b: SyntaxNode): boolean {
    if (!(a instanceof SyntaxNodeImpl) || !(b instanceof SyntaxNodeImpl)) return false;
    return a[internalGreen].backing === b[internalGreen].backing;
  }
  checkInvariants(): void {
    if (this.root.kind !== "Document" || this.root.from !== 0 || this.root.to !== this.text.length) throw new Error("Document root does not cover the source");
    const leaves: SyntaxNode[] = [];
    const check = (node: SyntaxNode): void => {
      if (node !== this.root && node.from === node.to) throw new Error(`Zero-width ${node.kind} at ${node.from}`);
      if (node.from < (node.parent?.from ?? 0) || node.to > (node.parent?.to ?? this.length)) throw new Error(`${node.kind} escapes its parent`);
      if (node.childCount === 0) { leaves.push(node); return; }
      let cursor = node.from, index = 0;
      for (const child of node.children()) {
        if (child.parent !== node || child.previousSibling() !== (index ? node.child(index - 1) : null)) throw new Error(`Broken navigation at ${child.kind}`);
        if (child.from !== cursor) throw new Error(`Gap or overlap before ${child.kind} at ${cursor}`);
        cursor = child.to; index++; check(child);
      }
      if (cursor !== node.to) throw new Error(`${node.kind} children do not tile its range`);
    };
    check(this.root);
    let cursor = 0, reconstructed = "";
    for (const node of leaves) { if (node.from !== cursor) throw new Error(`Leaf gap at ${cursor}`); reconstructed += node.text(); cursor = node.to; }
    if (cursor !== this.length || reconstructed !== this.text) throw new Error("Leaf stream does not reproduce source text");
  }
}

function oldRangeFor(newFrom: number, newTo: number, segments: readonly UnchangedSegment[]): readonly [number, number] | null {
  for (const segment of segments) {
    if (newFrom >= segment.newFrom && newTo <= segment.newTo) {
      const delta = segment.oldFrom - segment.newFrom;
      return [newFrom + delta, newTo + delta];
    }
  }
  return null;
}

function indexGreen(node: GreenNode, from: number, index: Map<string, GreenNode>): void {
  index.set(`${from}:${from + node.length}:${node.kind}`, node);
  let cursor = from;
  for (const child of node.children) { indexGreen(child, cursor, index); cursor += child.length; }
}

function reuseGreen(node: GreenNode, from: number, newText: string, oldText: string, oldIndex: ReadonlyMap<string, GreenNode>, segments: readonly UnchangedSegment[]): GreenNode {
  const oldRange = oldRangeFor(from, from + node.length, segments);
  if (oldRange) {
    const candidate = oldIndex.get(`${oldRange[0]}:${oldRange[1]}:${node.kind}`);
    if (candidate && oldText.slice(oldRange[0], oldRange[1]) === newText.slice(from, from + node.length) && sameGreenShape(candidate, node)) return candidate;
  }
  if (!node.children.length) return node;
  let cursor = from, changed = false;
  const children = node.children.map(child => {
    const reused = reuseGreen(child, cursor, newText, oldText, oldIndex, segments);
    cursor += child.length; if (reused !== child) changed = true; return reused;
  });
  return changed ? green(node.kind, children, node.properties) : node;
}

function semanticChanges(previous: SyntaxTreeImpl, next: SyntaxTreeImpl, segments: readonly UnchangedSegment[]): readonly SemanticChangedRange[] {
  const ranges: SemanticChangedRange[] = [];
  const oldRefs = previous.semanticSnapshot.references, newRefs = next.semanticSnapshot.references;
  const changedLabels = new Set<string>();
  for (const label of new Set([...oldRefs.keys(), ...newRefs.keys()])) if (oldRefs.get(label) !== newRefs.get(label)) changedLabels.add(label);
  const candidates: SyntaxNode[] = [];
  next.iterate(node => { if (node.kind === "ReferenceCandidate" || node.kind === "ImageReferenceCandidate") candidates.push(node); });
  for (const node of candidates) {
    const label = node.prop(normalizedReferenceLabel);
    if (!label || !changedLabels.has(label)) continue;
    const old = oldRangeFor(node.from, node.to, segments);
    ranges.push({ oldFrom: old?.[0] ?? node.from, oldTo: old?.[1] ?? old?.[0] ?? node.from, newFrom: node.from, newTo: node.to, kinds: Object.freeze(["reference-resolution"]) });
  }
  const oldNodes = allNodes(previous.root);
  const oldByRange = new Map(oldNodes.map(node => [`${node.from}:${node.to}:${node.kind}`, node]));
  next.iterate(node => {
    const oldRange = oldRangeFor(node.from, node.to, segments);
    if (!oldRange) return;
    const oldNode = oldByRange.get(`${oldRange[0]}:${oldRange[1]}:${node.kind}`);
    if (!oldNode) return;
    if (node.kind === "AtxHeading" || node.kind === "SetextHeading") {
      if (next.semantics.heading(node).identifier !== previous.semantics.heading(oldNode).identifier) {
        ranges.push({ oldFrom: oldRange[0], oldTo: oldRange[1], newFrom: node.from, newTo: node.to, kinds: Object.freeze(["heading-identifier"]) });
      }
    } else if (node.kind === "FootnoteReference") {
      const oldResolution = previous.semantics.footnote(oldNode), newResolution = next.semantics.footnote(node);
      const mappedTarget = newResolution.definition ? oldRangeFor(newResolution.definition.from, newResolution.definition.to, segments) : null;
      const sameTarget = oldResolution.definition === null && newResolution.definition === null
        || oldResolution.definition !== null && newResolution.definition !== null && mappedTarget !== null
          && mappedTarget[0] === oldResolution.definition.from && mappedTarget[1] === oldResolution.definition.to
          && previous.sameSubtree(oldResolution.definition, newResolution.definition);
      if (!sameTarget) {
        ranges.push({ oldFrom: oldRange[0], oldTo: oldRange[1], newFrom: node.from, newTo: node.to, kinds: Object.freeze(["footnote-target"]) });
      }
    } else if (node.kind === "ExampleReference") {
      if (next.semantics.example(node).number !== previous.semantics.example(oldNode).number) {
        ranges.push({ oldFrom: oldRange[0], oldTo: oldRange[1], newFrom: node.from, newTo: node.to, kinds: Object.freeze(["example-number"]) });
      }
    }
  });
  return Object.freeze(ranges);
}

function structuralChangedRanges(previous: SyntaxTreeImpl, next: SyntaxTreeImpl, changes: readonly TextChange[]): readonly ChangedRange[] {
  const oldBlocks = previous.topLevelBlocks() as readonly SyntaxNodeImpl[];
  const newBlocks = next.topLevelBlocks() as readonly SyntaxNodeImpl[];
  const oldGreens = new Set(oldBlocks.map(node => node[internalGreen]));
  const newGreens = new Set(newBlocks.map(node => node[internalGreen]));
  const touching = (blocks: readonly SyntaxNodeImpl[], from: number, to: number, bias: ResolveBias): SyntaxNodeImpl | null => {
    for (const block of blocks) {
      if (from === to) {
        if (bias === "right" ? block.from <= from && from < block.to : block.from < from && from <= block.to) return block;
      } else if (block.from < to && block.to > from) return block;
    }
    return null;
  };
  const expanded: ChangedRange[] = [];
  for (const change of changes) {
    const oldBlock = touching(oldBlocks, change.oldFrom, change.oldTo, change.oldFrom === previous.length ? "left" : "right");
    const newBlock = touching(newBlocks, change.newFrom, change.newTo, change.newFrom === next.length ? "left" : "right");
    const oldChanged = oldBlock !== null && !newGreens.has(oldBlock[internalGreen]);
    const newChanged = newBlock !== null && !oldGreens.has(newBlock[internalGreen]);
    expanded.push({
      oldFrom: oldChanged ? Math.min(oldBlock.from, change.oldFrom) : change.oldFrom,
      oldTo: oldChanged ? Math.max(oldBlock.to, change.oldTo) : change.oldTo,
      newFrom: newChanged ? Math.min(newBlock.from, change.newFrom) : change.newFrom,
      newTo: newChanged ? Math.max(newBlock.to, change.newTo) : change.newTo,
    });
  }
  return mergeChangedRanges(expanded);
}

interface LocalizedBlockResult extends BlockParseResult {
  readonly changed: ChangedRange;
  readonly semanticRelevant: boolean;
}

function greenHasSemantic(node: GreenNode): boolean {
  const relevant = new Set<NodeKind>(["ReferenceDefinition", "ReferenceCandidate", "ImageReferenceCandidate", "AtxHeading", "SetextHeading", "FootnoteDefinition", "FootnoteReference", "OrderedList", "ExampleReference"]);
  if (relevant.has(node.kind)) return true;
  for (const child of node.children) if (greenHasSemantic(child)) return true;
  return false;
}

function localizedBlockParse(newText: string, previous: SyntaxTreeImpl, changes: readonly TextChange[]): LocalizedBlockResult | null {
  if (changes.length !== 1) return null;
  const change = changes[0]!;
  const oldChangedText = previous.text.slice(change.oldFrom, change.oldTo);
  const newChangedText = newText.slice(change.newFrom, change.newTo);
  if (/[\r\n]/.test(oldChangedText) || /[\r\n]/.test(newChangedText)) return null;
  const located = greenDocumentChildAt(previous.greenRoot, change.oldFrom);
  const block = located?.child, blockFrom = located?.from ?? 0, blockIndex = located?.index ?? -1;
  if (!block || !new Set<NodeKind>(["Paragraph", "AtxHeading", "SetextHeading", "FencedCodeBlock", "IndentedCodeBlock"]).has(block.kind)) return null;
  const delta = (change.newTo - change.newFrom) - (change.oldTo - change.oldFrom);
  const blockTo = blockFrom + block.length, newBlockTo = blockTo + delta;
  if (newBlockTo < blockFrom || newBlockTo > newText.length || newBlockTo - blockFrom > 4096) return null;
  const parsedBlock = parseBlocks(newText.slice(blockFrom, newBlockTo));
  if (parsedBlock.root.children.length !== 1 || parsedBlock.root.children[0]!.kind !== block.kind) return null;
  const root = greenDocumentReplace(previous.greenRoot, blockIndex, parsedBlock.root.children[0]!);
  if (root.length !== newText.length) return null;
  const newBlock = parsedBlock.root.children[0]!;
  return {
    root, checkpoints: Object.freeze([]),
    changed: { oldFrom: blockFrom, oldTo: blockTo, newFrom: blockFrom, newTo: newBlockTo },
    semanticRelevant: greenHasSemantic(block) || greenHasSemantic(newBlock),
  };
}

function semanticRelevant(tree: SyntaxTreeImpl, ranges: readonly ChangedRange[], side: "old" | "new"): boolean {
  const relevant = new Set<NodeKind>(["ReferenceDefinition", "ReferenceCandidate", "ImageReferenceCandidate", "AtxHeading", "SetextHeading", "FootnoteDefinition", "FootnoteReference", "OrderedList", "ExampleReference"]);
  const visit = (node: SyntaxNode): boolean => {
    if (relevant.has(node.kind)) return true;
    for (const child of node.children()) if (visit(child)) return true;
    return false;
  };
  for (const range of ranges) {
    const from = side === "old" ? range.oldFrom : range.newFrom;
    const to = side === "old" ? range.oldTo : range.newTo;
    for (const block of tree.topLevelBlocks()) {
      const touches = from === to ? block.from <= from && from <= block.to : block.from < to && block.to > from;
      if (touches && visit(block)) return true;
    }
  }
  return false;
}

export interface ParseUpdate { readonly tree: SyntaxTree; readonly changedRanges: readonly ChangedRange[]; readonly semanticChangedRanges: readonly SemanticChangedRange[] }

export class PandocParser {
  #version = 0;
  parse(text: string): SyntaxTree {
    if (typeof text !== "string") throw new TypeError("parse() requires a string");
    const parsed = parseBlocks(text);
    return new SyntaxTreeImpl(text, ++this.#version, parsed.root, parsed.checkpoints);
  }
  update(newText: string, previous: SyntaxTree, changes: readonly TextChange[]): ParseUpdate {
    if (!(previous instanceof SyntaxTreeImpl) || previous.parserVersion !== PANDOCMD_PARSER_VERSION || previous.dialect !== PANDOCMD_READER_FORMAT) throw new TypeError("Previous tree was produced by an incompatible parser or dialect");
    const segments = validateChanges(previous.text, newText, changes);
    const localized = localizedBlockParse(newText, previous, changes);
    const parsed = localized ?? parseBlocks(newText);
    let reusedRoot = parsed.root;
    if (!localized) {
      const oldIndex = new Map<string, GreenNode>(); indexGreen(previous.greenRoot, 0, oldIndex);
      reusedRoot = reuseGreen(parsed.root, 0, newText, previous.text, oldIndex, segments);
    }
    const metadata: UpdateMetadata = {
      previousToken: previous.token,
      changed: Object.freeze([]),
      semantic: Object.freeze([]),
    };
    const nextLines = localized ? previous.lines.update(newText, changes) : new LineIndex(newText);
    const tree = new SyntaxTreeImpl(newText, ++this.#version, reusedRoot, parsed.checkpoints, metadata, nextLines);
    const changed = localized ? mergeChangedRanges([localized.changed]) : structuralChangedRanges(previous, tree, changes);
    metadata.changed = changed;
    const needsSemantics = localized ? localized.semanticRelevant : semanticRelevant(previous, changed, "old") || semanticRelevant(tree, changed, "new");
    const semantic = needsSemantics
      ? semanticChanges(previous, tree, segments)
      : Object.freeze([]);
    metadata.semantic = semantic;
    return Object.freeze({ tree, changedRanges: changed, semanticChangedRanges: semantic });
  }
}

export function serializeTree(tree: SyntaxTree): unknown {
  const serialize = (node: SyntaxNode): unknown => ({
    kind: node.kind, from: node.from, to: node.to,
    ...(node instanceof SyntaxNodeImpl && Object.keys(node[internalGreen].properties).length ? { properties: node[internalGreen].properties } : {}),
    ...(node.childCount ? { children: [...node.children()].map(serialize) } : {}),
  });
  return serialize(tree.root);
}
