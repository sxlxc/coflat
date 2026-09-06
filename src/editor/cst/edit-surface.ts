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
  Direction,
  EditorView,
  keymap,
  layer,
  RectangleMarker,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  fenceClosed,
  headingLevel,
  mathDisplay,
  type NodeKind,
  type SourceRange,
  type SyntaxNode,
  type SyntaxTree,
} from "pandocmd-cst";
import { CSS } from "../../core/constants/css-classes";
import {
  createDisplayMathContentElement,
  createDisplayMathSurfaceElement,
  syncDisplayMathEquationNumber,
} from "../../core/math-display-surface";
import {
  createInlineMathSurfaceElement,
  renderInlineMathErrorFallback,
} from "../../core/math-inline-surface";
import {
  initialHeadingNumberCounters,
  nextHeadingNumber,
} from "../../core/semantics/heading-numbering";
import { cstCitationSurface } from "../citations/citation-surface";
import { renderKatexToHtml } from "../render/katex-render";
import { getPandocCursorContext, resolvePandocNode } from "./cursor-context";
import { changedBlockRanges, selectionSourceRanges } from "./decoration-ranges";
import {
  cstDocumentPresentationField,
  type FencedDivPresentation,
  getDocumentPresentation,
} from "./document-presentation";
import { getPandocTree } from "./pandoc-cst-field";
import {
  activePipeTableKeys,
  cstTableDecorationField,
  cstTableSurface,
} from "./table-surface";
import {
  cstYamlMetadataField,
  getYamlMathMacros,
  getYamlMathMacrosKey,
} from "./yaml-metadata";

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

interface FencedDivSourceRanges {
  readonly openerFrom: number;
  readonly openerTo: number;
  readonly closerFrom?: number;
  readonly closerTo?: number;
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

function lastFencedDivContentLine(
  state: EditorState,
  node: SyntaxNode,
): number | null {
  const fences = fencedDivSourceRanges(state, node);
  if (!fences) return null;
  const body = [...node.children()].filter((child) => (
    child.from > fences.openerTo
    && child.to <= (fences.closerFrom ?? node.to)
    && child.kind !== "BlankLines"
    && child.kind !== "LineEnding"
    && child.kind !== "Whitespace"
  )).at(-1);
  if (!body) return null;
  if (body.kind === "FencedDiv") return lastFencedDivContentLine(state, body);
  const lastCharacter = body.from + body.text().trimEnd().length - 1;
  return lastCharacter < body.from ? null : state.doc.lineAt(lastCharacter).to;
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

class CstProofQedWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const qed = view.dom.ownerDocument.createElement("span");
    qed.className = CSS.blockQed;
    qed.textContent = "∎";
    qed.setAttribute("aria-label", "End of proof");
    return qed;
  }
}

const proofQedWidget = new CstProofQedWidget();

export function selectedFencedDivs(state: EditorState): readonly SyntaxNode[] {
  const tree = getPandocTree(state);
  const divs = new Map<number, SyntaxNode>();
  for (const range of selectionSourceRanges(state)) {
    tree.iterate((node) => {
      if (node.kind !== "FencedDiv") return;
      const end = node.prop(fenceClosed) ? Math.max(node.from, node.to - 1) : node.to;
      if (!selectionTouchesSourceRange(state, node.from, state.doc.lineAt(end).to)) {
        return false;
      }
      divs.set(node.from, node);
    }, {
      // Iteration excludes boundary-touching nodes and empty ranges, whereas
      // a cursor at either fence edge still belongs to the div.
      from: Math.max(0, range.from - 1),
      to: Math.min(tree.length, range.to + 1),
    });
  }
  return [...divs.values()];
}

// A measured layer keeps the range continuous across wrapped lines and block
// previews without changing the editable document's layout.
const cstFencedDivRangeLayer = layer({
  above: false,
  update: (update) => update.docChanged || update.selectionSet,
  markers(view) {
    const markers: RectangleMarker[] = [];
    const content = view.contentDOM.getBoundingClientRect();
    const scroll = view.scrollDOM.getBoundingClientRect();
    const padding = Number.parseFloat(getComputedStyle(view.contentDOM).paddingLeft);
    const baseLeft = (view.textDirection === Direction.LTR
      ? scroll.left
      : scroll.right - view.scrollDOM.clientWidth * view.scaleX)
      - view.scrollDOM.scrollLeft * view.scaleX;
    const left = content.left - baseLeft + padding * view.scaleX;
    const top = view.documentTop - scroll.top
      + view.scrollDOM.scrollTop * view.scaleY;

    for (const node of selectedFencedDivs(view.state)) {
      const end = node.prop(fenceClosed) ? Math.max(node.from, node.to - 1) : node.to;
      let depth = 0;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.kind === "FencedDiv") depth += 1;
      }
      const first = view.lineBlockAt(node.from);
      const last = view.lineBlockAt(end);
      markers.push(new RectangleMarker(
        CSS.fencedDivRange,
        left - (12 + depth * 6) * view.scaleX,
        top + first.top,
        2 * view.scaleX,
        last.bottom - first.top,
      ));
    }
    return markers;
  },
});

class CstFencedDivHeaderWidget extends WidgetType {
  constructor(
    private readonly presentation: FencedDivPresentation,
    private readonly source: string,
    private readonly sourceFrom: number,
    private readonly macros: Readonly<Record<string, string>>,
    private readonly macrosKey: string,
  ) {
    super();
  }

  eq(other: CstFencedDivHeaderWidget): boolean {
    return other.presentation.label === this.presentation.label
      && other.presentation.number === this.presentation.number
      && other.presentation.title === this.presentation.title
      && other.presentation.id === this.presentation.id
      && other.source === this.source
      && other.sourceFrom === this.sourceFrom
      && other.macrosKey === this.macrosKey;
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

    const numberedLabel = this.presentation.number === undefined
      ? this.presentation.label
      : `${this.presentation.label} ${this.presentation.number}`;
    header.append(numberedLabel);
    if (this.presentation.title) {
      header.append(" (");
      appendFencedDivTitle(header, this.presentation.title, this.macros);
      header.append(")");
    }
    bindSourceReveal(header, view, this.sourceFrom);
    return header;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

interface FencedDivTitlePart {
  readonly kind: "math" | "text";
  readonly value: string;
}

function isEscapedAt(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function titleMathClose(
  title: string,
  from: number,
  delimiter: "$" | "\\)",
): number {
  for (let cursor = from; cursor < title.length; cursor += 1) {
    if (title.startsWith(delimiter, cursor) && !isEscapedAt(title, cursor)) {
      return cursor;
    }
  }
  return -1;
}

/** Split only the inline-math syntax allowed inside a fenced-div title. */
function fencedDivTitleParts(title: string): FencedDivTitlePart[] {
  const parts: FencedDivTitlePart[] = [];
  let textFrom = 0;
  let cursor = 0;
  while (cursor < title.length) {
    const dollar = title[cursor] === "$"
      && title[cursor + 1] !== "$"
      && title[cursor - 1] !== "$"
      && !isEscapedAt(title, cursor);
    const paren = title.startsWith("\\(", cursor)
      && !isEscapedAt(title, cursor);
    if (!dollar && !paren) {
      cursor += 1;
      continue;
    }

    const openLength = paren ? 2 : 1;
    const closeDelimiter: "$" | "\\)" = paren ? "\\)" : "$";
    const close = titleMathClose(title, cursor + openLength, closeDelimiter);
    if (close < 0 || close === cursor + openLength) {
      cursor += openLength;
      continue;
    }
    if (textFrom < cursor) {
      parts.push({ kind: "text", value: title.slice(textFrom, cursor) });
    }
    parts.push({
      kind: "math",
      value: title.slice(cursor + openLength, close),
    });
    cursor = close + closeDelimiter.length;
    textFrom = cursor;
  }
  if (textFrom < title.length) {
    parts.push({ kind: "text", value: title.slice(textFrom) });
  }
  return parts;
}

function appendFencedDivTitle(
  parent: HTMLElement,
  title: string,
  macros: Readonly<Record<string, string>>,
): void {
  for (const part of fencedDivTitleParts(title)) {
    if (part.kind === "text") {
      parent.append(part.value);
      continue;
    }
    const math = createInlineMathSurfaceElement(parent.ownerDocument, part.value);
    renderMath(math, part.value, false, macros);
    parent.appendChild(math);
  }
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
    private readonly target: { readonly id: string; readonly label: string },
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
    addAncestors(active, resolvePandocNode(tree, range.head, "right"));
    if (range.anchor !== range.head) {
      addAncestors(active, resolvePandocNode(tree, range.anchor, "right"));
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
  macros: Readonly<Record<string, string>>,
): void {
  try {
    const html = renderKatexToHtml(
      latex,
      isDisplay,
      macros,
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
    private readonly macros: Readonly<Record<string, string>>,
    private readonly macrosKey: string,
    private readonly sourceFrom: number,
    private readonly sourceTo: number,
    private readonly bodyFrom: number,
    private readonly bodyTo: number,
    private readonly selected = false,
    private readonly equationNumber?: number,
    private readonly equationId?: string,
  ) {
    super();
  }

  eq(other: CstMathWidget): boolean {
    return other.latex === this.latex
      && other.raw === this.raw
      && other.isDisplay === this.isDisplay
      && other.preview === this.preview
      && other.macrosKey === this.macrosKey
      && other.selected === this.selected
      && other.equationNumber === this.equationNumber
      && other.equationId === this.equationId;
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
      const surface = createDisplayMathSurfaceElement(ownerDocument, this.latex, {
        equationNumber: this.equationNumber,
        id: this.equationId,
      });
      const content = createDisplayMathContentElement(ownerDocument);
      if (this.preview) surface.classList.add("cf-cst-math-preview");
      if (this.selected) surface.classList.add(CSS.selectionRange);
      renderMath(content, this.latex, true, this.macros);
      surface.appendChild(content);
      syncDisplayMathEquationNumber(surface, this.equationNumber);
      this.bindSourceReveal(surface, view);
      return surface;
    }

    const surface = createInlineMathSurfaceElement(ownerDocument, this.latex);
    if (this.preview) surface.classList.add("cf-cst-math-preview");
    renderMath(surface, this.latex, false, this.macros);
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
    const math = containingMath(resolvePandocNode(tree, position, bias));
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
    if (!transaction.docChanged) return value;
    return transactionTouchesNodes(transaction, (node) => (
      node.kind === "AtxHeading" || node.kind === "SetextHeading"
    ))
      ? buildHeadingNumberDecorations(transaction.state)
      : value.map(transaction.changes);
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
  presentation: FencedDivPresentation | undefined,
  macros: Readonly<Record<string, string>>,
  macrosKey: string,
): void {
  const state = view.state;
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
          macros,
          macrosKey,
        ),
      }).range(from, to));
      return;
    }
    ranges.push(Decoration.replace({}).range(from, to));
  };

  addSourceRange(
    sourceRanges.openerFrom,
    sourceRanges.openerTo,
    presentation.canonicalClassName !== "equation",
  );
  if (
    sourceRanges.closerFrom !== undefined
    && sourceRanges.closerTo !== undefined
  ) {
    addSourceRange(sourceRanges.closerFrom, sourceRanges.closerTo, false);
    if (presentation.canonicalClassName === "proof") {
      const contentEnd = lastFencedDivContentLine(state, node);
      if (contentEnd !== null) {
        let position = contentEnd;
        for (const decorations of [
          state.field(cstDisplayMathDecorationField).decorations,
          state.field(cstTableDecorationField).decorations,
        ]) {
          decorations.between(contentEnd, contentEnd, (from, to, decoration) => {
            if (decoration.spec.block && from < to) position = Math.max(position, to);
          });
        }
        ranges.push(Decoration.widget({
          widget: proofQedWidget,
          side: 1,
        }).range(position));
      }
    }
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
  macros: Readonly<Record<string, string>>,
  macrosKey: string,
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
        macros,
        macrosKey,
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
      macros,
      macrosKey,
      node.from,
      node.to,
      body.from,
      body.to,
    ),
  }).range(node.to));
  return true;
}

interface DisplayMathDecorationState {
  readonly mathMacrosKey: string;
  readonly presentation: ReturnType<typeof getDocumentPresentation>;
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
  for (const range of selectionSourceRanges(state)) {
    if (range.from === range.to) continue;
    tree.iterate((node) => {
      if (node.kind !== "Math" || !(node.prop(mathDisplay) ?? false)) return;
      if (
        range.from <= displayMathReplacementFrom(state, node)
        && range.to >= node.to
      ) keys.add(nodeKey(node));
      return false;
    }, range);
  }
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

function withoutSourceRanges(
  decorations: DecorationSet,
  ranges: readonly SourceRange[],
): DecorationSet {
  return decorations.update({
    filter: (from, to) => !ranges.some((range) => (
      from === to
        ? range.from <= from && from < range.to
        : from < range.to && range.from < to
    )),
  });
}

function buildDisplayMathDecorationState(
  state: EditorState,
  update?: {
    readonly nodes: readonly SyntaxNode[];
    readonly decorations: DecorationSet;
    readonly ranges: readonly SourceRange[];
  },
): DisplayMathDecorationState {
  const tree = getPandocTree(state);
  const active = activeDisplayMathKeys(state, tree);
  const selected = selectedDisplayMathKeys(state, tree);
  const macros = getYamlMathMacros(state);
  const macrosKey = getYamlMathMacrosKey(state);
  const presentation = getDocumentPresentation(state);
  const ranges: Array<ReturnType<Decoration["range"]>> = [];

  const addMath = (node: SyntaxNode): false | undefined => {
    // A table owns the rich presentation of all inline content in its cells.
    // Descendant block replacements would overlap the table replacement.
    if (node.kind === "PipeTable") return false;
    if (node.kind !== "Math" || !(node.prop(mathDisplay) ?? false)) return;
    const body = childOfKind(node, "OpaqueBody");
    if (!body) return false;
    const isActive = active.has(nodeKey(node));
    const equation = presentation.equationsByMathFrom.get(node.from);
    const widget = new CstMathWidget(
      body.text(),
      node.text(),
      true,
      isActive,
      macros,
      macrosKey,
      node.from,
      node.to,
      body.from,
      body.to,
      !isActive && selected.has(nodeKey(node)),
      equation?.number,
      equation?.id,
    );

    ranges.push(
      isActive
        ? Decoration.widget({ widget, block: true, side: -1 }).range(
            displayMathReplacementFrom(state, node),
          )
        // Allow trailing inline widgets, such as a proof tombstone, at the end.
        : Decoration.replace({ widget, block: true, inclusiveEnd: false }).range(
            displayMathReplacementFrom(state, node),
            node.to,
          ),
    );
    if (isActive) {
      const first = state.doc.lineAt(node.from).number;
      const last = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
      for (let line = first; line <= last; line += 1) {
        ranges.push(Decoration.line({
          attributes: { class: CSS.mathSourceLine },
        }).range(state.doc.line(line).from));
      }
    }
    return false;
  };
  if (update) {
    for (const node of update.nodes) addMath(node);
  } else {
    tree.iterate(addMath);
  }

  return {
    mathMacrosKey: macrosKey,
    presentation,
    selectionSignature: displayMathSelectionSignature(state, tree),
    decorations: update
      ? withoutSourceRanges(update.decorations, update.ranges).update({
        add: ranges,
        sort: true,
      })
      : Decoration.set(ranges, true),
  };
}

function displayMathSourceRange(
  state: EditorState,
  node: SyntaxNode,
): SourceRange {
  return {
    from: state.doc.lineAt(node.from).from,
    to: Math.min(state.doc.length, state.doc.lineAt(Math.max(node.from, node.to - 1)).to + 1),
  };
}

function displayMathSourcesInRanges(
  state: EditorState,
  ranges: readonly SourceRange[],
): readonly SyntaxNode[] {
  const tree = getPandocTree(state);
  const nodes = new Map<number, SyntaxNode>();
  // Source-line decorations can precede a math node within its line.
  const pending = ranges.map((range) => ({
    from: state.doc.lineAt(Math.max(0, range.from - 1)).from,
    to: Math.min(state.doc.length, state.doc.lineAt(Math.max(range.from, range.to - 1)).to + 1),
  }));
  for (const range of pending) {
    tree.iterate((node) => {
      if (node.kind === "PipeTable") return false;
      if (node.kind !== "Math" || !(node.prop(mathDisplay) ?? false)) return;
      if (!nodes.has(node.from)) {
        nodes.set(node.from, node);
        // Math that shares source lines must be rebuilt together.
        pending.push(displayMathSourceRange(state, node));
      }
      return false;
    }, range);
  }
  return [...nodes.values()];
}

function updateDisplayMathDecorationState(
  value: DisplayMathDecorationState,
  transaction: Transaction,
): DisplayMathDecorationState {
  const before = transaction.startState;
  const after = transaction.state;
  // Selection endpoints are inclusive even when the selected text ends at
  // the beginning of a math source line.
  const oldRanges: SourceRange[] = selectionSourceRanges(before).flatMap((range) => (
    [range, { from: range.to, to: range.to }]
  ));
  const newRanges: SourceRange[] = selectionSourceRanges(after).flatMap((range) => (
    [range, { from: range.to, to: range.to }]
  ));
  const changed = changedBlockRanges(transaction);
  oldRanges.push(...changed.oldRanges);
  newRanges.push(...changed.newRanges);

  const oldSources = displayMathSourcesInRanges(before, oldRanges).map((node) => (
    displayMathSourceRange(before, node)
  ));
  const mappedSources = oldSources.map((range) => ({
    from: transaction.changes.mapPos(range.from, -1),
    to: transaction.changes.mapPos(range.to, 1),
  }));
  const nodes = displayMathSourcesInRanges(after, [...newRanges, ...mappedSources]);
  return buildDisplayMathDecorationState(after, {
    nodes,
    decorations: withoutSourceRanges(value.decorations, oldSources).map(transaction.changes),
    ranges: nodes.map((node) => displayMathSourceRange(after, node)),
  });
}

function rangeTouchesNodes(
  tree: SyntaxTree,
  from: number,
  to: number,
  matches: (node: SyntaxNode) => boolean,
): boolean {
  if (tree.length === 0) return false;
  const searchFrom = Math.max(0, Math.min(tree.length, from) - 1);
  const searchTo = Math.min(
    tree.length,
    Math.max(searchFrom + 1, Math.min(tree.length, to) + 1),
  );
  let found = false;
  tree.iterate((node) => {
    if (found) return false;
    if (matches(node)) {
      found = true;
      return false;
    }
    return;
  }, { from: searchFrom, to: searchTo });
  return found;
}

function transactionTouchesNodes(
  transaction: Transaction,
  matches: (node: SyntaxNode) => boolean,
): boolean {
  const before = getPandocTree(transaction.startState);
  const after = getPandocTree(transaction.state);
  const changed = changedBlockRanges(transaction);
  return changed.oldRanges.some((range) => (
    rangeTouchesNodes(before, range.from, range.to, matches)
  )) || changed.newRanges.some((range) => (
    rangeTouchesNodes(after, range.from, range.to, matches)
  ));
}

function equationPresentationChanged(
  before: ReturnType<typeof getDocumentPresentation>,
  after: ReturnType<typeof getDocumentPresentation>,
  transaction: Transaction,
): boolean {
  if (before.equationsByMathFrom === after.equationsByMathFrom) return false;
  if (before.equationsByMathFrom.size !== after.equationsByMathFrom.size) return true;
  for (const [from, equation] of before.equationsByMathFrom) {
    const mapped = after.equationsByMathFrom.get(transaction.changes.mapPos(from, 1));
    if (mapped?.number !== equation.number || mapped.id !== equation.id) return true;
  }
  return false;
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
      const macrosKey = getYamlMathMacrosKey(transaction.state);
      const presentation = getDocumentPresentation(transaction.state);
      if (
        macrosKey !== value.mathMacrosKey
        || equationPresentationChanged(value.presentation, presentation, transaction)
      ) {
        return buildDisplayMathDecorationState(transaction.state);
      }
      if (!transaction.docChanged && selectionSignature === value.selectionSignature) {
        return value;
      }

      return updateDisplayMathDecorationState(value, transaction);
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
  const macros = getYamlMathMacros(state);
  const macrosKey = getYamlMathMacrosKey(state);
  const presentation = getDocumentPresentation(state);
  const ranges: Array<ReturnType<Decoration["range"]>> = [];
  const decorated = new Set<string>();
  const suppressedFencedDivSourceRanges: Array<{
    readonly from: number;
    readonly to: number;
  }> = [];

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
            macros,
            macrosKey,
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
            presentation.fencedDivsByFrom.get(node.from),
            macros,
            macrosKey,
          );
          return;
        case "Citation":
        case "ExampleReference": {
          if (decorated.has(key)) return false;
          const referenceKey = simpleFencedDivReferenceKey(node);
          const target = referenceKey
            ? presentation.localTargets.get(referenceKey)
            : undefined;
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
  const presentation = getDocumentPresentation(view.state);
  const reference = containingFencedDivReference(
    resolvePandocNode(tree, selection.head, direction),
  );
  if (!reference) return false;
  if (direction === "right" && reference.from !== selection.head) return false;
  if (direction === "left" && reference.to !== selection.head) return false;
  const key = simpleFencedDivReferenceKey(reference);
  if (!key || !presentation.localTargets.has(key)) return false;
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
  const math = containingMath(resolvePandocNode(tree, selection.head, direction));
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
  [`.${CSS.yamlMetadataHeader}`]: {
    boxSizing: "border-box",
    display: "block",
    paddingBlock: "0.15em",
    width: "100%",
  },
  [`.${CSS.yamlToggle}`]: {
    appearance: "none",
    backgroundColor: "transparent",
    border: "1px solid var(--cf-border)",
    borderRadius: "3px",
    color: "var(--cf-muted)",
    cursor: "pointer",
    fontFamily: "var(--cf-code-font)",
    fontSize: "0.7em",
    lineHeight: "1.35",
    padding: "0.08em 0.38em",
  },
  [`.${CSS.yamlToggle}:hover`]: {
    backgroundColor: "var(--cf-subtle)",
    color: "var(--cf-fg)",
  },
  [`.${CSS.yamlToggle}:focus-visible`]: {
    outline: "2px solid var(--cf-accent)",
    outlineOffset: "2px",
  },
  [`.cm-line.${CSS.yamlSource}`]: {
    backgroundColor: "var(--cf-subtle)",
    color: "var(--cf-fg)",
    fontFamily: "var(--cf-code-font)",
    fontSize: "0.82em",
  },
  [`.cm-line.${CSS.yamlHidden}`]: {
    fontSize: "0",
    height: "0",
    lineHeight: "0",
    minHeight: "0",
    overflow: "hidden",
    padding: "0",
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
    backgroundColor: "var(--cf-subtle)",
    color: "var(--cf-fg)",
    fontFamily: "var(--cf-code-font)",
    fontSize: "0.86em",
    fontStyle: "normal",
    fontWeight: "400",
  },
  [`.${CSS.fencedDivRange}`]: {
    backgroundColor: "var(--cf-muted)",
    pointerEvents: "none",
  },
  [`.${CSS.blockQed}`]: {
    color: "var(--cf-fg)",
    float: "right",
    fontFamily: "var(--cf-content-font)",
    fontStyle: "normal",
    fontWeight: "400",
    userSelect: "none",
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
  },
  ".cf-math-inline.cf-cst-math-preview": {
    border: "0",
    boxShadow: "none",
    boxSizing: "border-box",
    display: "inline-block",
    margin: "0 0 0 0.25em",
    padding: "0 0.25em",
    verticalAlign: "baseline",
  },
  ".cf-math-display.cf-cst-math-preview": {
    border: "0",
    borderRadius: "0",
    boxShadow: "none",
    margin: "0",
    padding: "0.35em 0",
  },
});

export const cstEditSurface: Extension = [
  cstYamlMetadataField,
  cstDocumentPresentationField,
  cstCitationSurface,
  cstHeadingNumberDecorationField,
  cstDisplayMathDecorationField,
  cstTableSurface,
  cstEditDecorationPlugin,
  cstFencedDivRangeLayer,
  cstMathKeyboardNavigation,
  cstFencedDivReferenceKeyboardNavigation,
  cstEditTheme,
];
