import { EditorView, ViewPlugin } from "@codemirror/view";
import type { SyntaxNode, SyntaxTree } from "pandocmd-cst";
import { isSafeUrl } from "../../core/lib/url-utils";
import { getDocumentPresentation } from "./document-presentation";
import { getPandocTree } from "./pandoc-cst-field";

/** Destinations come from the authoritative CST, including resolved references. */
export function linkDestination(node: SyntaxNode, tree: SyntaxTree): string | null {
  let destination: string | null = null;
  if (node.kind === "ReferenceCandidate") destination = tree.semantics.reference(node).destination;
  else if (node.kind === "Link") {
    destination = [...node.children()].find((child) => child.kind === "LinkDestination")?.text().replace(/^<|>$/g, "") ?? null;
  } else if (node.kind === "AutoLink") {
    destination = node.text().slice(1, -1);
    if (!destination.includes(":") && destination.includes("@")) destination = `mailto:${destination}`;
  }
  return destination && isSafeUrl(destination) ? destination : null;
}

function fragmentPosition(view: EditorView, fragment: string): number | null {
  let id: string;
  try { id = decodeURIComponent(fragment); }
  catch { return null; }
  if (!id) return 0;
  const presentation = getDocumentPresentation(view.state);
  for (const targets of [presentation.fencedDivsByFrom, presentation.equationsByMathFrom]) {
    for (const [position, target] of targets) if (target.id === id) return position;
  }
  const tree = getPandocTree(view.state);
  let position: number | null = null;
  tree.iterate((node) => {
    if (position !== null) return false;
    if ((node.kind === "AtxHeading" || node.kind === "SetextHeading") && tree.semantics.heading(node).identifier === id) {
      position = node.from;
      return false;
    }
  });
  return position;
}

export const cstLinkNavigation = ViewPlugin.define((view) => {
  const handle = (event: MouseEvent): void => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor || !view.dom.contains(anchor) || event.button !== 0) return;
    const follow = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (event.type === "mousedown") {
      // Run before widget source-reveal and CodeMirror selection handlers.
      if (follow) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    if (!follow) { event.preventDefault(); return; }
    const href = anchor.getAttribute("href") ?? "";
    if (!isSafeUrl(href)) { event.preventDefault(); return; }
    if (!href.startsWith("#")) return; // Hosts may intercept external anchor clicks.
    event.preventDefault();
    event.stopPropagation();
    const position = fragmentPosition(view, href.slice(1));
    if (position !== null) {
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "center" }), userEvent: "select.pointer" });
      view.focus();
    }
  };
  view.dom.addEventListener("mousedown", handle, true);
  view.dom.addEventListener("click", handle, true);
  return {
    destroy() {
      view.dom.removeEventListener("mousedown", handle, true);
      view.dom.removeEventListener("click", handle, true);
    },
  };
});
