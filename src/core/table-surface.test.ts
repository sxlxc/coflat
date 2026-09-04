import { describe, expect, it } from "vitest";
import {
  createTableCellSurfaceElement,
  createTableRowSurfaceElement,
  createTableSurfaceElement,
  normalizeTableCellAlignment,
} from "./table-surface";

describe("table surface", () => {
  it("creates semantic table elements with the shared surface classes", () => {
    const table = createTableSurfaceElement(document);
    const row = createTableRowSurfaceElement(document);
    const header = createTableCellSurfaceElement(document, true, "right");
    row.appendChild(header);
    table.appendChild(row);

    expect(table.className).toBe("cf-doc-table-block");
    expect(row.className).toBe("cf-doc-table-row");
    expect(header.className).toBe("cf-doc-table-cell cf-doc-table-header");
    expect(header.dataset.align).toBe("right");
    expect(header.style.textAlign).toBe("right");
  });

  it("ignores the default alignment", () => {
    const cell = createTableCellSurfaceElement(document, false, "default");

    expect(normalizeTableCellAlignment("default")).toBeNull();
    expect(cell.className).toBe("cf-doc-table-cell");
    expect(cell.dataset.align).toBeUndefined();
    expect(cell.style.textAlign).toBe("");
  });
});
