import { cursorCharLeft, cursorCharRight, undo } from "@codemirror/commands";
import { afterEach, describe, expect, it } from "vitest";
import { createSimpleEditor } from "../simple-editor";
import { getPandocTree, getPandocCstUpdateCountForTesting } from "./pandoc-cst-field";

const imageSource = "![A dashed line of slope three and a left-continuous staircase, with filled lower endpoints and open upper endpoints at each jump.](assets/k3-exponent-comparison-7bj06n1r.png){width=100%}";

describe("standalone image previews", () => {
  let editor: ReturnType<typeof createSimpleEditor>;
  let parent: HTMLElement;
  function mount(doc: string): void {
    parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = createSimpleEditor({ parent, doc });
  }
  afterEach(() => { editor?.destroy(); parent?.remove(); });

  it("renders the supplied image and reveals literal source below on click", () => {
    const doc = `Before.\n\n${imageSource}\n\nAfter.`;
    mount(doc);
    const image = parent.querySelector("img");
    expect(image?.getAttribute("src")).toBe("assets/k3-exponent-comparison-7bj06n1r.png");
    expect(image?.style.width).toBe("100%");
    expect(image?.alt).toContain("A dashed line of slope three");
    expect(parent.querySelector(".cf-image-source")).toBeNull();
    image?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(editor.state.selection.main.head).toBe(doc.indexOf("!["));
    expect(parent.querySelector(".cf-image-source")?.textContent).toBe(imageSource);
    expect(parent.querySelector(".cf-image-preview")?.compareDocumentPosition(parent.querySelector(".cf-image-source") as Node))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(editor.state.doc.toString()).toBe(doc);
    expect(getPandocTree(editor.state).text).toBe(doc);
    expect(getPandocCstUpdateCountForTesting(editor.state)).toBe(0);
  });

  it("enters from both directions by keyboard, edits live, and undoes", () => {
    const source = "![中文 😀 *literal* $k$](one.png){width=100%}";
    const doc = `Before.\n\n${source}\n\nAfter.`;
    mount(doc);
    const from = doc.indexOf("![");
    for (const [position, command] of [[from - 1, cursorCharRight], [from + source.length + 1, cursorCharLeft]] as const) {
      editor.dispatch({ selection: { anchor: position } });
      const tree = getPandocTree(editor.state);
      command(editor);
      expect(parent.querySelector(".cf-image-source")?.textContent).toBe(source);
      expect(parent.querySelector(".cf-image-source .katex")).toBeNull();
      expect(getPandocTree(editor.state)).toBe(tree);
    }
    const start = doc.indexOf("one.png");
    editor.dispatch({ changes: { from: start, to: start + 7, insert: "two.png" }, selection: { anchor: start } });
    expect(parent.querySelector("img")?.getAttribute("src")).toBe("two.png");
    expect(getPandocTree(editor.state).text).toBe(editor.state.doc.toString());
    expect(getPandocCstUpdateCountForTesting(editor.state)).toBe(1);
    undo(editor);
    expect(editor.state.doc.toString()).toBe(doc);
    expect(parent.querySelector("img")?.getAttribute("src")).toBe("one.png");
    editor.dispatch({ selection: { anchor: 0 } });
    expect(parent.querySelector(".cf-image-source")).toBeNull();
  });

  it("keeps image source visibility fixed while extending selections", () => {
    const doc = `Before 中文 😀.\n\n${imageSource}\n\nAfter.`;
    mount(doc);
    const tree = getPandocTree(editor.state);
    const from = doc.indexOf("![");
    for (const anchor of [0, doc.length]) {
      editor.dispatch({ selection: { anchor } });
      const image = parent.querySelector("img");
      for (const head of [from, from + 10, from + imageSource.length, doc.length - anchor]) {
        editor.dispatch({ selection: { anchor, head } });
        expect(parent.querySelector(".cf-image-source")).toBeNull();
        expect(parent.querySelector(".cf-image-preview")?.classList.contains("cf-selection-range"))
          .toBe(Math.min(anchor, head) <= from && Math.max(anchor, head) >= from + imageSource.length);
        expect(parent.querySelector("img"), `Image changed for selection ${anchor}..${head}`).toBe(image);
      }
      editor.dispatch({ selection: { anchor: from + 10, head: anchor } });
      expect(parent.querySelector(".cf-image-source")?.textContent).toBe(imageSource);
      expect(parent.querySelector(".cf-image-preview.cf-selection-range")).toBeNull();
      expect(getPandocTree(editor.state)).toBe(tree);
      expect(editor.state.doc.toString()).toBe(doc);
    }
  });

  it.each(["![Alt](<assets/a b.png>){width=120 height='80'}", "![Alt][pic]\n\n[pic]: <assets/a b.png>"])("uses CST destinations and attributes: %s", (source) => {
    mount(`Before\r\n\r\n${source}\r\n\r\nAfter`);
    expect(parent.querySelector("img")?.getAttribute("src")).toBe("assets/a b.png");
    if (source.includes("width")) {
      expect(parent.querySelector("img")?.style.width).toBe("120px");
      expect(parent.querySelector("img")?.style.height).toBe("80px");
    }
  });

  it.each([
    ["a\\(1\\).png", "a(1).png"],
    ["a&amp;b.png", "a&b.png"],
    ["a&#40;1&#x29;.png", "a(1).png"],
    ["a\\&amp;b.png", "a&amp;b.png"],
    ["a&b&unknown;.png", "a&b&unknown;.png"],
  ])("decodes destination escapes once: %s", (destination, expected) => {
    const doc = `Before.\n\n![Bare](${destination})\n\n![Angle](<${destination}>)\n\n![Reference][pic]\n\n[pic]: <${destination}>`;
    mount(doc);
    expect([...parent.querySelectorAll("img")].map((image) => image.getAttribute("src")))
      .toEqual([expected, expected, expected]);
    expect(editor.state.doc.toString()).toBe(doc);
    expect(getPandocTree(editor.state).text).toBe(doc);
  });

  it.each([
    "![Alt]()",
    "![Alt](javascript:alert(1))",
    "![Alt](jav&#x61;script:alert(1))",
    "![Alt](javascript\\:alert(1))",
    "![Alt][pic]\n\n[pic]: javascript&#58;alert(1)",
  ])("keeps invalid image sources editable: %s", (source) => {
    mount(`Before\n\n${source}`);
    expect(parent.querySelector("img")?.getAttribute("src")).toBeNull();
    editor.dispatch({ selection: { anchor: editor.state.doc.toString().indexOf("![") } });
    expect(parent.querySelector(".cf-image-source")?.textContent).toBe(source.split("\n")[0]);
  });
});
