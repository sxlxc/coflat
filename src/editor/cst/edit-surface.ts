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
  headingLevel,
  mathDisplay,
  type NodeKind,
  type SyntaxNode,
  type SyntaxTree,
} from "pandocmd-cst";
import { CSS } from "../../core/constants/css-classes";
import {
  createDisplayMathContentElement,
  createDisplayMathSurfaceElement,
} from "../../core/math-display-surface";
import {
  createInlineMathSurfaceElement,
  renderInlineMathErrorFallback,
} from "../../core/math-inline-surface";
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
    case "QuoteMark":
    case "BracketMark":
    case "ParenMark":
    case "TableDelimiter":
      return "tok-punctuation";
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
  ) {
    super();
  }

  eq(other: CstMathWidget): boolean {
    return other.latex === this.latex
      && other.raw === this.raw
      && other.isDisplay === this.isDisplay
      && other.preview === this.preview;
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
  readonly activeSignature: string;
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

function buildDisplayMathDecorationState(
  state: EditorState,
): DisplayMathDecorationState {
  const tree = getPandocTree(state);
  const active = activeDisplayMathKeys(state, tree);
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
    activeSignature: activeDisplayMathSignature(state, tree),
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
      const activeSignature = activeDisplayMathSignature(transaction.state, tree);
      if (!transaction.docChanged) {
        return activeSignature === value.activeSignature
          ? value
          : buildDisplayMathDecorationState(transaction.state);
      }

      if (
        activeSignature === value.activeSignature
        && !transactionTouchesDisplayMath(transaction)
      ) {
        return {
          activeSignature,
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

  for (const visible of view.visibleRanges) {
    tree.iterate((node) => {
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
  cstDisplayMathDecorationField,
  cstTableSurface,
  cstEditDecorationPlugin,
  cstMathKeyboardNavigation,
  cstEditTheme,
];
