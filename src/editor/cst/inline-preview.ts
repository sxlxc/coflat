import type { NodeKind } from "pandocmd-cst";
import { CSS } from "../../core/constants/css-classes";
import { createInlineMathSurfaceElement, renderInlineMathErrorFallback } from "../../core/math-inline-surface";
import { renderKatexToHtml } from "../render/katex-render";

export interface InlinePlan {
  readonly kind: NodeKind;
  readonly destination?: string | null;
  readonly text: string;
  readonly children: readonly InlinePlan[];
}

const SOURCE_MARK_KINDS: ReadonlySet<NodeKind> = new Set([
  "Delimiter",
  "MathMark",
  "CodeMark",
  "BracketMark",
  "ParenMark",
  "AttributeList",
]);

function appendText(parent: Node, ownerDocument: Document, text: string): void {
  if (text) parent.appendChild(ownerDocument.createTextNode(text));
}

function inlineBody(plan: InlinePlan): string {
  return plan.children.find((child) => child.kind === "OpaqueBody")?.text ?? "";
}

export function appendPlanChildren(
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
    case "Image": {
      if (plan.kind === "ReferenceCandidate" && !plan.destination) {
        appendText(parent, ownerDocument, plan.text);
        return;
      }
      const link = ownerDocument.createElement(plan.destination ? "a" : "span");
      if (plan.destination) link.setAttribute("href", plan.destination);
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
    default:
      // Plans carry no reference resolution. Unsupported syntax must retain
      // its punctuation instead of becoming an apparently resolved label.
      appendText(parent, ownerDocument, plan.text);
  }
}
