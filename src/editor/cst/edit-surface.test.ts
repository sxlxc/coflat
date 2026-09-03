import { afterEach, describe, expect, it } from "vitest";

import { CSS } from "../../core/constants/css-classes";
import { createSimpleEditor } from "../simple-editor";

describe("CST edit surface list markers", () => {
  let editor: ReturnType<typeof createSimpleEditor> | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function mount(doc: string): HTMLElement {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = createSimpleEditor({ parent, doc });
    return parent;
  }

  it("renders unordered list source markers as bullet glyphs", () => {
    const doc = "- dash\n+ plus\n* star\n1. ordered";
    const parent = mount(doc);

    expect(
      [...parent.querySelectorAll(`.${CSS.listBullet}`)].map(
        (marker) => marker.textContent,
      ),
    ).toEqual(["•", "•", "•"]);
    expect(editor?.state.doc.toString()).toBe(doc);
  });

  it("updates the rendered marker when the CST list kind changes", () => {
    const parent = mount("- item");
    expect(parent.querySelectorAll(`.${CSS.listBullet}`)).toHaveLength(1);

    editor?.dispatch({ changes: { from: 0, to: 1, insert: "1." } });
    expect(parent.querySelectorAll(`.${CSS.listBullet}`)).toHaveLength(0);
    expect(editor?.state.doc.toString()).toBe("1. item");

    editor?.dispatch({ changes: { from: 0, to: 2, insert: "-" } });
    expect(parent.querySelectorAll(`.${CSS.listBullet}`)).toHaveLength(1);
    expect(editor?.state.doc.toString()).toBe("- item");
  });
});
