import type { EditorState } from "@codemirror/state";
import {
  headingLevel,
  mathDisplay,
  orderedListStart,
  type NodeKind,
  type SourceRange,
  type SyntaxNode,
} from "pandocmd-cst";
import { CSS, mathSurfaceClassNames } from "../../core/constants/css-classes";
import { collectCitationClusters } from "../citations/citation-model";
import { getCitationHtml } from "../citations/citation-surface";
import { getDocumentPresentation } from "../cst/document-presentation";
import { getPandocTree } from "../cst/pandoc-cst-field";
import { getYamlMathMacros } from "../cst/yaml-metadata";
import { renderKatexToHtml } from "../render/katex-render";

const PREVIEW_TAGS: Readonly<Partial<Record<NodeKind, keyof HTMLElementTagNameMap>>> = {
  Paragraph: "p",
  BlockQuote: "blockquote",
  BulletList: "ul",
  OrderedList: "ol",
  ListItem: "li",
  DefinitionList: "dl",
  DefinitionTerm: "dt",
  DefinitionBody: "dd",
  Emphasis: "em",
  Strong: "strong",
  Strikeout: "del",
  Superscript: "sup",
  Subscript: "sub",
  Quoted: "q",
  PipeTable: "table",
  TableHead: "thead",
  TableBody: "tbody",
  TableRow: "tr",
  TableCell: "td",
};

const SOURCE_MARKS: ReadonlySet<NodeKind> = new Set([
  "Delimiter", "MathMark", "CodeMark", "FenceMark", "ListMark", "QuoteMark",
  "BracketMark", "ParenMark", "AttributeList", "CodeInfo", "TableDelimiter",
  "TableAlignment", "HtmlTag",
]);

function appendNode(parent: HTMLElement, state: EditorState, node: SyntaxNode): void {
  const document = parent.ownerDocument;
  const children = [...node.children()];
  const appendChildren = (element: HTMLElement): void => {
    for (const child of children) appendNode(element, state, child);
  };
  if (SOURCE_MARKS.has(node.kind)) return;
  const tag = PREVIEW_TAGS[node.kind];
  if (tag) {
    const element = document.createElement(tag);
    if (node.kind === "OrderedList") element.setAttribute("start", String(node.prop(orderedListStart) ?? 1));
    appendChildren(element);
    parent.appendChild(element);
    return;
  }
  switch (node.kind) {
    case "FencedDiv": {
      let inBody = false;
      for (const child of children) {
        if (!inBody) {
          if (child.kind === "LineEnding") inBody = true;
        } else if (child.kind === "FenceMark") break;
        else appendNode(parent, state, child);
      }
      return;
    }
    case "Math": {
      const latex = children.find((child) => child.kind === "OpaqueBody")?.text() ?? "";
      const display = node.prop(mathDisplay) ?? false;
      const math = document.createElement(display ? "div" : "span");
      math.className = mathSurfaceClassNames(display);
      math.setAttribute("aria-label", latex);
      math.innerHTML = renderKatexToHtml(latex, display, getYamlMathMacros(state));
      parent.appendChild(math);
      return;
    }
    case "Code":
    case "FencedCodeBlock":
    case "IndentedCodeBlock": {
      const code = document.createElement(node.kind === "Code" ? "code" : "pre");
      code.className = CSS.inlineCode;
      code.textContent = children.find((child) => child.kind === "OpaqueBody")?.text() ?? "";
      parent.appendChild(code);
      return;
    }
    case "Citation":
    case "ExampleReference": {
      const cluster = collectCitationClusters(getPandocTree(state), node)[0];
      const id = cluster?.items.length === 1 ? cluster.items[0].id : undefined;
      const target = id && (node.text() === `[@${id}]` || node.text() === `@${id}`)
        ? getDocumentPresentation(state).localTargets.get(id) : undefined;
      const html = getCitationHtml(state, node.from);
      const reference = document.createElement("span");
      if (target) {
        reference.className = CSS.fencedDivReference;
        reference.textContent = target.label;
      } else if (html) {
        reference.className = CSS.citation;
        reference.innerHTML = html;
      } else reference.textContent = node.text();
      parent.appendChild(reference);
      return;
    }
    case "AtxHeading":
    case "SetextHeading": {
      const heading = document.createElement(`h${node.prop(headingLevel) ?? 1}`);
      appendChildren(heading);
      parent.appendChild(heading);
      return;
    }
    case "Link":
    case "Image":
    case "ReferenceCandidate":
    case "ImageReferenceCandidate":
    case "AutoLink": {
      const label = document.createElement("span");
      label.className = CSS.linkRendered;
      if (node.kind === "AutoLink") {
        label.textContent = children.find((child) => child.kind === "Text")?.text() ?? "";
      } else {
        let inLabel = false;
        for (const child of children) {
          if (child.kind === "BracketMark") {
            if (inLabel) break;
            inLabel = true;
          } else if (inLabel) appendNode(label, state, child);
        }
      }
      parent.appendChild(label);
      return;
    }
    case "Escape":
      parent.append(node.text().slice(1));
      return;
    case "Entity": {
      const decoder = document.createElement("textarea");
      decoder.innerHTML = node.text();
      parent.append(decoder.value);
      return;
    }
    case "SoftBreak":
    case "LineBreak":
      parent.appendChild(document.createElement("br"));
      return;
    case "HorizontalRule":
      parent.appendChild(document.createElement("hr"));
      return;
    case "BlankLines":
    case "LineEnding":
      return;
    case "RawInline":
    case "RawBlock":
      parent.append(node.text());
      return;
    default:
      if (children.length) appendChildren(parent);
      else parent.append(node.text());
  }
}

/** Render an excerpt directly from the editor's CST, including offscreen targets. */
export function appendReferenceContent(
  parent: HTMLElement,
  state: EditorState,
  range: SourceRange,
): void {
  getPandocTree(state).iterate((node) => {
    if (node.from >= range.from && node.to <= range.to) {
      appendNode(parent, state, node);
      return false;
    }
    if (!node.firstChild()) {
      parent.append(state.doc.sliceString(Math.max(node.from, range.from), Math.min(node.to, range.to)));
    }
  }, range);
}
