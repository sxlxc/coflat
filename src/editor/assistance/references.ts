import type { EditorState, Extension, Transaction } from "@codemirror/state";
import {
  activateHover,
  closeHoverTooltip,
  type EditorView,
  hoverTooltip,
  keymap,
  type Tooltip,
} from "@codemirror/view";
import type { SyntaxNode, SyntaxTree } from "pandocmd-cst";
import type { CslJsonItem } from "../../core/citations/csl-json";
import { CSS } from "../../core/constants/css-classes";
import { collectCitationClusters } from "../citations/citation-model";
import { getBibliographyEntryHtml, getCitationItems } from "../citations/citation-surface";
import type { CitationClusterPresentation } from "../citations/types";
import { resolvePandocNode } from "../cst/cursor-context";
import { fencedDivTitleRange, getDocumentPresentation } from "../cst/document-presentation";
import { getPandocTree } from "../cst/pandoc-cst-field";
import { appendReferenceContent } from "./reference-content";

export interface ReferenceCandidate {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly preview: string;
  readonly from?: number;
}

function targetNode(tree: SyntaxTree, from: number, kind: SyntaxNode["kind"]): SyntaxNode {
  let node: SyntaxNode | null = resolvePandocNode(tree, from);
  while (node) {
    if (node.from === from && node.kind === kind) return node;
    node = node.parent;
  }
  throw new Error(`Missing ${kind} CST target at ${from}`);
}

function targetExcerptRange(state: EditorState, node: SyntaxNode): {
  readonly from: number;
  readonly to: number;
  readonly truncated: boolean;
} {
  let from = node.from;
  let to = node.to;
  if (node.kind === "FencedDiv") {
    let inBody = false;
    for (const child of node.children()) {
      if (!inBody) {
        if (child.kind === "LineEnding") {
          from = child.to;
          inBody = true;
        }
      } else if (child.kind === "FenceMark") {
        to = child.from;
        break;
      }
    }
  }
  let end = Math.min(to, from + 800);
  if (end < to && (state.doc.sliceString(end - 1, end + 1).codePointAt(0) ?? 0) > 0xffff) {
    end -= 1;
  }
  return { from, to: end, truncated: end < to };
}

function targetExcerpt(state: EditorState, node: SyntaxNode): string {
  const range = targetExcerptRange(state, node);
  const excerpt = state.doc.sliceString(range.from, range.to).trim();
  return range.truncated ? `${excerpt}…` : excerpt;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bibliographyCandidate(item: CslJsonItem): ReferenceCandidate {
  // CSL JSON ingestion validates id/type; optional metadata can still be malformed.
  const authors = Array.isArray(item.author) ? item.author.flatMap((author) => {
    if (typeof author !== "object" || author === null) return [];
    return textField(author.literal) || [textField(author.given), textField(author.family)]
      .filter(Boolean).join(" ");
  }).filter(Boolean).join(", ") : "";
  const year = item.issued?.["date-parts"]?.[0]?.[0];
  return {
    id: item.id,
    label: textField(item.title) || item.id,
    detail: [authors, typeof year === "number" ? String(year) : ""].filter(Boolean).join(" · "),
    preview: [
      textField(item["container-title"]) || textField(item.publisher),
      textField(item.DOI) ? `DOI: ${item.DOI}` : "",
    ].filter(Boolean).join("\n"),
  };
}

/** Derive suggestions from the same local targets and bibliography used for rendering. */
export function getReferenceCandidates(state: EditorState): readonly ReferenceCandidate[] {
  const tree = getPandocTree(state);
  const presentation = getDocumentPresentation(state);
  const candidates = new Map<string, ReferenceCandidate>();
  for (const [from, div] of presentation.fencedDivsByFrom) {
    if (!div.id || div.canonicalClassName === "equation" || candidates.has(div.id)) continue;
    const target = presentation.localTargets.get(div.id);
    if (!target) continue;
    candidates.set(div.id, {
      ...target,
      detail: div.title ?? "Local reference",
      preview: targetExcerpt(state, targetNode(tree, from, "FencedDiv")),
      from,
    });
  }
  for (const [from, equation] of presentation.equationsByMathFrom) {
    if (!equation.id || candidates.has(equation.id)) continue;
    const target = presentation.localTargets.get(equation.id);
    if (!target) continue;
    const node = targetNode(tree, from, "Math");
    let wrapper = node.parent;
    while (wrapper && wrapper.kind !== "FencedDiv") wrapper = wrapper.parent;
    const title = wrapper ? presentation.fencedDivsByFrom.get(wrapper.from)?.title : undefined;
    candidates.set(equation.id, {
      ...target,
      detail: title ?? "Equation",
      preview: targetExcerpt(state, node),
      from,
    });
  }
  for (const item of getCitationItems(state)) {
    if (!candidates.has(item.id)) candidates.set(item.id, bibliographyCandidate(item));
  }
  return [...candidates.values()];
}

function citationAt(
  state: EditorState,
  position: number,
  side: -1 | 1,
): CitationClusterPresentation | null {
  const from = position - (side < 0 ? 1 : 0);
  if (from < 0 || from >= state.doc.length) return null;
  return collectCitationClusters(getPandocTree(state), { from, to: from + 1 })[0] ?? null;
}

function referenceTooltip(view: EditorView, position: number, side: -1 | 1): Tooltip | null {
  const cluster = citationAt(view.state, position, side);
  if (!cluster) return null;
  const candidates = new Map(getReferenceCandidates(view.state).map((item) => [item.id, item]));
  const references: readonly ReferenceCandidate[] = cluster.items.map((item) => candidates.get(item.id) ?? {
    id: item.id,
    label: "Unresolved reference",
    detail: "No matching local label or loaded bibliography entry.",
    preview: "",
  });
  return {
    pos: cluster.from,
    end: cluster.to,
    above: true,
    create(editor) {
      const document = editor.dom.ownerDocument;
      const dom = document.createElement("div");
      dom.className = CSS.referencePreview;
      dom.setAttribute("role", "tooltip");
      dom.setAttribute("aria-live", "polite");
      for (const reference of references) {
        const section = document.createElement("section");
        const key = document.createElement("small");
        key.textContent = `@${reference.id}`;
        const entryHtml = reference.from === undefined
          ? getBibliographyEntryHtml(editor.state, reference.id) : undefined;
        if (entryHtml) {
          const entry = document.createElement("div");
          entry.innerHTML = entryHtml;
          for (const element of entry.querySelectorAll("[id]")) element.removeAttribute("id");
          for (const label of entry.querySelectorAll(".csl-left-margin")) label.remove();
          section.append(key, entry);
        } else {
          const heading = document.createElement("strong");
          heading.textContent = reference.label;
          section.append(heading, key);
          if (reference.from !== undefined) {
            const presentation = getDocumentPresentation(editor.state);
            const isEquation = presentation.equationsByMathFrom.has(reference.from);
            const node = targetNode(
              getPandocTree(editor.state), reference.from, isEquation ? "Math" : "FencedDiv",
            );
            let wrapper: SyntaxNode | null = node;
            while (wrapper && wrapper.kind !== "FencedDiv") wrapper = wrapper.parent;
            if (wrapper) heading.textContent = presentation.fencedDivsByFrom.get(wrapper.from)?.label ?? reference.label;
            const title = wrapper && fencedDivTitleRange(wrapper);
            if (title && title.from < title.to) {
              heading.append(" (");
              appendReferenceContent(heading, editor.state, title);
              heading.append(")");
            }
            const range = targetExcerptRange(editor.state, node);
            const body = document.createElement("div");
            appendReferenceContent(body, editor.state, range);
            if (range.truncated) body.append("…");
            section.appendChild(body);
          } else {
            for (const text of [reference.detail, reference.preview]) {
              if (!text) continue;
              const paragraph = document.createElement("p");
              paragraph.textContent = text;
              section.appendChild(paragraph);
            }
          }
        }
        dom.appendChild(section);
      }
      return { dom };
    },
  };
}

export function referencePreviewExtension(hoverTime: number): Extension {
  const hide = (transaction: Transaction): boolean => transaction.docChanged
    || transaction.selection !== undefined
    || getCitationItems(transaction.startState) !== getCitationItems(transaction.state);
  const hover = hoverTooltip(referenceTooltip, { hoverTime, hideOn: hide });
  return [
    hover,
    keymap.of([
      {
        key: "Mod-Shift-Space",
        run(view) {
          const position = view.state.selection.main.head;
          const side = citationAt(view.state, position, 1) ? 1 : -1;
          if (!citationAt(view.state, position, side)) return false;
          activateHover(view, position, side, { tooltip: hover, until: hide });
          return true;
        },
      },
      {
        key: "Escape",
        run(view) {
          if (!view.state.field(hover.active).length) return false;
          view.dispatch({ effects: closeHoverTooltip(hover) });
          return true;
        },
      },
    ]),
  ];
}
