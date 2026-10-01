import { afterEach, describe, expect, it } from "vitest";
import { createSimpleEditor } from "../simple-editor";
import { getPandocTree } from "./pandoc-cst-field";

const views: ReturnType<typeof createSimpleEditor>[] = [];
afterEach(() => { for (const view of views.splice(0)) view.destroy(); document.body.replaceChildren(); });
function mount(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = createSimpleEditor({ parent, doc });
  views.push(view);
  view.dispatch({ selection: { anchor: doc.length } });
  return view;
}
function click(target: Element, altKey: boolean) {
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, altKey });
  target.dispatchEvent(down);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true, altKey });
  target.dispatchEvent(click);
  return { down, click };
}
describe("link navigation", () => {
  it.each([
    ["[jump](#destination)", "# Destination", "# Destination"],
    ["[jump](#custom)", "# Title {#custom}", "# Title"],
    ["[Destination]", "# Destination", "# Destination"],
    ["[jump][target]", "[target]: #destination\n\n# Destination", "# Destination"],
    ["[@thm:result]", "::: {#thm:result .theorem}\nA result.\n:::", ":::"],
    ["[jump](#%E4%B8%AD%E6%96%87)", "# 中文", "# 中文"],
  ])("follows %s without changing source or reparsing", (link, target, marker) => {
    const doc = `Before.\n\n${link}\n\n${target}\n\nAfter.`;
    const view = mount(doc);
    const tree = getPandocTree(view.state);
    const anchor = view.dom.querySelector("a[href]");
    expect(anchor).not.toBeNull();
    if (!anchor) return;
    const events = click(anchor, true);
    expect(events.down.defaultPrevented).toBe(true);
    expect(events.click.defaultPrevented).toBe(true);
    expect(view.state.selection.main.head).toBe(doc.indexOf(marker));
    expect(view.state.doc.toString()).toBe(doc);
    expect(getPandocTree(view.state)).toBe(tree);
  });

  it("lets the host follow an external link only on Option-click", () => {
    const doc = "Before.\n\n[web](https://example.org) and <person@example.org>\n\nAfter.";
    const view = mount(doc);
    expect(view.dom.querySelector('a[href="mailto:person@example.org"]')).not.toBeNull();
    const anchor = view.dom.querySelector('a[href="https://example.org"]');
    if (!anchor) throw new Error("Missing web link");
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    let navigated = false;
    const intercept = (event: MouseEvent) => {
      navigated = !event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", intercept, { once: true });
    click(anchor, true);
    expect(navigated).toBe(true);
    expect(view.state.selection.main.head).toBe(doc.length);
  });

  it("does not expose unsafe links or instructional tooltips", () => {
    const doc = '---\ntitle: Title $x$\n---\n\nBefore.\n\n[unsafe](javascript:alert) $x$\n\n$$x$$\n\n| A | B |\n|---|---|\n| x | y |\n\n::: {#thm:result .theorem}\nResult.\n:::\n\n[@thm:result]\n\nAfter.';
    const view = mount(doc);
    expect(view.dom.querySelector('a[href^="javascript:"]')).toBeNull();
    expect([...view.dom.querySelectorAll("[title]")].map((element) => element.getAttribute("title")).filter((title) => title?.startsWith("Edit "))).toEqual([]);
    expect(view.dom.querySelector('[aria-label="Edit YAML metadata"]')).not.toBeNull();
  });

  it("refreshes table reference destinations when their definition changes", () => {
    const doc = "Before.\n\n| A | B |\n|---|---|\n| [jump][target] | y |\n\n[target]: #first\n\n# First\n\n# Second\n\nAfter.";
    const view = mount(doc);
    expect(view.dom.querySelector('.cf-cst-table a')?.getAttribute("href")).toBe("#first");
    const from = doc.indexOf("#first");
    view.dispatch({ changes: { from, to: from + "#first".length, insert: "#second" } });
    const anchor = view.dom.querySelector('.cf-cst-table a');
    expect(anchor?.getAttribute("href")).toBe("#second");
    if (!anchor) throw new Error("Missing updated table link");
    click(anchor, true);
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf("# Second"));
    expect(getPandocTree(view.state).text).toBe(view.state.doc.toString());
  });

  it("follows links inside table previews without opening the cell source", () => {
    const doc = "Before.\n\n| A | B |\n|---|---|\n| [jump](#destination) | y |\n\n# Destination\n\nAfter.";
    const view = mount(doc);
    const anchor = view.dom.querySelector('.cf-cst-table a[href="#destination"]');
    if (!anchor) throw new Error("Missing table link");
    click(anchor, true);
    expect(view.state.selection.main.head).toBe(doc.indexOf("# Destination"));
    expect(view.state.doc.toString()).toBe(doc);
  });
});
