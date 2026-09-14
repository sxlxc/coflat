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
  fenceInfo,
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
import { cstCitationSurface } from "../citations/citation-surface";
import { renderKatexToHtml } from "../render/katex-render";
import { mathSourceOffsetFromPointer } from "../render/math-source-position";
import { getPandocCursorContext, resolvePandocNode } from "./cursor-context";
import { changedBlockRanges, selectionSourceRanges } from "./decoration-ranges";
import {
  cstDocumentPresentationField,
  type FencedDivPresentation,
  fencedDivTitleRange,
  getDocumentPresentation,
} from "./document-presentation";
import { getPandocTree } from "./pandoc-cst-field";
import { addOpaqueSourceHighlights, addSourceToken } from "./source-highlighting";
import {
  activePipeTableKeys,
  containingPipeTable,
  cstTableDecorationField,
  cstTableSurface,
} from "./table-surface";
import {
  cstYamlMetadataField,
  getYamlMathMacros,
  getYamlMathMacrosKey,
  isYamlMetadataActive,
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
    private readonly label: string,
    private readonly sourceFrom: number,
  ) {
    super();
  }

  eq(other: CstFencedDivHeaderWidget): boolean {
    return other.label === this.label && other.sourceFrom === this.sourceFrom;
  }

  toDOM(view: EditorView): HTMLElement {
    const label = view.dom.ownerDocument.createElement("span");
    label.textContent = this.label;
    bindSourceReveal(label, view, this.sourceFrom);
    return label;
  }

  ignoreEvent(): boolean {
    return true;
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
  // Keep source visible at both boundaries. Hiding a closing delimiter under
  // the caret makes Firefox move its DOM selection back before that delimiter.
  for (const range of state.selection.ranges) {
    addAncestors(active, resolvePandocNode(tree, range.head, "right"));
    addAncestors(active, resolvePandocNode(tree, range.head, "left"));
    if (range.anchor !== range.head) {
      addAncestors(active, resolvePandocNode(tree, range.anchor, "right"));
      addAncestors(active, resolvePandocNode(tree, range.anchor, "left"));
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
        ? body.from + mathSourceOffsetFromPointer(surface, event, body.text())
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

function buildHeadingNumberDecorations(state: EditorState): DecorationSet {
  const ranges: Array<ReturnType<Decoration["range"]>> = [];
  for (const [from, heading] of getDocumentPresentation(state).headingsByFrom) {
    if (heading.number) {
      ranges.push(Decoration.line({
        attributes: { "data-section-number": heading.number },
      }).range(state.doc.lineAt(from).from));
    }
  }
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
  outerDecorations: Array<ReturnType<Decoration["range"]>>,
  suppressedSourceRanges: Array<{ readonly from: number; readonly to: number }>,
  view: EditorView,
  node: SyntaxNode,
  presentation: FencedDivPresentation | undefined,
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
    const active = selectionTouchesSourceRange(state, from, to);
    if (active || !renderedHeader) {
      suppressedSourceRanges.push({ from, to });
      ranges.push(active
        ? Decoration.mark({ class: CSS.fencedDivSource }).range(from, to)
        : Decoration.replace({}).range(from, to));
      return;
    }
    outerDecorations.push(Decoration.mark({
      class: CSS.fencedDivHeader,
      inclusive: true,
      attributes: {
        "data-block-class": presentation.className,
        ...(presentation.id ? { "data-reference-id": presentation.id } : {}),
        "aria-label": state.sliceDoc(from, to),
        title: "Edit fenced div attributes",
      },
    }).range(from, to));
    const label = presentation.number === undefined
      ? presentation.label
      : `${presentation.label} ${presentation.number}`;
    const title = presentation.title ? fencedDivTitleRange(node) : null;
    const prefix = { from, to: title?.from ?? to };
    suppressedSourceRanges.push(prefix);
    ranges.push(Decoration.replace({
      widget: new CstFencedDivHeaderWidget(title ? `${label} (` : label, from),
    }).range(prefix.from, prefix.to));
    if (title) {
      const suffix = { from: title.to, to };
      suppressedSourceRanges.push(suffix);
      ranges.push(Decoration.replace({
        widget: new CstFencedDivHeaderWidget(")", from),
      }).range(suffix.from, suffix.to));
    }
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
            if (decoration.spec.block && from < to) {
              // Inclusive replacements hide inline widgets at their end. The
              // following source row remains available before the proof closes.
              const after = decoration.spec.inclusiveEnd === false ? to : to + 1;
              position = Math.max(position, after);
            }
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
  const language = node.prop(fenceInfo);
  if (language) {
    const body = [...node.children()].filter((child) => child.kind === "OpaqueBody");
    const first = body[0];
    const last = body.at(-1);
    if (first && last) addOpaqueSourceHighlights(
      ranges, state, first.from, Math.min(last.to, visibleTo), language, visibleFrom,
    );
  }
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
  outerDecorations: Array<ReturnType<Decoration["range"]>>,
  state: EditorState,
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
      outerDecorations.push(Decoration.mark({ class: className }).range(child.from, child.to));
    }
    addOpaqueSourceHighlights(ranges, state, body.from, body.to, "math");
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
    outerDecorations.push(Decoration.mark({ class: className }).range(child.from, child.to));
  }
  addOpaqueSourceHighlights(ranges, state, body.from, body.to, "math");
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
      if (math) {
        keys.add(nodeKey(math));
      } else {
        // Replacement rows can include whitespace outside the Math CST node.
        // A caret there must reveal the source rather than remain hidden.
        const line = state.doc.lineAt(position);
        tree.iterate((node) => {
          if (node.kind !== "Math" || !(node.prop(mathDisplay) ?? false)) return;
          if (displayMathReplacementFrom(state, node) <= position
            && position <= displayMathReplacementTo(state, node)) keys.add(nodeKey(node));
          return false;
        }, { from: line.from, to: line.to });
      }
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

function displayMathReplacementTo(state: EditorState, node: SyntaxNode): number {
  const line = state.doc.lineAt(node.to);
  return state.sliceDoc(node.to, line.to).trim() === "" ? line.to : node.to;
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
        : Decoration.replace({ widget, block: true }).range(
            displayMathReplacementFrom(state, node),
            displayMathReplacementTo(state, node),
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

function addTrailingPunctuationGroup(
  ranges: Array<ReturnType<Decoration["range"]>>,
  node: SyntaxNode,
): void {
  const next = node.nextSibling();
  if (next?.kind !== "InlineText" || next.from !== node.to) return;
  // Classify only the adjacent CST text; punctuation stays editable source.
  const punctuation = /^[,.;:!?%‰…、。，．：；！？％\p{Pe}\p{Pf}]+/u.exec(next.text())?.[0];
  if (!punctuation) return;
  ranges.push(Decoration.mark({
    class: CSS.inlineNoBreak,
    // Include the widget and CM's caret buffers at the starting boundary.
    inclusiveStart: true,
  }).range(node.from, node.to + punctuation.length));
}

function addTableSourceHighlights(
  ranges: Array<ReturnType<Decoration["range"]>>,
  state: EditorState,
  node: SyntaxNode,
  visible: SourceRange,
): void {
  const from = Math.max(node.from, visible.from);
  const to = Math.min(node.to, visible.to);
  if (from >= to) return;
  if (node.kind === "Math") {
    const body = childOfKind(node, "OpaqueBody");
    if (body) addOpaqueSourceHighlights(
      ranges, state, body.from, Math.min(body.to, to), "math", from,
    );
  }
  if (
    node.kind === "TableRow"
    && node.parent?.kind === "TableHead"
    && node.previousSibling()
  ) {
    addSourceToken(ranges, from, to, "tok-punctuation");
    return;
  }
  if (node.childCount === 0 || node.kind === "LinkDestination") {
    const className = sourceHighlightClass(node);
    if (className) addSourceToken(ranges, from, to, className);
    return;
  }
  // Locate the first visible child without walking every preceding table row.
  let low = 0;
  let high = node.childCount;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const child = node.child(middle);
    if (child && child.to <= from) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!child || child.from >= to) break;
    addTableSourceHighlights(ranges, state, child, visible);
  }
}

function buildCstEditDecorations(
  view: EditorView,
  codeDecorations: Map<string, Array<ReturnType<Decoration["range"]>>>,
): {
  readonly decorations: DecorationSet;
  readonly outerDecorations: DecorationSet;
} {
  const state = view.state;
  const tree = getPandocTree(state);
  const active = activeNodeKeys(state, tree);
  const activeDisplayMath = activeDisplayMathKeys(state, tree);
  const activePipeTables = activePipeTableKeys(state, tree);
  const macros = getYamlMathMacros(state);
  const macrosKey = getYamlMathMacrosKey(state);
  const presentation = getDocumentPresentation(state);
  const ranges: Array<ReturnType<Decoration["range"]>> = [];
  const outerDecorations: Array<ReturnType<Decoration["range"]>> = [];
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
      // Attribute quotes may contain the title's inline nodes. Descend into
      // them without presenting syntax that crosses the hidden title boundary.
      if (node.kind !== "FencedDiv" && suppressedFencedDivSourceRanges.some(
        (range) => node.from < range.to && range.from < node.to,
      )) return;
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
        case "AttributeList": {
          const heading = node.parent;
          if (heading?.kind !== "AtxHeading" && heading?.kind !== "SetextHeading") return;
          if (decorated.has(key)) return false;
          decorated.add(key);
          ranges.push(
            active.has(nodeKey(heading))
              ? Decoration.mark({ class: CSS.inlineSource }).range(node.from, node.to)
              : Decoration.replace({}).range(node.from, node.to),
          );
          return false;
        }
        case "PipeTable":
          // The table surface owns the live preview; its editable source stays literal.
          if (activePipeTables.has(key)) {
            addTableSourceHighlights(ranges, state, node, visible);
          }
          return false;
        case "YamlMetadata":
          if (isYamlMetadataActive(state) && !decorated.has(key)) {
            decorated.add(key);
            addOpaqueSourceHighlights(ranges, state, node.from, node.to, "yaml");
          }
          return false;
        case "Math":
          if (decorated.has(key)) return false;
          decorated.add(key);
          if (!isActive && !node.prop(mathDisplay)) {
            addTrailingPunctuationGroup(outerDecorations, node);
          }
          addMathPresentation(
            ranges,
            outerDecorations,
            state,
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
            outerDecorations,
            suppressedFencedDivSourceRanges,
            view,
            node,
            presentation.fencedDivsByFrom.get(node.from),
          );
          return;
        case "Citation":
        case "ExampleReference": {
          if (decorated.has(key)) return false;
          if (!isActive) addTrailingPunctuationGroup(outerDecorations, node);
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
        case "IndentedCodeBlock": {
          if (decorated.has(key)) return false;
          decorated.add(key);
          let codeRanges = codeDecorations.get(key);
          if (!codeRanges) {
            codeRanges = [];
            addCodeBlockPresentation(
              codeRanges,
              state,
              node,
              view.viewport.from,
              view.viewport.to,
            );
            codeDecorations.set(key, codeRanges);
          }
          for (const range of codeRanges) ranges.push(range);
          return false;
        }
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

  return {
    decorations: Decoration.set(ranges, true),
    outerDecorations: Decoration.set(outerDecorations, true),
  };
}

export const cstEditDecorationPlugin = ViewPlugin.fromClass(class {
  presentation: ReturnType<typeof buildCstEditDecorations>;
  readonly codeDecorations = new Map<string, Array<ReturnType<Decoration["range"]>>>();

  constructor(view: EditorView) {
    this.presentation = buildCstEditDecorations(view, this.codeDecorations);
  }

  update(update: ViewUpdate): void {
    const resetCode = update.docChanged || update.viewportChanged
      || update.transactions.some((transaction) => transaction.reconfigured);
    // Tokenization depends on source, viewport, and configuration, never selection.
    if (resetCode) this.codeDecorations.clear();
    if (resetCode || update.selectionSet) {
      this.presentation = buildCstEditDecorations(update.view, this.codeDecorations);
    }
  }
}, {
  decorations: (value) => value.presentation.decorations,
  // Keep source wrappers outside tokens, including equal ranges after edits.
  // Headers and inline punctuation also stay together across widgets and selections.
  provide: (plugin) => EditorView.outerDecorations.of(
    (view) => view.plugin(plugin)?.presentation.outerDecorations ?? Decoration.none,
  ),
});

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
  if (!reference || containingPipeTable(reference)) return false;
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
  if (!math || containingPipeTable(math)) return false;
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
    alignItems: "center",
    appearance: "none",
    backgroundColor: "transparent",
    border: "0",
    borderRadius: "3px",
    color: "color-mix(in srgb, var(--cf-muted) 75%, var(--cf-bg))",
    cursor: "pointer",
    display: "inline-flex",
    fontFamily: "var(--cf-code-font)",
    fontSize: "0.65em",
    gap: "0.45em",
    lineHeight: "1.4",
    minHeight: "24px",
    padding: "2px 4px",
  },
  [`.${CSS.yamlToggle}::before`]: {
    borderBottom: "1px solid currentColor",
    borderRight: "1px solid currentColor",
    content: "\"\"",
    flexShrink: "0",
    height: "0.35em",
    transform: "rotate(-45deg)",
    width: "0.35em",
  },
  [`.${CSS.yamlToggle}[aria-expanded=true]::before`]: {
    transform: "rotate(45deg)",
  },
  [`.${CSS.yamlToggle}:hover, .${CSS.yamlToggle}:focus-visible`]: {
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
    // Keep the smaller source text on the same leading as the line-number gutter.
    lineHeight: "calc(var(--cf-base-font-size) * var(--cf-line-height))",
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
    color: "var(--cf-muted)",
    fontFamily: "var(--cf-code-font)",
    fontSize: "0.86em",
    fontStyle: "normal",
    fontWeight: "400",
  },
  [`.${CSS.fencedDivRange}`]: {
    backgroundColor: "var(--cf-border)",
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
