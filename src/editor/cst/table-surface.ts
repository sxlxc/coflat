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
  WidgetType,
} from "@codemirror/view";
import {
  tableAlignments,
  tableColumnCount,
  type NodeKind,
  type SyntaxNode,
  type SyntaxTree,
} from "pandocmd-cst";
import { CSS } from "../../core/constants/css-classes";
import {
  createInlineMathSurfaceElement,
  renderInlineMathErrorFallback,
} from "../../core/math-inline-surface";
import {
  createTableCellSurfaceElement,
  createTableRowSurfaceElement,
  createTableSurfaceElement,
  type TableCellAlignment,
} from "../../core/table-surface";
import { renderKatexToHtml } from "../render/katex-render";
import {
  getPandocInvalidations,
  getPandocTree,
} from "./pandoc-cst-field";
import {
  getYamlMathMacros,
  getYamlMathMacrosKey,
} from "./yaml-metadata";

type TableSection = "header" | "body";

interface InlinePlan {
  readonly kind: NodeKind;
  readonly text: string;
  readonly children: readonly InlinePlan[];
}

interface TableCellSlot {
  readonly node: SyntaxNode | null;
  readonly from: number;
  readonly to: number;
}

interface TableCellPlan {
  readonly from: number;
  readonly to: number;
  readonly inline: readonly InlinePlan[];
}

interface TableRowPlan {
  readonly cells: readonly TableCellPlan[];
}

interface TablePlan {
  readonly raw: string;
  readonly sourceFrom: number;
  readonly sourceTo: number;
  readonly cstVersion: number;
  readonly alignments: readonly TableCellAlignment[];
  readonly header: TableRowPlan | null;
  readonly body: readonly TableRowPlan[];
}

interface TableDecorationState {
  readonly mathMacrosKey: string;
  readonly selectionSignature: string;
  readonly decorations: DecorationSet;
}

const SOURCE_MARK_KINDS: ReadonlySet<NodeKind> = new Set([
  "Delimiter",
  "MathMark",
  "CodeMark",
  "BracketMark",
  "ParenMark",
  "AttributeList",
]);

function tableNodeKey(node: Pick<SyntaxNode, "kind" | "from" | "to">): string {
  return `${node.kind}:${node.from}:${node.to}`;
}

function containingPipeTable(node: SyntaxNode | null): SyntaxNode | null {
  let current = node;
  while (current) {
    if (current.kind === "PipeTable") return current;
    current = current.parent;
  }
  return null;
}

function pipeTableAtPosition(
  tree: SyntaxTree,
  position: number,
): SyntaxNode | null {
  for (const bias of ["right", "left"] as const) {
    const table = containingPipeTable(tree.resolve(position, bias));
    if (table) return table;
  }
  return null;
}

/** Pipe tables containing either endpoint of the current selection. */
export function activePipeTableKeys(
  state: EditorState,
  tree: SyntaxTree,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const range of state.selection.ranges) {
    const positions = range.empty ? [range.head] : [range.anchor, range.head];
    for (const position of positions) {
      const table = pipeTableAtPosition(tree, position);
      if (table) keys.add(tableNodeKey(table));
    }
  }
  return keys;
}

function activePipeTableSignature(state: EditorState, tree: SyntaxTree): string {
  return [...activePipeTableKeys(state, tree)].sort().join("|");
}

function selectionCoversRange(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  return state.selection.ranges.some((range) => (
    !range.empty && range.from <= from && range.to >= to
  ));
}

function selectedPipeTableKeys(
  state: EditorState,
  tree: SyntaxTree,
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (state.selection.ranges.every((range) => range.empty)) return keys;
  tree.iterate((node) => {
    if (
      node.kind === "PipeTable"
      && selectionCoversRange(state, node.from, node.to)
    ) keys.add(tableNodeKey(node));
  });
  return keys;
}

function tableSelectionSignature(state: EditorState, tree: SyntaxTree): string {
  const active = activePipeTableSignature(state, tree);
  const selected = [...selectedPipeTableKeys(state, tree)].sort().join("|");
  return `active:${active};selected:${selected}`;
}

function lineContentEnd(row: SyntaxNode): number {
  const last = row.lastChild();
  return last?.kind === "LineEnding" ? last.from : row.to;
}

function isOuterTableWhitespace(node: SyntaxNode): boolean {
  return node.kind === "Whitespace" || node.kind === "LineEnding";
}

/**
 * Recover column slots from CST delimiter nodes. Empty cells have no zero-width
 * CST node, so their slot is represented by the adjacent delimiter positions.
 */
function rowCellSlots(row: SyntaxNode): readonly TableCellSlot[] {
  const children = [...row.children()];
  const delimiterIndexes: number[] = [];
  for (let index = 0; index < children.length; index += 1) {
    if (children[index]?.kind === "TableDelimiter") delimiterIndexes.push(index);
  }
  if (delimiterIndexes.length === 0) {
    return children
      .filter((child) => child.kind === "TableCell")
      .map((node) => ({ node, from: node.from, to: node.to }));
  }

  const firstIndex = delimiterIndexes[0];
  const lastIndex = delimiterIndexes.at(-1);
  if (firstIndex === undefined || lastIndex === undefined) return [];
  const delimiters = delimiterIndexes.map((index) => children[index]).filter(
    (node): node is SyntaxNode => node !== undefined,
  );
  const leading = children.slice(0, firstIndex).every(isOuterTableWhitespace);
  const trailing = children.slice(lastIndex + 1).every(isOuterTableWhitespace);
  const contentEnd = lineContentEnd(row);
  const intervals: Array<{ readonly from: number; readonly to: number }> = [];

  if (!leading) intervals.push({ from: row.from, to: delimiters[0]?.from ?? row.from });
  for (let index = 0; index + 1 < delimiters.length; index += 1) {
    const left = delimiters[index];
    const right = delimiters[index + 1];
    if (left && right) intervals.push({ from: left.to, to: right.from });
  }
  if (!trailing) {
    const last = delimiters.at(-1);
    if (last) intervals.push({ from: last.to, to: contentEnd });
  }

  const cells = children.filter((child) => child.kind === "TableCell");
  return intervals.map((interval) => ({
    ...interval,
    node: cells.find((cell) => (
      cell.from >= interval.from && cell.to <= interval.to
    )) ?? null,
  }));
}

function inlinePlan(node: SyntaxNode): InlinePlan {
  return Object.freeze({
    kind: node.kind,
    text: node.text(),
    children: Object.freeze([...node.children()].map(inlinePlan)),
  });
}

function cellInlinePlans(cell: SyntaxNode | null): readonly InlinePlan[] {
  if (!cell) return Object.freeze([]);
  const children = [...cell.children()];
  let from = 0;
  let to = children.length;
  while (from < to && children[from]?.kind === "Space") from += 1;
  while (to > from && children[to - 1]?.kind === "Space") to -= 1;
  return Object.freeze(children.slice(from, to).map(inlinePlan));
}

function normalizedSlots(
  row: SyntaxNode,
  columns: number,
): readonly TableCellSlot[] {
  const slots = [...rowCellSlots(row)].slice(0, columns);
  const fallback = lineContentEnd(row);
  while (slots.length < columns) {
    slots.push({ node: null, from: fallback, to: fallback });
  }
  return slots;
}

function rowPlan(row: SyntaxNode, columns: number): TableRowPlan {
  return Object.freeze({
    cells: Object.freeze(normalizedSlots(row, columns).map((slot) => Object.freeze({
      from: slot.node?.from ?? slot.from,
      to: slot.node?.to ?? slot.to,
      inline: cellInlinePlans(slot.node),
    }))),
  });
}

function sectionRows(table: SyntaxNode, kind: "TableHead" | "TableBody"): SyntaxNode[] {
  const section = [...table.children()].find((child) => child.kind === kind);
  return section
    ? [...section.children()].filter((child) => child.kind === "TableRow")
    : [];
}

function buildTablePlan(table: SyntaxNode, tree: SyntaxTree): TablePlan {
  const headRows = sectionRows(table, "TableHead");
  const bodyRows = sectionRows(table, "TableBody");
  const inferredColumns = headRows[0] ? rowCellSlots(headRows[0]).length : 0;
  const columns = Math.max(1, table.prop(tableColumnCount) ?? inferredColumns);
  const sourceAlignments = table.prop(tableAlignments) ?? [];
  const alignments = Object.freeze(Array.from(
    { length: columns },
    (_, index) => sourceAlignments[index] ?? "default",
  ));

  return Object.freeze({
    raw: table.text(),
    sourceFrom: table.from,
    sourceTo: table.to,
    cstVersion: tree.version,
    alignments,
    header: headRows[0] && [...headRows[0].children()].some((child) => (
      child.kind === "TableCell" && child.text().trim().length > 0
    ))
      ? rowPlan(headRows[0], columns)
      : null,
    body: Object.freeze(bodyRows.map((row) => rowPlan(row, columns))),
  });
}

function appendText(parent: Node, ownerDocument: Document, text: string): void {
  if (text) parent.appendChild(ownerDocument.createTextNode(text));
}

function inlineBody(plan: InlinePlan): string {
  return plan.children.find((child) => child.kind === "OpaqueBody")?.text ?? "";
}

function appendPlanChildren(
  parent: Node,
  ownerDocument: Document,
  children: readonly InlinePlan[],
  macros: Readonly<Record<string, string>>,
): void {
  for (const child of children) {
    appendInlinePlan(parent, ownerDocument, child, macros);
  }
}

function appendDelimitedChildren(
  parent: Node,
  ownerDocument: Document,
  plan: InlinePlan,
  macros: Readonly<Record<string, string>>,
): void {
  appendPlanChildren(
    parent,
    ownerDocument,
    plan.children.filter((child) => !SOURCE_MARK_KINDS.has(child.kind)),
    macros,
  );
}

function appendLinkLabel(
  parent: Node,
  ownerDocument: Document,
  plan: InlinePlan,
  macros: Readonly<Record<string, string>>,
): void {
  if (plan.kind === "AutoLink") {
    appendPlanChildren(
      parent,
      ownerDocument,
      plan.children.filter((child) => child.kind === "Text"),
      macros,
    );
    return;
  }

  let insideLabel = false;
  let appended = false;
  for (const child of plan.children) {
    if (child.kind === "BracketMark") {
      if (!insideLabel) {
        insideLabel = true;
        continue;
      }
      break;
    }
    if (!insideLabel || child.kind === "Delimiter") continue;
    appendInlinePlan(parent, ownerDocument, child, macros);
    appended = true;
  }
  if (!appended) appendText(parent, ownerDocument, plan.text);
}

function decodedEntity(ownerDocument: Document, source: string): string {
  const decoder = ownerDocument.createElement("textarea");
  decoder.innerHTML = source;
  return decoder.value;
}

function appendInlinePlan(
  parent: Node,
  ownerDocument: Document,
  plan: InlinePlan,
  macros: Readonly<Record<string, string>>,
): void {
  switch (plan.kind) {
    case "Strong":
    case "Emphasis":
    case "Strikeout":
    case "Superscript":
    case "Subscript":
    case "Quoted": {
      const tag = {
        Strong: "strong",
        Emphasis: "em",
        Strikeout: "del",
        Superscript: "sup",
        Subscript: "sub",
        Quoted: "q",
      }[plan.kind];
      const element = ownerDocument.createElement(tag);
      appendDelimitedChildren(element, ownerDocument, plan, macros);
      parent.appendChild(element);
      return;
    }
    case "Code": {
      const code = ownerDocument.createElement("code");
      code.className = CSS.inlineCode;
      code.textContent = inlineBody(plan);
      parent.appendChild(code);
      return;
    }
    case "Math": {
      const latex = inlineBody(plan);
      const math = createInlineMathSurfaceElement(ownerDocument, latex);
      try {
        const html = renderKatexToHtml(latex, false, macros, "html", false);
        if (html.includes("katex-error")) throw new Error("KaTeX could not parse this expression");
        math.innerHTML = html;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "KaTeX could not parse this expression";
        renderInlineMathErrorFallback(math, `$${latex}$`, `KaTeX error: ${message}`);
      }
      parent.appendChild(math);
      return;
    }
    case "Link":
    case "AutoLink":
    case "ReferenceCandidate":
    case "Image":
    case "ImageReferenceCandidate": {
      const link = ownerDocument.createElement("span");
      link.className = CSS.linkRendered;
      appendLinkLabel(link, ownerDocument, plan, macros);
      parent.appendChild(link);
      return;
    }
    case "Escape":
      appendText(parent, ownerDocument, plan.text.slice(1));
      return;
    case "Entity":
      appendText(parent, ownerDocument, decodedEntity(ownerDocument, plan.text));
      return;
    case "LineBreak":
      parent.appendChild(ownerDocument.createElement("br"));
      return;
    case "SoftBreak":
      appendText(parent, ownerDocument, " ");
      return;
    case "RawInline":
      if (/^<br\s*\/?\s*>$/i.test(plan.text)) {
        parent.appendChild(ownerDocument.createElement("br"));
      } else appendText(parent, ownerDocument, plan.text);
      return;
    case "NativeHtmlSpan":
      appendPlanChildren(
        parent,
        ownerDocument,
        plan.children.filter((child) => child.kind !== "HtmlTag"),
        macros,
      );
      return;
    case "Delimiter":
    case "MathMark":
    case "CodeMark":
    case "BracketMark":
    case "ParenMark":
    case "AttributeList":
      return;
    default:
      if (plan.children.length > 0) {
        appendPlanChildren(parent, ownerDocument, plan.children, macros);
      }
      else appendText(parent, ownerDocument, plan.text);
  }
}

function visiblePlanText(
  plans: readonly InlinePlan[],
  ownerDocument: Document,
  macros: Readonly<Record<string, string>>,
): string {
  const container = ownerDocument.createElement("span");
  appendPlanChildren(container, ownerDocument, plans, macros);
  return container.textContent ?? "";
}

function appendTableRow(
  parent: HTMLTableSectionElement,
  rowPlanValue: TableRowPlan,
  section: TableSection,
  rowIndex: number,
  alignments: readonly TableCellAlignment[],
  ownerDocument: Document,
  macros: Readonly<Record<string, string>>,
): void {
  const row = createTableRowSurfaceElement(ownerDocument);
  for (let column = 0; column < rowPlanValue.cells.length; column += 1) {
    const plan = rowPlanValue.cells[column];
    if (!plan) continue;
    const cell = createTableCellSurfaceElement(
      ownerDocument,
      section === "header",
      alignments[column],
    );
    cell.dataset.cstTableCell = "true";
    cell.dataset.section = section;
    cell.dataset.row = String(rowIndex);
    cell.dataset.column = String(column);
    cell.dataset.sourceFrom = String(plan.from);
    cell.dataset.sourceTo = String(plan.to);
    appendPlanChildren(cell, ownerDocument, plan.inline, macros);
    row.appendChild(cell);
  }
  parent.appendChild(row);
}

function tableAriaLabel(
  plan: TablePlan,
  ownerDocument: Document,
  macros: Readonly<Record<string, string>>,
): string {
  const heading = plan.header
    ? plan.header.cells
      .map((cell) => visiblePlanText(cell.inline, ownerDocument, macros).trim())
      .join(", ")
    : "";
  return heading ? `Table: ${heading}` : "Table";
}

function trimSourceBounds(
  state: EditorState,
  from: number,
  to: number,
): { readonly from: number; readonly to: number } {
  const source = state.sliceDoc(from, to);
  const leading = /^\s*/.exec(source)?.[0].length ?? 0;
  const trailing = /\s*$/.exec(source)?.[0].length ?? 0;
  const contentFrom = Math.min(to, from + leading);
  return {
    from: contentFrom,
    to: Math.max(contentFrom, to - trailing),
  };
}

function currentCellSlot(
  table: SyntaxNode,
  section: TableSection,
  rowIndex: number,
  column: number,
): TableCellSlot | null {
  const rows = sectionRows(table, section === "header" ? "TableHead" : "TableBody");
  const row = section === "header" ? rows[0] : rows[rowIndex];
  if (!row) return null;
  const columns = Math.max(1, table.prop(tableColumnCount) ?? rowCellSlots(row).length);
  return normalizedSlots(row, columns)[column] ?? null;
}

function tableCellSourcePosition(
  view: EditorView,
  table: SyntaxNode,
  cell: HTMLElement | null,
): number {
  if (!cell) {
    const firstRow = sectionRows(table, "TableHead")[0]
      ?? sectionRows(table, "TableBody")[0];
    const firstSlot = firstRow ? rowCellSlots(firstRow)[0] : null;
    return firstSlot?.node?.from ?? firstSlot?.from ?? table.from;
  }

  const section = cell.dataset.section === "body" ? "body" : "header";
  const row = Number.parseInt(cell.dataset.row ?? "0", 10);
  const column = Number.parseInt(cell.dataset.column ?? "0", 10);
  const slot = currentCellSlot(table, section, row, column);
  if (!slot) return table.from;
  return trimSourceBounds(
    view.state,
    slot.node?.from ?? slot.from,
    slot.node?.to ?? slot.to,
  ).from;
}

function resolveWidgetTable(
  view: EditorView,
  surface: HTMLElement,
  plan: TablePlan,
): SyntaxNode | null {
  const tree = getPandocTree(view.state);
  const positions: number[] = [];
  try {
    positions.push(view.posAtDOM(surface));
  } catch (_error) {
    // A mapped widget can briefly outlive its DOM position during redraw.
  }
  positions.push(plan.sourceFrom, plan.sourceTo);

  for (const position of positions) {
    if (position < 0 || position > tree.length) continue;
    const direct = pipeTableAtPosition(tree, position);
    if (direct) return direct;
    const searchFrom = Math.max(0, Math.min(tree.length, position) - 1);
    const searchTo = Math.min(tree.length, Math.max(searchFrom + 1, position + 1));
    let nearby: SyntaxNode | null = null;
    tree.iterate((node) => {
      if (!nearby && node.kind === "PipeTable" && node.text() === plan.raw) {
        nearby = node;
        return false;
      }
      return;
    }, { from: searchFrom, to: searchTo });
    if (nearby) return nearby;
  }
  return null;
}

class CstTableWidget extends WidgetType {
  constructor(
    private readonly plan: TablePlan,
    private readonly preview: boolean,
    private readonly selected: boolean,
    private readonly macros: Readonly<Record<string, string>>,
    private readonly macrosKey: string,
  ) {
    super();
  }

  eq(other: CstTableWidget): boolean {
    return other.plan.raw === this.plan.raw
      && other.preview === this.preview
      && other.selected === this.selected
      && other.macrosKey === this.macrosKey;
  }

  toDOM(view: EditorView): HTMLElement {
    const ownerDocument = view.dom.ownerDocument;
    const surface = ownerDocument.createElement("div");
    surface.className = `cf-cst-table${this.preview ? " cf-cst-table-preview" : ""}`;
    if (this.selected) surface.classList.add(CSS.selectionRange);
    surface.dataset.cstVersion = String(this.plan.cstVersion);
    surface.dataset.cstNode = "PipeTable";
    surface.dataset.sourceFrom = String(this.plan.sourceFrom);
    surface.dataset.sourceTo = String(this.plan.sourceTo);
    surface.title = "Edit table";

    const table = createTableSurfaceElement(ownerDocument);
    table.setAttribute(
      "aria-label",
      tableAriaLabel(this.plan, ownerDocument, this.macros),
    );
    if (this.plan.header) {
      const head = ownerDocument.createElement("thead");
      appendTableRow(
        head,
        this.plan.header,
        "header",
        0,
        this.plan.alignments,
        ownerDocument,
        this.macros,
      );
      table.appendChild(head);
    }
    if (this.plan.body.length > 0) {
      const body = ownerDocument.createElement("tbody");
      for (let row = 0; row < this.plan.body.length; row += 1) {
        const bodyRow = this.plan.body[row];
        if (bodyRow) appendTableRow(
          body,
          bodyRow,
          "body",
          row,
          this.plan.alignments,
          ownerDocument,
          this.macros,
        );
      }
      table.appendChild(body);
    }
    surface.appendChild(table);

    surface.addEventListener("mousedown", (event) => {
      if (
        event.button !== 0
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
      ) return;
      const current = resolveWidgetTable(view, surface, this.plan);
      if (!current) return;
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-cst-table-cell]")
        : null;
      const anchor = tableCellSourcePosition(view, current, target);
      event.preventDefault();
      event.stopPropagation();
      view.focus();
      view.dispatch({
        selection: EditorSelection.cursor(anchor),
        scrollIntoView: true,
        userEvent: "select.pointer",
      });
    });
    return surface;
  }

  ignoreEvent(): boolean {
    return true;
  }

  get estimatedHeight(): number {
    return 42 + this.plan.body.length * 34;
  }
}

function buildTableDecorationState(state: EditorState): TableDecorationState {
  const tree = getPandocTree(state);
  const active = activePipeTableKeys(state, tree);
  const selected = selectedPipeTableKeys(state, tree);
  const macros = getYamlMathMacros(state);
  const macrosKey = getYamlMathMacrosKey(state);
  const ranges: Array<ReturnType<Decoration["range"]>> = [];

  tree.iterate((node) => {
    if (node.kind !== "PipeTable") return;
    const isActive = active.has(tableNodeKey(node));
    const widget = new CstTableWidget(
      buildTablePlan(node, tree),
      isActive,
      !isActive && selected.has(tableNodeKey(node)),
      macros,
      macrosKey,
    );
    if (isActive) {
      const firstLine = state.doc.lineAt(node.from).number;
      const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
      for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
        ranges.push(Decoration.line({
          attributes: { class: CSS.tableSource },
        }).range(state.doc.line(lineNumber).from));
      }
    }
    ranges.push(
      isActive
        ? Decoration.widget({ widget, block: true, side: -1 }).range(node.from)
        : Decoration.replace({ widget, block: true }).range(node.from, node.to),
    );
    return false;
  });

  return {
    mathMacrosKey: macrosKey,
    selectionSignature: tableSelectionSignature(state, tree),
    decorations: Decoration.set(ranges, true),
  };
}

function rangeTouchesPipeTable(
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
    if (node.kind === "PipeTable") {
      found = true;
      return false;
    }
    return;
  }, { from: searchFrom, to: searchTo });
  return found;
}

function transactionTouchesPipeTable(transaction: Transaction): boolean {
  const before = getPandocTree(transaction.startState);
  const after = getPandocTree(transaction.state);
  const invalidations = getPandocInvalidations(transaction.state).changedRanges;
  if (invalidations.length === 0) return true;
  return invalidations.some((range) => (
    rangeTouchesPipeTable(before, range.oldFrom, range.oldTo)
    || rangeTouchesPipeTable(after, range.newFrom, range.newTo)
  ));
}

/** Block replacements must be supplied by a state field because they cross lines. */
export const cstTableDecorationField = StateField.define<TableDecorationState>({
  create(state) {
    return buildTableDecorationState(state);
  },

  update(value, transaction) {
    const tree = getPandocTree(transaction.state);
    const selectionSignature = tableSelectionSignature(transaction.state, tree);
    const macrosKey = getYamlMathMacrosKey(transaction.state);
    if (macrosKey !== value.mathMacrosKey) {
      return buildTableDecorationState(transaction.state);
    }
    if (!transaction.docChanged) {
      return selectionSignature === value.selectionSignature
        ? value
        : buildTableDecorationState(transaction.state);
    }
    if (
      selectionSignature === value.selectionSignature
      && !transactionTouchesPipeTable(transaction)
    ) {
      return {
        mathMacrosKey: macrosKey,
        selectionSignature,
        decorations: value.decorations.map(transaction.changes),
      };
    }
    return buildTableDecorationState(transaction.state);
  },

  provide(field) {
    return EditorView.decorations.from(field, (value) => value.decorations);
  },
});

function boundaryTableAnchor(
  state: EditorState,
  table: SyntaxNode,
  direction: "left" | "right",
): number {
  const rows = [
    ...sectionRows(table, "TableHead").slice(0, 1),
    ...sectionRows(table, "TableBody"),
  ];
  const row = direction === "right" ? rows[0] : rows.at(-1);
  const slots = row ? rowCellSlots(row) : [];
  const slot = direction === "right" ? slots[0] : slots.at(-1);
  if (!slot) return direction === "right" ? table.from : table.to;
  const bounds = trimSourceBounds(
    state,
    slot.node?.from ?? slot.from,
    slot.node?.to ?? slot.to,
  );
  return direction === "right" ? bounds.from : bounds.to;
}

function enterRenderedTable(
  view: EditorView,
  direction: "left" | "right",
): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const tree = getPandocTree(view.state);
  const table = containingPipeTable(tree.resolve(selection.head, direction));
  if (!table) return false;
  if (direction === "right" && table.from !== selection.head) return false;
  if (direction === "left" && table.to !== selection.head) return false;
  view.dispatch({
    selection: EditorSelection.cursor(
      boundaryTableAnchor(view.state, table, direction),
    ),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

export const cstTableKeyboardNavigation: Extension = keymap.of([
  {
    key: "ArrowRight",
    run: (view) => enterRenderedTable(view, "right"),
  },
  {
    key: "ArrowLeft",
    run: (view) => enterRenderedTable(view, "left"),
  },
]);

export const cstTableTheme: Extension = EditorView.theme({
  ".cf-cst-table": {
    boxSizing: "border-box",
    cursor: "pointer",
    maxWidth: "100%",
    overflowX: "auto",
    // CM6's block-widget height map does not include vertical margins.
    paddingBlock: "0.55em",
    width: "100%",
  },
  ".cf-cst-table:hover": {
    outline: "1px solid var(--cf-border)",
    outlineOffset: "2px",
  },
});

export const cstTableSurface: Extension = [
  cstTableDecorationField,
  cstTableKeyboardNavigation,
  cstTableTheme,
];
