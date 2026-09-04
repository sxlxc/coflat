import {
  EditorSelection,
  type EditorState,
  type Extension,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  fenceClosed,
  fenceInfo,
  headingLevel,
  mathDisplay,
  type NodeKind,
  type SyntaxNode,
  type SyntaxTree,
} from "pandocmd-cst";
import { CSS } from "../../core/constants/css-classes";
import {
  getBlockManifestEntry,
  getManifestBlockTitle,
} from "../../core/constants/block-manifest";
import {
  createDisplayMathContentElement,
  createDisplayMathSurfaceElement,
} from "../../core/math-display-surface";
import {
  createInlineMathSurfaceElement,
  renderInlineMathErrorFallback,
} from "../../core/math-inline-surface";
import {
  initialHeadingNumberCounters,
  nextHeadingNumber,
} from "../../core/semantics/heading-numbering";
import { renderKatexToHtml } from "../render/katex-render";
import { getPandocCursorContext } from "./cursor-context";
import {
  getPandocInvalidations,
  getPandocTree,
} from "./pandoc-cst-field";
import {
  activePipeTableKeys,
  cstTableSurface,
} from "./table-surface";

const DELIMITED_INLINE_CLASSES: Partial<Record<NodeKind, string>> = {
  Emphasis: CSS.italic,
  Strong: CSS.bold,
  Strikeout: CSS.strikethrough,
  Superscript: "cf-cst-superscript",
  Subscript: "cf-cst-subscript",
  Quoted: "cf-cst-quoted",
  Code: CSS.inlineCode,
};

const INLINE_DELIMITER_KINDS: ReadonlySet<NodeKind> = new Set([
  "Delimiter",
  "CodeMark",
]);

const LINK_SOURCE_KINDS: ReadonlySet<NodeKind> = new Set([
  "BracketMark",
  "ParenMark",
  "LinkDestination",
  "LinkTitle",
  "ReferenceLabel",
  "AttributeList",
]);

const FENCED_DIV_CLASS_ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ["abs", "abstract"],
  ["alg", "algorithm"],
  ["conj", "conjecture"],
  ["cor", "corollary"],
  ["def", "definition"],
  ["defn", "definition"],
  ["ex", "example"],
  ["fig", "figure"],
  ["lem", "lemma"],
  ["pf", "proof"],
  ["prf", "proof"],
  ["prob", "problem"],
  ["prop", "proposition"],
  ["rem", "remark"],
  ["tbl", "table"],
  ["thm", "theorem"],
]);

interface FencedDivInfo {
  readonly className: string;
  readonly id?: string;
  readonly title?: string;
}

interface FencedDivPresentation extends FencedDivInfo {
  readonly label: string;
}

interface FencedDivSourceRanges {
  readonly openerFrom: number;
  readonly openerTo: number;
  readonly closerFrom?: number;
  readonly closerTo?: number;
}

const FENCED_DIV_ATTRIBUTE_TOKEN = /(?:[^\s"'\\]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g;

function attributeValueText(value: string): string {
  const quote = value[0];
  return (quote === "\"" || quote === "'") && value.at(-1) === quote
    ? value.slice(1, -1)
    : value;
}

/** Read the already-delimited `fenceInfo` property published by the CST. */
function parseFencedDivInfo(value: string | undefined): FencedDivInfo | null {
  const info = value?.trim();
  if (!info) return null;
  if (!info.startsWith("{")) {
    return info.includes(" ") || info.includes("\t")
      ? null
      : { className: info };
  }
  if (!info.endsWith("}")) return null;

  let className: string | undefined;
  let id: string | undefined;
  let title: string | undefined;
  const body = info.slice(1, -1);
  for (const token of body.match(FENCED_DIV_ATTRIBUTE_TOKEN) ?? []) {
    if (token.startsWith(".")) {
      className ??= token.slice(1);
      continue;
    }
    if (token.startsWith("#")) {
      id = token.slice(1);
      continue;
    }
    const equal = token.indexOf("=");
    if (equal > 0 && token.slice(0, equal) === "title") {
      title = attributeValueText(token.slice(equal + 1));
    }
  }

  return className ? { className, id, title } : null;
}

function fencedDivDisplayLabel(className: string): string {
  const normalized = className.toLocaleLowerCase();
  const canonical = FENCED_DIV_CLASS_ABBREVIATIONS.get(normalized) ?? normalized;
  const manifest = getBlockManifestEntry(canonical);
  if (manifest) return getManifestBlockTitle(manifest);
  const [first = "", ...rest] = [...className];
  return `${first.toLocaleUpperCase()}${rest.join("")}`;
}

function fencedDivPresentation(node: SyntaxNode): FencedDivPresentation | null {
  const info = parseFencedDivInfo(node.prop(fenceInfo));
  return info ? { ...info, label: fencedDivDisplayLabel(info.className) } : null;
}

function fencedDivSourceRanges(
  state: EditorState,
  node: SyntaxNode,
): FencedDivSourceRanges | null {
  const directFenceMarks = [...node.children()].filter(
    (child) => child.kind === "FenceMark",
  );
  const opener = directFenceMarks[0];
  if (!opener) return null;
  const openerLine = state.doc.lineAt(opener.from);
  const closer = node.prop(fenceClosed) && directFenceMarks.length > 1
    ? directFenceMarks[directFenceMarks.length - 1]
    : undefined;
  return {
    openerFrom: node.from,
    openerTo: openerLine.to,
    ...(closer ? { closerFrom: closer.from, closerTo: closer.to } : {}),
  };
}

function selectionTouchesSourceRange(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  return state.selection.ranges.some((range) => (
    range.empty
      ? from <= range.head && range.head <= to
      : range.from < to && from < range.to
  ));
}

function rangeContainsNode(
  ranges: readonly { readonly from: number; readonly to: number }[],
  node: SyntaxNode,
): boolean {
  return ranges.some((range) => range.from <= node.from && node.to <= range.to);
}

function bindSourceReveal(
  element: HTMLElement,
  view: EditorView,
  position: number,
): void {
  element.addEventListener("mousedown", (event) => {
    if (
      event.button !== 0
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
    ) return;
    event.preventDefault();
    event.stopPropagation();
    view.focus();
    view.dispatch({
      selection: EditorSelection.cursor(position),
      scrollIntoView: true,
      userEvent: "select.pointer",
    });
  });
}

class CstFencedDivHeaderWidget extends WidgetType {
  constructor(
    private readonly presentation: FencedDivPresentation,
    private readonly source: string,
    private readonly sourceFrom: number,
  ) {
    super();
  }

  eq(other: CstFencedDivHeaderWidget): boolean {
    return other.presentation.label === this.presentation.label
      && other.presentation.title === this.presentation.title
      && other.presentation.id === this.presentation.id
      && other.source === this.source
      && other.sourceFrom === this.sourceFrom;
  }

  toDOM(view: EditorView): HTMLElement {
    const ownerDocument = view.dom.ownerDocument;
    const header = ownerDocument.createElement("span");
    header.className = CSS.fencedDivHeader;
    header.dataset.blockClass = this.presentation.className;
    if (this.presentation.id) {
      header.dataset.referenceId = this.presentation.id;
    }
    header.setAttribute("aria-label", this.source);
    header.title = "Edit fenced div attributes";

    header.textContent = this.presentation.title
      ? `${this.presentation.label} (${this.presentation.title})`
      : this.presentation.label;
    bindSourceReveal(header, view, this.sourceFrom);
    return header;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

interface FencedDivTarget {
  readonly id: string;
  readonly label: string;
}

function collectFencedDivTargets(tree: SyntaxTree): ReadonlyMap<string, FencedDivTarget> {
  const targets = new Map<string, FencedDivTarget>();
  tree.iterate((node) => {
    if (node.kind !== "FencedDiv") return;
    const presentation = fencedDivPresentation(node);
    if (presentation?.id && !targets.has(presentation.id)) {
      targets.set(presentation.id, {
        id: presentation.id,
        label: presentation.label,
      });
    }
    return;
  });
  return targets;
}

function childText(node: SyntaxNode, kind: NodeKind): string | null {
  return childOfKind(node, kind)?.text() ?? null;
}

function simpleFencedDivReferenceKey(node: SyntaxNode): string | null {
  if (node.kind === "ExampleReference") {
    const key = childText(node, "CitationKey");
    return key && node.text() === `@${key}` ? key : null;
  }
  if (node.kind !== "Citation") return null;
  const items = [...node.children()].filter((child) => child.kind === "CitationItem");
  if (items.length !== 1) return null;
  const key = childText(items[0], "CitationKey");
  return key && node.text() === `[@${key}]` ? key : null;
}

function referenceKeyNode(node: SyntaxNode): SyntaxNode | null {
  if (node.kind === "ExampleReference") return childOfKind(node, "CitationKey");
  const item = childOfKind(node, "CitationItem");
  return item ? childOfKind(item, "CitationKey") : null;
}

class CstFencedDivReferenceWidget extends WidgetType {
  constructor(
    private readonly target: FencedDivTarget,
    private readonly source: string,
    private readonly editPosition: number,
  ) {
    super();
  }

  eq(other: CstFencedDivReferenceWidget): boolean {
    return other.target.id === this.target.id
      && other.target.label === this.target.label
      && other.source === this.source
      && other.editPosition === this.editPosition;
  }

  toDOM(view: EditorView): HTMLElement {
    const reference = view.dom.ownerDocument.createElement("span");
    reference.className = CSS.fencedDivReference;
    reference.dataset.referenceId = this.target.id;
    reference.textContent = this.target.label;
    reference.setAttribute("aria-label", this.source);
    reference.title = `Edit reference to ${this.target.id}`;
    bindSourceReveal(reference, view, this.editPosition);
    return reference;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class CstBulletListMarkerWidget extends WidgetType {
  eq(other: CstBulletListMarkerWidget): boolean {
    return other instanceof CstBulletListMarkerWidget;
  }

  toDOM(view: EditorView): HTMLElement {
    const marker = view.dom.ownerDocument.createElement("span");
    marker.className = CSS.listBullet;
    marker.textContent = "•";
    return marker;
  }
}

const bulletListMarkerWidget = new CstBulletListMarkerWidget();

const HIGHLIGHTED_ANCESTORS: ReadonlySet<NodeKind> = new Set([
  "AtxHeading",
  "SetextHeading",
  "Strong",
  "Emphasis",
  "Strikeout",
  "Code",
  "RawInline",
  "RawBlock",
  "Link",
  "Image",
  "AutoLink",
  "ReferenceCandidate",
  "ImageReferenceCandidate",
  "Citation",
  "CitationItem",
  "AttributeList",
]);

function nodeKey(node: Pick<SyntaxNode, "kind" | "from" | "to">): string {
  return `${node.kind}:${node.from}:${node.to}`;
}

function addAncestors(target: Set<string>, node: SyntaxNode | null): void {
  let current = node;
  while (current) {
    target.add(nodeKey(current));
    current = current.parent;
  }
}

function activeNodeKeys(state: EditorState, tree: SyntaxTree): ReadonlySet<string> {
  const active = new Set<string>();
  for (const range of state.selection.ranges) {
    addAncestors(active, tree.resolve(range.head, "right"));
    if (range.anchor !== range.head) {
      addAncestors(active, tree.resolve(range.anchor, "right"));
    }
  }
  return active;
}

function childOfKind(node: SyntaxNode, kind: NodeKind): SyntaxNode | null {
  for (const child of node.children()) {
    if (child.kind === kind) return child;
  }
  return null;
}

function isBulletListMark(node: SyntaxNode): boolean {
  return node.kind === "ListMark"
    && node.parent?.kind === "ListItem"
    && node.parent.parent?.kind === "BulletList";
}

function highlightedAncestor(node: SyntaxNode): NodeKind | null {
  let current: SyntaxNode | null = node;
  while (current) {
    if (HIGHLIGHTED_ANCESTORS.has(current.kind)) return current.kind;
    current = current.parent;
  }
  return null;
}

function sourceHighlightClass(node: SyntaxNode): string | null {
  switch (node.kind) {
    case "Delimiter":
    case "CodeMark":
    case "MathMark":
    case "ListMark":
    case "BracketMark":
    case "ParenMark":
    case "TableDelimiter":
      return "tok-punctuation";
    case "QuoteMark":
      return CSS.blockquoteMark;
    case "LinkDestination":
      return "tok-url";
    case "CitationKey":
    case "AttributeName":
    case "AttributeValue":
    case "ClassName":
    case "Identifier":
      return "tok-meta";
    default:
      break;
  }

  switch (highlightedAncestor(node)) {
    case "AtxHeading":
    case "SetextHeading":
      return "tok-heading";
    case "Strong":
      return "tok-strong";
    case "Emphasis":
      return "tok-emphasis";
    case "Strikeout":
      return "tok-strikethrough";
    case "Code":
      return "tok-monospace";
    case "RawInline":
    case "RawBlock":
      return "tok-string";
    case "Link":
    case "Image":
    case "AutoLink":
    case "ReferenceCandidate":
    case "ImageReferenceCandidate":
      return "tok-link";
    case "Citation":
    case "CitationItem":
    case "AttributeList":
      return "tok-meta";
    default:
      return null;
  }
}

function renderMath(
  element: HTMLElement,
  latex: string,
  isDisplay: boolean,
): void {
  try {
    const html = renderKatexToHtml(
      latex,
      isDisplay,
      {},
      isDisplay ? "htmlAndMathml" : "html",
      false,
    );
    if (html.includes("katex-error")) throw new Error("KaTeX could not parse this expression");
    element.innerHTML = html;
  } catch (error: unknown) {
    const label = error instanceof Error ? `KaTeX error: ${error.message}` : "KaTeX error";
    if (isDisplay) {
      element.classList.add(CSS.mathError);
      element.setAttribute("role", "alert");
      element.setAttribute("aria-label", label);
      element.textContent = latex;
    } else {
      renderInlineMathErrorFallback(element, `$${latex}$`, label, { role: "alert" });
    }
  }
}

class CstMathWidget extends WidgetType {
  constructor(
    private readonly latex: string,
    private readonly raw: string,
    private readonly isDisplay: boolean,
    private readonly preview: boolean,
    private readonly sourceFrom: number,
    private readonly sourceTo: number,
    private readonly bodyFrom: number,
    private readonly bodyTo: number,
    private readonly selected = false,
  ) {
    super();
  }

  eq(other: CstMathWidget): boolean {
    return other.latex === this.latex
      && other.raw === this.raw
      && other.isDisplay === this.isDisplay
      && other.preview === this.preview
      && other.selected === this.selected;
  }

  private bindSourceReveal(surface: HTMLElement, view: EditorView): void {
    surface.style.cursor = "pointer";
    surface.dataset.sourceFrom = String(this.sourceFrom);
    surface.dataset.sourceTo = String(this.sourceTo);
    surface.title = this.isDisplay ? "Edit display math" : "Edit inline math";

    const eventType = this.isDisplay ? "mousedown" : "click";
    surface.addEventListener(eventType, (event) => {
      if (
        event.button !== 0
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
      ) {
        return;
      }

      const math = resolveWidgetMathNode(
        view,
        surface,
        this.isDisplay,
        this.raw,
        this.sourceFrom,
        this.sourceTo,
      );
      const body = math ? childOfKind(math, "OpaqueBody") : null;
      const anchor = body
        ? mathSourcePositionFromPointer(surface, event, body)
        : Math.max(
            0,
            Math.min(view.state.doc.length, Math.min(this.bodyFrom, this.bodyTo)),
          );

      event.preventDefault();
      event.stopPropagation();
      view.focus();
      view.dispatch({
        selection: EditorSelection.cursor(anchor),
        scrollIntoView: true,
        userEvent: "select.pointer",
      });
    });
  }

  toDOM(view: EditorView): HTMLElement {
    const ownerDocument = view.dom.ownerDocument;
    if (this.isDisplay) {
      const surface = createDisplayMathSurfaceElement(ownerDocument, this.latex);
      const content = createDisplayMathContentElement(ownerDocument);
      if (this.preview) surface.classList.add("cf-cst-math-preview");
      if (this.selected) surface.classList.add(CSS.selectionRange);
      renderMath(content, this.latex, true);
      surface.appendChild(content);
      this.bindSourceReveal(surface, view);
      return surface;
    }

    const surface = createInlineMathSurfaceElement(ownerDocument, this.latex);
    if (this.preview) surface.classList.add("cf-cst-math-preview");
    renderMath(surface, this.latex, false);
    this.bindSourceReveal(surface, view);
    return surface;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function mathNodeAtPosition(
  tree: SyntaxTree,
  position: number,
  isDisplay: boolean,
): SyntaxNode | null {
  for (const bias of ["right", "left"] as const) {
    const math = containingMath(tree.resolve(position, bias));
    if (math && (math.prop(mathDisplay) ?? false) === isDisplay) return math;
  }
  return null;
}

function resolveWidgetMathNode(
  view: EditorView,
  surface: HTMLElement,
  isDisplay: boolean,
  raw: string,
  sourceFrom: number,
  sourceTo: number,
): SyntaxNode | null {
  const tree = getPandocTree(view.state);
  const positions: number[] = [];
  try {
    positions.push(view.posAtDOM(surface));
  } catch (_error) {
    // A widget can briefly outlive its mapped document range during redraw.
  }
  positions.push(sourceFrom, sourceTo);

  for (const position of positions) {
    if (position < 0 || position > tree.length) continue;
    const direct = mathNodeAtPosition(tree, position, isDisplay);
    if (direct) return direct;

    const line = view.state.doc.lineAt(position);
    let nearby: SyntaxNode | null = null;
    tree.iterate((node) => {
      if (
        !nearby
        && node.kind === "Math"
        && (node.prop(mathDisplay) ?? false) === isDisplay
        && node.text() === raw
      ) {
        nearby = node;
        return false;
      }
      return;
    }, {
      from: line.from,
      to: Math.min(tree.length, line.to + 1),
    });
    if (nearby) return nearby;
  }

  return null;
}

function mathLocationOffset(
  surface: HTMLElement,
  event: MouseEvent,
): number | null {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>("[data-loc-start]")
    : null;
  if (target && surface.contains(target)) {
    const location = Number.parseInt(target.dataset.locStart ?? "", 10);
    if (Number.isFinite(location)) return location;
  }

  let bestLocation: number | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const candidate of surface.querySelectorAll<HTMLElement>("[data-loc-start]")) {
    const rect = candidate.getBoundingClientRect();
    if (
      rect.width <= 0
      || rect.height <= 0
      || event.clientX < rect.left
      || event.clientX > rect.right
      || event.clientY < rect.top
      || event.clientY > rect.bottom
    ) {
      continue;
    }
    const location = Number.parseInt(candidate.dataset.locStart ?? "", 10);
    const area = rect.width * rect.height;
    if (Number.isFinite(location) && area < bestArea) {
      bestLocation = location;
      bestArea = area;
    }
  }
  return bestLocation;
}

function mathSourcePositionFromPointer(
  surface: HTMLElement,
  event: MouseEvent,
  body: SyntaxNode,
): number {
  const location = mathLocationOffset(surface, event);
  if (location !== null) {
    return Math.max(body.from, Math.min(body.to, body.from + location));
  }

  const rect = surface.getBoundingClientRect();
  const fraction = rect.width > 0
    ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    : 0;
  return Math.max(
    body.from,
    Math.min(body.to, body.from + Math.round((body.to - body.from) * fraction)),
  );
}

function addDelimiterPresentation(
  ranges: Array<ReturnType<Decoration["range"]>>,
  node: SyntaxNode,
  active: boolean,
): void {
  for (const child of node.children()) {
    if (!INLINE_DELIMITER_KINDS.has(child.kind)) continue;
    ranges.push(
      active
        ? Decoration.mark({ class: CSS.sourceDelimiter }).range(child.from, child.to)
        : Decoration.replace({}).range(child.from, child.to),
    );
  }
}

function addAtxHeadingPresentation(
  ranges: Array<ReturnType<Decoration["range"]>>,
  state: EditorState,
  node: SyntaxNode,
  active: boolean,
): void {
  const level = node.prop(headingLevel) ?? 1;
  const line = state.doc.lineAt(node.from);
  ranges.push(Decoration.line({
    attributes: {
      class: `${CSS.headingLine(level)} cf-doc-heading${
        active ? "" : ` ${CSS.headingSourceHidden}`
      }`,
      "data-cst-block": node.kind,
    },
  }).range(line.from));

  let prefix = true;
  for (const child of node.children()) {
    if (prefix && (child.kind === "Delimiter" || child.kind === "Whitespace")) {
      ranges.push(
        active
          ? Decoration.mark({ class: CSS.sourceDelimiter }).range(child.from, child.to)
          : Decoration.replace({}).range(child.from, child.to),
      );
      continue;
    }
    prefix = false;
  }
}

function addSetextHeadingPresentation(
  ranges: Array<ReturnType<Decoration["range"]>>,
  state: EditorState,
  node: SyntaxNode,
): void {
  const level = node.prop(headingLevel) ?? 1;
  const firstLine = state.doc.lineAt(node.from);
  ranges.push(Decoration.line({
    attributes: {
      class: `${CSS.headingLine(level)} cf-doc-heading`,
      "data-cst-block": node.kind,
    },
  }).range(firstLine.from));
}

interface HeadingAttributeFlags {
  readonly appendixBoundary: boolean;
  readonly unnumbered: boolean;
}

function headingAttributeFlags(node: SyntaxNode): HeadingAttributeFlags {
  const level = node.prop(headingLevel) ?? 1;
  const attributes = childOfKind(node, "AttributeList");
  let appendixBoundary = false;
  let unnumbered = false;

  for (const attribute of attributes?.children() ?? []) {
    if (attribute.kind !== "Attribute") continue;
    if (attribute.text() === "-") unnumbered = true;
    for (const token of attribute.children()) {
      if (token.kind !== "ClassName") continue;
      if (token.text() === "unnumbered") unnumbered = true;
      if (level === 1 && token.text() === "appendix") {
        appendixBoundary = true;
        unnumbered = true;
      }
    }
  }

  return { appendixBoundary, unnumbered };
}

function buildHeadingNumberDecorations(state: EditorState): DecorationSet {
  const tree = getPandocTree(state);
  const ranges: Array<ReturnType<Decoration["range"]>> = [];
  let counters = initialHeadingNumberCounters();

  tree.iterate((node) => {
    if (node.kind !== "AtxHeading" && node.kind !== "SetextHeading") return;
    const attributes = headingAttributeFlags(node);
    const result = nextHeadingNumber({
      level: node.prop(headingLevel) ?? 1,
      ...attributes,
    }, counters);
    counters = result.counters;
    if (result.number) {
      ranges.push(Decoration.line({
        attributes: { "data-section-number": result.number },
      }).range(state.doc.lineAt(node.from).from));
    }
    return false;
  });

  return Decoration.set(ranges, true);
}

export const cstHeadingNumberDecorationField = StateField.define<DecorationSet>({
  create(state) {
    return buildHeadingNumberDecorations(state);
  },

  update(value, transaction) {
    return transaction.docChanged
      ? buildHeadingNumberDecorations(transaction.state)
      : value;
  },

  provide(field) {
    return EditorView.decorations.from(field);
  },
});

function addFencedDivPresentation(
  ranges: Array<ReturnType<Decoration["range"]>>,
  suppressedSourceRanges: Array<{ readonly from: number; readonly to: number }>,
  view: EditorView,
  node: SyntaxNode,
): void {
  const state = view.state;
  const presentation = fencedDivPresentation(node);
  const sourceRanges = fencedDivSourceRanges(state, node);
  if (!presentation || !sourceRanges) return;

  const addSourceRange = (
    from: number,
    to: number,
    renderedHeader: boolean,
  ): void => {
    if (from >= to) return;
    suppressedSourceRanges.push({ from, to });
    if (selectionTouchesSourceRange(state, from, to)) {
      ranges.push(Decoration.mark({ class: CSS.fencedDivSource }).range(from, to));
      return;
    }
    if (renderedHeader) {
      ranges.push(Decoration.replace({
        widget: new CstFencedDivHeaderWidget(
          presentation,
          state.sliceDoc(from, to),
          from,
        ),
      }).range(from, to));
      return;
    }
    ranges.push(Decoration.replace({}).range(from, to));
  };

  addSourceRange(sourceRanges.openerFrom, sourceRanges.openerTo, true);
  if (
    sourceRanges.closerFrom !== undefined
    && sourceRanges.closerTo !== undefined
  ) {
    addSourceRange(sourceRanges.closerFrom, sourceRanges.closerTo, false);
  }
}

function addCodeBlockPresentation(
  ranges: Array<ReturnType<Decoration["range"]>>,
  state: EditorState,
  node: SyntaxNode,
  visibleFrom: number,
  visibleTo: number,
): void {
  const firstLine = state.doc.lineAt(Math.max(node.from, visibleFrom)).number;
  const lastPosition = Math.max(node.from, Math.min(node.to - 1, visibleTo));
  const lastLine = state.doc.lineAt(lastPosition).number;
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    ranges.push(Decoration.line({
      attributes: {
        class: "cf-cst-code-block",
        "data-cst-block": node.kind,
      },
    }).range(line.from));
  }
}

function addLinkPresentation(
  ranges: Array<ReturnType<Decoration["range"]>>,
  node: SyntaxNode,
  active: boolean,
): void {
  ranges.push(Decoration.mark({ class: active ? CSS.inlineSource : CSS.linkRendered })
    .range(node.from, node.to));
  for (const child of node.children()) {
    if (!LINK_SOURCE_KINDS.has(child.kind)) continue;
    ranges.push(
      active
        ? Decoration.mark({ class: CSS.inlineSource }).range(child.from, child.to)
        : Decoration.replace({}).range(child.from, child.to),
    );
  }
}

function addMathPresentation(
  ranges: Array<ReturnType<Decoration["range"]>>,
  node: SyntaxNode,
  active: boolean,
): boolean {
  const body = childOfKind(node, "OpaqueBody");
  if (!body) return false;
  const latex = body.text();
  const display = node.prop(mathDisplay) ?? false;

  if (display) {
    // Block replacements are supplied by cstDisplayMathDecorationField. A
    // ViewPlugin may only contribute the lightweight source marks needed while
    // this particular expression is active.
    if (!active) return true;
    for (const child of node.children()) {
      const className = child.kind === "MathMark"
        ? CSS.sourceDelimiter
        : CSS.mathSource;
      ranges.push(Decoration.mark({ class: className }).range(child.from, child.to));
    }
    return true;
  }

  if (!active) {
    ranges.push(Decoration.replace({
      widget: new CstMathWidget(
        latex,
        node.text(),
        false,
        false,
        node.from,
        node.to,
        body.from,
        body.to,
      ),
    }).range(node.from, node.to));
    return true;
  }

  for (const child of node.children()) {
    const className = child.kind === "MathMark" ? CSS.sourceDelimiter : CSS.mathSource;
    ranges.push(Decoration.mark({ class: className }).range(child.from, child.to));
  }
  ranges.push(Decoration.widget({
    side: 1,
    widget: new CstMathWidget(
      latex,
      node.text(),
      false,
      true,
      node.from,
      node.to,
      body.from,
      body.to,
    ),
  }).range(node.to));
  return true;
}

interface DisplayMathDecorationState {
  readonly selectionSignature: string;
  readonly decorations: DecorationSet;
}

function activeDisplayMathKeys(
  state: EditorState,
  tree: SyntaxTree,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const range of state.selection.ranges) {
    for (const position of range.empty
      ? [range.head]
      : [range.anchor, range.head]) {
      const math = mathNodeAtPosition(tree, position, true);
      if (math) keys.add(nodeKey(math));
    }
  }
  return keys;
}

function activeDisplayMathSignature(state: EditorState, tree: SyntaxTree): string {
  return [...activeDisplayMathKeys(state, tree)].sort().join("|");
}

function displayMathReplacementFrom(
  state: EditorState,
  node: SyntaxNode,
): number {
  const line = state.doc.lineAt(node.from);
  if (line.from === node.from) return node.from;
  return /^\s*$/.test(state.sliceDoc(line.from, node.from))
    ? line.from
    : node.from;
}

function selectedDisplayMathKeys(
  state: EditorState,
  tree: SyntaxTree,
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (state.selection.ranges.every((range) => range.empty)) return keys;
  tree.iterate((node) => {
    if (
      node.kind === "Math"
      && (node.prop(mathDisplay) ?? false)
      && state.selection.ranges.some((range) => (
        !range.empty
        && range.from <= displayMathReplacementFrom(state, node)
        && range.to >= node.to
      ))
    ) keys.add(nodeKey(node));
  });
  return keys;
}

function displayMathSelectionSignature(
  state: EditorState,
  tree: SyntaxTree,
): string {
  const active = activeDisplayMathSignature(state, tree);
  const selected = [...selectedDisplayMathKeys(state, tree)].sort().join("|");
  return `active:${active};selected:${selected}`;
}

function buildDisplayMathDecorationState(
  state: EditorState,
): DisplayMathDecorationState {
  const tree = getPandocTree(state);
  const active = activeDisplayMathKeys(state, tree);
  const selected = selectedDisplayMathKeys(state, tree);
  const ranges: Array<ReturnType<Decoration["range"]>> = [];

  tree.iterate((node) => {
    // A table owns the rich presentation of all inline content in its cells.
    // Descendant block replacements would overlap the table replacement.
    if (node.kind === "PipeTable") return false;
    if (node.kind !== "Math" || !(node.prop(mathDisplay) ?? false)) return;
    const body = childOfKind(node, "OpaqueBody");
    if (!body) return false;
    const isActive = active.has(nodeKey(node));
    const widget = new CstMathWidget(
      body.text(),
      node.text(),
      true,
      isActive,
      node.from,
      node.to,
      body.from,
      body.to,
      !isActive && selected.has(nodeKey(node)),
    );

    ranges.push(
      isActive
        ? Decoration.widget({ widget, block: true, side: 1 }).range(node.to)
        : Decoration.replace({ widget, block: true }).range(
            displayMathReplacementFrom(state, node),
            node.to,
          ),
    );
    return false;
  });

  return {
    selectionSignature: displayMathSelectionSignature(state, tree),
    decorations: Decoration.set(ranges, true),
  };
}

function rangeTouchesDisplayMath(
  tree: SyntaxTree,
  from: number,
  to: number,
): boolean {
  if (tree.length === 0) return false;
  const searchFrom = Math.max(0, Math.min(tree.length, from) - 1);
  const searchTo = Math.min(
    tree.length,
    Math.max(searchFrom + 1, Math.min(tree.length, to) + 1),
  );
  let found = false;
  tree.iterate((node) => {
    if (node.kind === "Math" && (node.prop(mathDisplay) ?? false)) {
      found = true;
      return false;
    }
    return;
  }, { from: searchFrom, to: searchTo });
  return found;
}

function transactionTouchesDisplayMath(transaction: Transaction): boolean {
  const before = getPandocTree(transaction.startState);
  const after = getPandocTree(transaction.state);
  const invalidations = getPandocInvalidations(transaction.state).changedRanges;
  if (invalidations.length === 0) return true;
  return invalidations.some((range) => (
    rangeTouchesDisplayMath(before, range.oldFrom, range.oldTo)
    || rangeTouchesDisplayMath(after, range.newFrom, range.newTo)
  ));
}

/**
 * Display math replaces line breaks, so CM6 requires these decorations from a
 * state field rather than the viewport ViewPlugin used for inline styling.
 */
export const cstDisplayMathDecorationField =
  StateField.define<DisplayMathDecorationState>({
    create(state) {
      return buildDisplayMathDecorationState(state);
    },

    update(value, transaction) {
      const tree = getPandocTree(transaction.state);
      const selectionSignature = displayMathSelectionSignature(
        transaction.state,
        tree,
      );
      if (!transaction.docChanged) {
        return selectionSignature === value.selectionSignature
          ? value
          : buildDisplayMathDecorationState(transaction.state);
      }

      if (
        selectionSignature === value.selectionSignature
        && !transactionTouchesDisplayMath(transaction)
      ) {
        return {
          selectionSignature,
          decorations: value.decorations.map(transaction.changes),
        };
      }
      return buildDisplayMathDecorationState(transaction.state);
    },

    provide(field) {
      return EditorView.decorations.from(field, (value) => value.decorations);
    },
  });

function buildCstEditDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const tree = getPandocTree(state);
  const active = activeNodeKeys(state, tree);
  const activeDisplayMath = activeDisplayMathKeys(state, tree);
  const activePipeTables = activePipeTableKeys(state, tree);
  const ranges: Array<ReturnType<Decoration["range"]>> = [];
  const decorated = new Set<string>();
  const suppressedFencedDivSourceRanges: Array<{
    readonly from: number;
    readonly to: number;
  }> = [];
  let fencedDivTargets: ReadonlyMap<string, FencedDivTarget> | null = null;

  const getFencedDivTarget = (id: string): FencedDivTarget | undefined => {
    fencedDivTargets ??= collectFencedDivTargets(tree);
    return fencedDivTargets.get(id);
  };

  for (const visible of view.visibleRanges) {
    tree.iterate((node) => {
      if (
        node.kind !== "FencedDiv"
        && rangeContainsNode(suppressedFencedDivSourceRanges, node)
      ) return false;
      const key = nodeKey(node);
      const isActive = active.has(key);
      const inlineClass = DELIMITED_INLINE_CLASSES[node.kind];
      if (inlineClass) {
        if (decorated.has(key)) return;
        decorated.add(key);
        ranges.push(Decoration.mark({ class: inlineClass }).range(node.from, node.to));
        addDelimiterPresentation(ranges, node, isActive);
        return;
      }

      if (isBulletListMark(node)) {
        if (decorated.has(key)) return;
        decorated.add(key);
        ranges.push(Decoration.replace({ widget: bulletListMarkerWidget }).range(
          node.from,
          node.to,
        ));
        return;
      }

      switch (node.kind) {
        case "PipeTable":
          if (decorated.has(key)) return false;
          decorated.add(key);
          // The state field renders an inactive table as one block widget. An
          // active table keeps its source and may use the ordinary inline
          // decorations within its cells.
          if (!activePipeTables.has(key)) return false;
          return;
        case "Math":
          if (decorated.has(key)) return false;
          decorated.add(key);
          addMathPresentation(
            ranges,
            node,
            (node.prop(mathDisplay) ?? false)
              ? activeDisplayMath.has(key)
              : isActive,
          );
          return false;
        case "Link":
        case "AutoLink":
          if (decorated.has(key)) return;
          decorated.add(key);
          addLinkPresentation(ranges, node, isActive);
          return;
        case "AtxHeading":
          if (decorated.has(key)) return;
          decorated.add(key);
          addAtxHeadingPresentation(ranges, state, node, isActive);
          return;
        case "SetextHeading":
          if (decorated.has(key)) return;
          decorated.add(key);
          addSetextHeadingPresentation(ranges, state, node);
          return;
        case "FencedDiv":
          if (decorated.has(key)) return;
          decorated.add(key);
          addFencedDivPresentation(
            ranges,
            suppressedFencedDivSourceRanges,
            view,
            node,
          );
          return;
        case "Citation":
        case "ExampleReference": {
          if (decorated.has(key)) return false;
          const referenceKey = simpleFencedDivReferenceKey(node);
          const target = referenceKey ? getFencedDivTarget(referenceKey) : undefined;
          if (!target) return;
          decorated.add(key);
          if (!isActive) {
            const keyNode = referenceKeyNode(node);
            ranges.push(Decoration.replace({
              widget: new CstFencedDivReferenceWidget(
                target,
                node.text(),
                keyNode?.from ?? node.from,
              ),
            }).range(node.from, node.to));
            return false;
          }
          return;
        }
        case "FencedCodeBlock":
        case "IndentedCodeBlock":
          if (decorated.has(key)) return false;
          decorated.add(key);
          addCodeBlockPresentation(
            ranges,
            state,
            node,
            visible.from,
            visible.to,
          );
          return false;
        default:
          if (node.childCount === 0 && node.from < node.to) {
            const className = sourceHighlightClass(node);
            if (
              className
              && !decorated.has(key)
              && !/[\r\n]/.test(node.text())
            ) {
              decorated.add(key);
              ranges.push(Decoration.mark({ class: className }).range(
                node.from,
                node.to,
              ));
            }
          }
          return;
      }
    }, visible);
  }

  const context = getPandocCursorContext(state);
  const activeLine = state.doc.lineAt(context.position);
  if (view.visibleRanges.some((range) => (
    activeLine.to >= range.from && activeLine.from <= range.to
  ))) {
    ranges.push(Decoration.line({
      attributes: {
        class: "cf-cst-active-line",
        ...(context.block ? { "data-cst-block": context.block.kind } : {}),
        ...(context.inline ? { "data-cst-inline": context.inline.kind } : {}),
      },
    }).range(activeLine.from));
  }

  return Decoration.set(ranges, true);
}

export const cstEditDecorationPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildCstEditDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = buildCstEditDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

function containingMath(node: SyntaxNode | null): SyntaxNode | null {
  let current = node;
  while (current) {
    if (current.kind === "Math") return current;
    current = current.parent;
  }
  return null;
}

function containingFencedDivReference(node: SyntaxNode | null): SyntaxNode | null {
  let current = node;
  while (current) {
    if (current.kind === "Citation" || current.kind === "ExampleReference") {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function enterRenderedFencedDivReference(
  view: EditorView,
  direction: "left" | "right",
): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const tree = getPandocTree(view.state);
  const reference = containingFencedDivReference(
    tree.resolve(selection.head, direction),
  );
  if (!reference) return false;
  if (direction === "right" && reference.from !== selection.head) return false;
  if (direction === "left" && reference.to !== selection.head) return false;
  const key = simpleFencedDivReferenceKey(reference);
  if (!key || !collectFencedDivTargets(tree).has(key)) return false;
  const keyNode = referenceKeyNode(reference);
  if (!keyNode) return false;
  view.dispatch({
    selection: EditorSelection.cursor(
      direction === "right" ? keyNode.from : keyNode.to,
    ),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

function enterRenderedMath(view: EditorView, direction: "left" | "right"): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const tree = getPandocTree(view.state);
  const math = containingMath(tree.resolve(selection.head, direction));
  if (!math) return false;
  if (direction === "right" && math.from !== selection.head) return false;
  if (direction === "left" && math.to !== selection.head) return false;
  const body = childOfKind(math, "OpaqueBody");
  if (!body) return false;
  const anchor = direction === "right" ? body.from : body.to;
  view.dispatch({
    selection: EditorSelection.cursor(anchor),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

export const cstMathKeyboardNavigation: Extension = keymap.of([
  {
    key: "ArrowRight",
    run: (view) => enterRenderedMath(view, "right"),
  },
  {
    key: "ArrowLeft",
    run: (view) => enterRenderedMath(view, "left"),
  },
]);

export const cstFencedDivReferenceKeyboardNavigation: Extension = keymap.of([
  {
    key: "ArrowRight",
    run: (view) => enterRenderedFencedDivReference(view, "right"),
  },
  {
    key: "ArrowLeft",
    run: (view) => enterRenderedFencedDivReference(view, "left"),
  },
]);

export const cstEditTheme: Extension = EditorView.theme({
  ".cf-cst-superscript": {
    fontSize: "0.78em",
    verticalAlign: "super",
  },
  ".cf-cst-subscript": {
    fontSize: "0.78em",
    verticalAlign: "sub",
  },
  ".cf-cst-quoted": {
    color: "inherit",
  },
  ".cf-list-bullet": {
    color: "var(--cf-fg)",
    fontFamily: "var(--cf-content-font)",
    fontWeight: "700",
  },
  [`.${CSS.blockquoteMark}`]: {
    color: "var(--cf-muted)",
    fontFamily: "var(--cf-code-font)",
  },
  [`.${CSS.fencedDivHeader}`]: {
    color: "var(--cf-fg)",
    cursor: "pointer",
    fontStyle: "normal",
    fontWeight: "700",
    lineHeight: "0",
    verticalAlign: "baseline",
  },
  [`.${CSS.fencedDivSource}`]: {
    color: "var(--cf-muted)",
    fontFamily: "var(--cf-code-font)",
    fontSize: "0.86em",
    fontStyle: "normal",
    fontWeight: "400",
  },
  [`.${CSS.fencedDivReference}`]: {
    color: "var(--cf-accent)",
    cursor: "pointer",
    textDecoration: "underline",
    textDecorationStyle: "dotted",
    textUnderlineOffset: "0.16em",
  },
  ".cm-line.cf-cst-code-block": {
    backgroundColor: "var(--cf-subtle)",
    boxSizing: "border-box",
    fontFamily: "var(--cf-code-font, Monaco, 'DejaVu Sans Mono', Consolas, monospace)",
    fontSize: "0.88em",
    paddingInline: "1em",
    whiteSpace: "pre-wrap",
  },
  ".cf-cst-math-preview": {
    background: "var(--cf-bg)",
    border: "1px solid var(--cf-border)",
    borderRadius: "3px",
    boxShadow: "0 4px 14px rgba(0, 0, 0, 0.12)",
    display: "inline-block",
    marginInlineStart: "0.45em",
    padding: "0.15em 0.4em",
    verticalAlign: "middle",
  },
  ".cf-math-display.cf-cst-math-preview": {
    display: "block",
    marginBlock: "0.45em",
    marginInline: "auto",
    padding: "0.45em 0.75em",
    width: "fit-content",
  },
});

export const cstEditSurface: Extension = [
  cstHeadingNumberDecorationField,
  cstDisplayMathDecorationField,
  cstTableSurface,
  cstEditDecorationPlugin,
  cstMathKeyboardNavigation,
  cstFencedDivReferenceKeyboardNavigation,
  cstEditTheme,
];
