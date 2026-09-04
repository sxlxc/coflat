import {
  DOCUMENT_SURFACE_CLASS,
  documentSurfaceClassNames,
} from "./document-surface-classes";

export type TableCellAlignment = "left" | "center" | "right" | "default";

export function normalizeTableCellAlignment(
  alignment: string | null | undefined,
): Exclude<TableCellAlignment, "default"> | null {
  return alignment === "left" || alignment === "center" || alignment === "right"
    ? alignment
    : null;
}

export function createTableSurfaceElement(
  ownerDocument: Document,
): HTMLTableElement {
  const table = ownerDocument.createElement("table");
  table.className = DOCUMENT_SURFACE_CLASS.tableBlock;
  return table;
}

export function createTableRowSurfaceElement(
  ownerDocument: Document,
): HTMLTableRowElement {
  const row = ownerDocument.createElement("tr");
  row.className = DOCUMENT_SURFACE_CLASS.tableRow;
  return row;
}

export function createTableCellSurfaceElement(
  ownerDocument: Document,
  header: boolean,
  alignment: string | null | undefined,
): HTMLTableCellElement {
  const cell = ownerDocument.createElement(header ? "th" : "td");
  cell.className = documentSurfaceClassNames(
    DOCUMENT_SURFACE_CLASS.tableCell,
    header && DOCUMENT_SURFACE_CLASS.tableHeader,
  );
  const normalized = normalizeTableCellAlignment(alignment);
  if (normalized) {
    cell.dataset.align = normalized;
    cell.style.textAlign = normalized;
  }
  return cell;
}
