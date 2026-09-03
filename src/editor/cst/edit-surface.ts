import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
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
import { getPandocTree } from "./pandoc-cst-field";

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
  ) {
    super();
  }

  eq(other: CstMathWidget): boolean {
    return other.latex === this.latex
      && other.raw === this.raw
      && other.isDisplay === this.isDisplay
      && other.preview === this.preview;
  }

  toDOM(view: EditorView): HTMLElement {
    const ownerDocument = view.dom.ownerDocument;
    if (this.isDisplay) {
      const surface = createDisplayMathSurfaceElement(ownerDocument, this.latex);
      const content = createDisplayMathContentElement(ownerDocument);
      if (this.preview) surface.classList.add("cf-cst-math-preview");
      renderMath(content, this.latex, true);
      surface.appendChild(content);
      return surface;
    }

    const surface = createInlineMathSurfaceElement(ownerDocument, this.latex);
    if (this.preview) surface.classList.add("cf-cst-math-preview");
    renderMath(surface, this.latex, false);
    return surface;
  }

  ignoreEvent(): boolean {
    return true;
  }
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
      class: `${CSS.headingLine(level)} cf-doc-heading`,
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

  // Multiline/display math remains literal source. Replacing line breaks with
  // a viewport plugin would violate CM6's decoration contract, and a global
  // block-widget field would make every keystroke scale with document size.
  if (display) {
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
      widget: new CstMathWidget(latex, node.text(), false, false),
    }).range(node.from, node.to));
    return true;
  }

  for (const child of node.children()) {
    const className = child.kind === "MathMark" ? CSS.sourceDelimiter : CSS.mathSource;
    ranges.push(Decoration.mark({ class: className }).range(child.from, child.to));
  }
  ranges.push(Decoration.widget({
    side: 1,
    widget: new CstMathWidget(latex, node.text(), false, true),
  }).range(node.to));
  return true;
}

function buildCstEditDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const tree = getPandocTree(state);
  const active = activeNodeKeys(state, tree);
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

      switch (node.kind) {
        case "Math":
          if (decorated.has(key)) return false;
          decorated.add(key);
          addMathPresentation(ranges, node, isActive);
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
  ".cm-line.cf-cst-code-block": {
    fontFamily: "var(--cf-code-font, Monaco, 'DejaVu Sans Mono', Consolas, monospace)",
    fontSize: "0.88em",
    whiteSpace: "pre-wrap",
  },
  ".cf-cst-math-preview": {
    background: "var(--cf-bg)",
    border: "1px solid var(--cf-border)",
    display: "inline-block",
    marginInlineStart: "0.45em",
    padding: "0.15em 0.4em",
    verticalAlign: "middle",
  },
  ".cf-math-display.cf-cst-math-preview": {
    display: "block",
    marginBlock: "0.35em",
    marginInline: "auto",
    width: "fit-content",
  },
});

export const cstEditSurface: Extension = [
  cstEditDecorationPlugin,
  cstMathKeyboardNavigation,
  cstEditTheme,
];
