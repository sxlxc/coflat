export type NodeKind =
  | "Document" | "BlankLines" | "YamlMetadata" | "PandocTitleBlock"
  | "Paragraph" | "Plain" | "AtxHeading" | "SetextHeading" | "HorizontalRule"
  | "BlockQuote" | "BulletList" | "OrderedList" | "DefinitionList" | "ListItem"
  | "DefinitionTerm" | "DefinitionBody" | "LineBlock" | "LineBlockLine"
  | "IndentedCodeBlock" | "FencedCodeBlock" | "RawBlock" | "FencedDiv"
  | "NativeHtmlDiv" | "ReferenceDefinition" | "FootnoteDefinition"
  | "PipeTable" | "SimpleTable" | "MultilineTable" | "GridTable"
  | "TableCaption" | "TableHead" | "TableBody" | "TableFoot" | "TableRow" | "TableCell"
  | "Emphasis" | "Strong" | "Strikeout" | "Superscript" | "Subscript" | "Quoted"
  | "Code" | "Math" | "RawInline" | "Link" | "Image" | "AutoLink"
  | "ReferenceCandidate" | "ImageReferenceCandidate" | "Citation" | "CitationItem"
  | "FootnoteReference" | "ExampleReference" | "InlineNote" | "Span" | "NativeHtmlSpan"
  | "Space" | "SoftBreak" | "LineBreak" | "SmartSequence" | "InlineText"
  | "AttributeList" | "Attribute" | "LinkDestination" | "LinkTitle" | "ReferenceLabel"
  | "CitationKey" | "CitationPrefix" | "CitationSuffix" | "CodeInfo" | "TableAlignment"
  | "Text" | "Whitespace" | "LineEnding" | "Escape" | "Entity" | "Delimiter"
  | "AttributeName" | "AttributeValue" | "Identifier" | "ClassName"
  | "MathMark" | "CodeMark" | "FenceMark" | "ListMark" | "QuoteMark"
  | "BracketMark" | "ParenMark" | "TableDelimiter" | "OpaqueBody" | "HtmlTag";

export interface SourceRange { readonly from: number; readonly to: number }

const nodePropertyType: unique symbol = Symbol("pandocmd.nodePropertyType");

/** A nominal, typed key for immutable syntax metadata. */
export class NodeProperty<T> {
  readonly [nodePropertyType]?: T;
  readonly id: string;
  constructor(id: string) { this.id = id; }
}

export type FenceCharacter = "`" | "~" | ":";
export type ReferenceForm = "full" | "collapsed" | "shortcut" | "implicit-heading";
export type MathDelimiterStyle = "dollar" | "double-dollar" | "single-backslash" | "double-backslash";

export const headingLevel = new NodeProperty<number>("heading.level");
export const explicitIdentifier = new NodeProperty<string>("heading.explicitIdentifier");
export const fenceCharacter = new NodeProperty<FenceCharacter>("fence.character");
export const fenceLength = new NodeProperty<number>("fence.length");
export const fenceInfo = new NodeProperty<string>("fence.info");
export const fenceClosed = new NodeProperty<boolean>("fence.closed");
export const orderedListStart = new NodeProperty<number>("list.start");
export const orderedListDelimiter = new NodeProperty<"." | ")">("list.delimiter");
export const orderedListStyle = new NodeProperty<string>("list.style");
export const listTight = new NodeProperty<boolean>("list.tight");
export const taskChecked = new NodeProperty<boolean>("list.taskChecked");
export const tableAlignments = new NodeProperty<readonly ("left" | "right" | "center" | "default")[]>("table.alignments");
export const tableColumnCount = new NodeProperty<number>("table.columnCount");
export const mathDisplay = new NodeProperty<boolean>("math.display");
export const mathDelimiter = new NodeProperty<MathDelimiterStyle>("math.delimiter");
export const citationMode = new NodeProperty<"normal" | "suppress-author" | "author-in-text">("citation.mode");
export const normalizedCitationKey = new NodeProperty<string>("citation.normalizedKey");
export const rawFormat = new NodeProperty<string>("raw.format");
export const linkForm = new NodeProperty<"inline" | "autolink" | ReferenceForm>("link.form");
export const destinationSyntax = new NodeProperty<"angle" | "bare">("link.destinationSyntax");
export const referenceForm = new NodeProperty<ReferenceForm>("reference.form");
export const normalizedReferenceLabel = new NodeProperty<string>("reference.normalizedLabel");
export const referenceDestination = new NodeProperty<string>("reference.destination");
export const referenceTitle = new NodeProperty<string>("reference.title");
export const footnoteLabel = new NodeProperty<string>("footnote.label");
export const exampleLabel = new NodeProperty<string>("example.label");
export const htmlTagName = new NodeProperty<string>("html.tagName");
export const smartInterpretation = new NodeProperty<"open-single" | "close-single" | "open-double" | "close-double" | "ellipsis" | "en-dash" | "em-dash">("smart.interpretation");

export type PropertyBag = Readonly<Record<string, unknown>>;

export interface GreenNode {
  readonly kind: NodeKind;
  readonly length: number;
  readonly children: readonly GreenNode[];
  readonly properties: PropertyBag;
  /** @internal Engine backing; never exposed through the public CST API. */
  readonly backing: LezerTree;
}

const EMPTY_CHILDREN = Object.freeze([]) as readonly GreenNode[];
const EMPTY_PROPERTIES: PropertyBag = Object.freeze({});

const nodeTypes = new Map<NodeKind, NodeType>();
function nodeType(kind: NodeKind): NodeType {
  let type = nodeTypes.get(kind);
  if (!type) {
    type = NodeType.define({ id: nodeTypes.size, name: kind, top: kind === "Document" });
    nodeTypes.set(kind, type);
  }
  return type;
}

function backing(kind: NodeKind, children: readonly GreenNode[], length: number): LezerTree {
  const positions: number[] = [];
  let offset = 0;
  for (const child of children) { positions.push(offset); offset += child.length; }
  return new LezerTree(nodeType(kind), children.map(child => child.backing), positions, length);
}

interface ChildVectorNode {
  readonly count: number;
  readonly length: number;
  readonly left: ChildVectorNode | null;
  readonly right: ChildVectorNode | null;
  readonly value: GreenNode | null;
}

function childVector(values: readonly GreenNode[], from = 0, to = values.length): ChildVectorNode | null {
  if (from >= to) return null;
  if (to - from === 1) return Object.freeze({ count: 1, length: values[from]!.length, left: null, right: null, value: values[from]! });
  const middle = (from + to) >>> 1, left = childVector(values, from, middle)!, right = childVector(values, middle, to)!;
  return Object.freeze({ count: left.count + right.count, length: left.length + right.length, left, right, value: null });
}

function vectorGet(node: ChildVectorNode, index: number): GreenNode | undefined {
  if (index < 0 || index >= node.count) return undefined;
  if (node.value) return node.value;
  return index < node.left!.count ? vectorGet(node.left!, index) : vectorGet(node.right!, index - node.left!.count);
}

function vectorReplace(node: ChildVectorNode, index: number, value: GreenNode): ChildVectorNode {
  if (node.value) return Object.freeze({ count: 1, length: value.length, left: null, right: null, value });
  const leftCount = node.left!.count;
  const left = index < leftCount ? vectorReplace(node.left!, index, value) : node.left!;
  const right = index < leftCount ? node.right! : vectorReplace(node.right!, index - leftCount, value);
  return Object.freeze({ count: node.count, length: left.length + right.length, left, right, value: null });
}

function* vectorValues(node: ChildVectorNode | null): IterableIterator<GreenNode> {
  if (!node) return;
  if (node.value) { yield node.value; return; }
  yield* vectorValues(node.left); yield* vectorValues(node.right);
}

const persistentVectors = new WeakMap<object, ChildVectorNode | null>();

function vectorArray(root: ChildVectorNode | null): readonly GreenNode[] {
  const target = {};
  const proxy = new Proxy(target, {
    get(_target, property) {
      if (property === "length") return root?.count ?? 0;
      if (property === Symbol.iterator) return () => vectorValues(root);
      if (property === "map") return <T>(fn: (value: GreenNode, index: number, array: readonly GreenNode[]) => T): T[] => {
        const result: T[] = []; let index = 0;
        for (const value of vectorValues(root)) result.push(fn(value, index++, proxy as unknown as readonly GreenNode[]));
        return result;
      };
      if (typeof property === "string" && /^(?:0|[1-9]\d*)$/.test(property)) return root ? vectorGet(root, Number(property)) : undefined;
      return undefined;
    },
  }) as unknown as readonly GreenNode[];
  persistentVectors.set(proxy as object, root);
  return proxy;
}

function nodeWithLength(kind: NodeKind, children: readonly GreenNode[], length: number, properties: PropertyBag, lazyBacking: boolean): GreenNode {
  let cached: LezerTree | undefined;
  const node = {
    kind,
    length,
    children,
    properties: Object.isFrozen(properties) ? properties : Object.freeze(properties),
    get backing(): LezerTree { return cached ??= backing(kind, children, length); },
  };
  if (!lazyBacking) cached = backing(kind, children, length);
  return Object.freeze(node);
}

/** Persistent, lazily-backed Document constructor used by full and localized parses. */
export function greenDocument(children: readonly GreenNode[]): GreenNode {
  const root = childVector(children);
  return nodeWithLength("Document", vectorArray(root), root?.length ?? 0, {}, true);
}

/** Replace one top-level block without copying or rebuilding the other blocks. */
export function greenDocumentReplace(document: GreenNode, index: number, child: GreenNode): GreenNode {
  const root = persistentVectors.get(document.children as object) ?? childVector([...document.children]);
  if (!root || index < 0 || index >= root.count) throw new RangeError("Document child index is out of bounds");
  const replaced = vectorReplace(root, index, child);
  return nodeWithLength("Document", vectorArray(replaced), replaced.length, document.properties, true);
}

/** Locate a top-level child by source offset in logarithmic time. */
export function greenDocumentChildAt(document: GreenNode, offset: number): { readonly child: GreenNode; readonly index: number; readonly from: number } | null {
  let node = persistentVectors.get(document.children as object);
  if (node === undefined) {
    node = childVector([...document.children]);
    persistentVectors.set(document.children as object, node);
  }
  if (!node || offset < 0 || offset >= node.length) return null;
  let index = 0, from = 0;
  while (!node.value) {
    if (offset < from + node.left!.length) node = node.left!;
    else { from += node.left!.length; index += node.left!.count; node = node.right!; }
  }
  return { child: node.value, index, from };
}

/** Locate a top-level child by index without materializing the document vector. */
export function greenDocumentChildAtIndex(document: GreenNode, target: number): { readonly child: GreenNode; readonly from: number } | null {
  let node = persistentVectors.get(document.children as object);
  if (node === undefined) {
    node = childVector([...document.children]);
    persistentVectors.set(document.children as object, node);
  }
  if (!node || target < 0 || target >= node.count) return null;
  let index = target, from = 0;
  while (!node.value) {
    if (index < node.left!.count) {
      node = node.left!;
    } else {
      index -= node.left!.count;
      from += node.left!.length;
      node = node.right!;
    }
  }
  return { child: node.value, from };
}

export function green(
  kind: NodeKind,
  children: readonly GreenNode[],
  properties: PropertyBag = EMPTY_PROPERTIES,
): GreenNode {
  let length = 0;
  for (const child of children) length += child.length;
  // Green-node constructors are internal. Ownership of a newly-built child
  // array is transferred here, avoiding a second allocation for every node.
  const owned = Object.isFrozen(children) ? children : Object.freeze(children);
  return nodeWithLength(kind, owned, length, properties, true);
}

/** Internal zero-copy constructor. The caller transfers ownership of children. */
export function greenOwned(kind: NodeKind, children: GreenNode[], properties: PropertyBag = EMPTY_PROPERTIES): GreenNode {
  let length = 0;
  for (const child of children) length += child.length;
  Object.freeze(children);
  return nodeWithLength(kind, children, length, properties, true);
}

export function leaf(kind: NodeKind, length: number, properties: PropertyBag = EMPTY_PROPERTIES): GreenNode {
  if (length <= 0) throw new RangeError(`Leaf ${kind} must have positive length`);
  return nodeWithLength(kind, EMPTY_CHILDREN, length, properties, true);
}

export function props(...entries: readonly (readonly [NodeProperty<unknown>, unknown])[]): PropertyBag {
  const result: Record<string, unknown> = {};
  for (const [property, value] of entries) result[property.id] = value;
  return Object.freeze(result);
}

export function sameGreenShape(a: GreenNode, b: GreenNode): boolean {
  if (a.kind !== b.kind || a.length !== b.length || a.children.length !== b.children.length) return false;
  const ak = Object.keys(a.properties);
  const bk = Object.keys(b.properties);
  if (ak.length !== bk.length) return false;
  for (const key of ak) {
    if (!Object.hasOwn(b.properties, key) || JSON.stringify(a.properties[key]) !== JSON.stringify(b.properties[key])) return false;
  }
  for (let i = 0; i < a.children.length; i++) {
    if (!sameGreenShape(a.children[i]!, b.children[i]!)) return false;
  }
  return true;
}
import { NodeType, Tree as LezerTree } from "@lezer/common";
