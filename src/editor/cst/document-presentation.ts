import { type EditorState, StateField } from "@codemirror/state";
import {
  fenceInfo,
  mathDisplay,
  type SyntaxNode,
  type SyntaxTree,
} from "pandocmd-cst";
import {
  getBlockManifestEntry,
  getManifestBlockTitle,
} from "../../core/constants/block-manifest";
import { getPandocTree } from "./pandoc-cst-field";

const FENCED_DIV_CLASS_ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ["abs", "abstract"],
  ["alg", "algorithm"],
  ["conj", "conjecture"],
  ["cor", "corollary"],
  ["def", "definition"],
  ["defn", "definition"],
  ["eq", "equation"],
  ["ex", "example"],
  ["fig", "figure"],
  ["lem", "lemma"],
  ["pf", "proof"],
  ["prf", "proof"],
  ["prob", "problem"],
  ["prop", "proposition"],
  ["rem", "remark"],
  ["tbl", "table"],
  ["thm", "theorem"],
]);

const FENCED_DIV_ATTRIBUTE_TOKEN = /(?:[^\s"'\\]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g;

export interface FencedDivInfo {
  readonly canonicalClassName: string;
  readonly className: string;
  readonly id?: string;
  readonly title?: string;
}

export interface FencedDivPresentation extends FencedDivInfo {
  readonly label: string;
  readonly number?: number;
}

export interface EquationPresentation {
  readonly id?: string;
  readonly number: number;
}

export interface LocalReferenceTarget {
  readonly id: string;
  readonly label: string;
}

export interface DocumentPresentation {
  readonly equationsByMathFrom: ReadonlyMap<number, EquationPresentation>;
  readonly fencedDivsByFrom: ReadonlyMap<number, FencedDivPresentation>;
  readonly localTargets: ReadonlyMap<string, LocalReferenceTarget>;
}

function attributeValueText(value: string): string {
  const quote = value[0];
  return (quote === "\"" || quote === "'") && value.at(-1) === quote
    ? value.slice(1, -1)
    : value;
}

/** Read the already-delimited `fenceInfo` property published by the CST. */
export function parseFencedDivInfo(
  value: string | undefined,
): FencedDivInfo | null {
  const info = value?.trim();
  if (!info) return null;
  if (!info.startsWith("{")) {
    if (info.includes(" ") || info.includes("\t")) return null;
    const canonicalClassName = canonicalFencedDivClass(info);
    return { canonicalClassName, className: info };
  }
  if (!info.endsWith("}")) return null;

  let className: string | undefined;
  let id: string | undefined;
  let title: string | undefined;
  for (const token of info.slice(1, -1).match(FENCED_DIV_ATTRIBUTE_TOKEN) ?? []) {
    if (token.startsWith(".")) {
      className ??= token.slice(1);
      continue;
    }
    if (token.startsWith("#")) {
      id = token.slice(1);
      continue;
    }
    const equal = token.indexOf("=");
    if (equal > 0 && token.slice(0, equal) === "title") {
      title = attributeValueText(token.slice(equal + 1));
    }
  }

  return className
    ? {
      canonicalClassName: canonicalFencedDivClass(className),
      className,
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
    }
    : null;
}

export function canonicalFencedDivClass(className: string): string {
  const normalized = className.toLocaleLowerCase();
  return FENCED_DIV_CLASS_ABBREVIATIONS.get(normalized) ?? normalized;
}

export function fencedDivDisplayLabel(className: string): string {
  const canonical = canonicalFencedDivClass(className);
  const manifest = getBlockManifestEntry(canonical);
  if (manifest) return getManifestBlockTitle(manifest);
  const [first = "", ...rest] = [...className];
  return `${first.toLocaleUpperCase()}${rest.join("")}`;
}

function infoForFencedDiv(node: SyntaxNode): FencedDivInfo | null {
  return parseFencedDivInfo(node.prop(fenceInfo));
}

function containingEquationDiv(
  node: SyntaxNode,
  fencedDivInfos: ReadonlyMap<number, FencedDivInfo>,
): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (current.kind === "FencedDiv") {
      return fencedDivInfos.get(current.from)?.canonicalClassName === "equation"
        ? current
        : null;
    }
    current = current.parent;
  }
  return null;
}

function hasPipeTableAncestor(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.kind === "PipeTable") return true;
    current = current.parent;
  }
  return false;
}

function setFirstTarget(
  targets: Map<string, LocalReferenceTarget>,
  id: string | undefined,
  label: string,
): void {
  if (id && !targets.has(id)) targets.set(id, { id, label });
}

export function buildDocumentPresentation(
  tree: SyntaxTree,
): DocumentPresentation {
  const fencedDivInfos = new Map<number, FencedDivInfo>();
  const fencedDivsByFrom = new Map<number, FencedDivPresentation>();
  const localTargets = new Map<string, LocalReferenceTarget>();
  let blockNumber = 0;

  tree.iterate((node) => {
    if (node.kind !== "FencedDiv") return;
    const info = infoForFencedDiv(node);
    if (!info) return;
    fencedDivInfos.set(node.from, info);
    const numbered = getBlockManifestEntry(info.canonicalClassName)?.numbered
      ?? false;
    if (numbered) blockNumber += 1;
    const presentation: FencedDivPresentation = {
      ...info,
      label: fencedDivDisplayLabel(info.className),
      ...(numbered ? { number: blockNumber } : {}),
    };
    fencedDivsByFrom.set(node.from, presentation);
    if (info.canonicalClassName !== "equation") {
      setFirstTarget(
        localTargets,
        info.id,
        numbered ? `${presentation.label} ${blockNumber}` : presentation.label,
      );
    }
    return;
  });

  const numberedDisplayMath: SyntaxNode[] = [];
  const equationWrapperCandidates = new Map<number, SyntaxNode[]>();
  tree.iterate((node) => {
    if (
      node.kind !== "Math"
      || !(node.prop(mathDisplay) ?? false)
      || hasPipeTableAncestor(node)
    ) return;
    const wrapper = containingEquationDiv(node, fencedDivInfos);
    if (wrapper) {
      numberedDisplayMath.push(node);
      const candidates = equationWrapperCandidates.get(wrapper.from) ?? [];
      candidates.push(node);
      equationWrapperCandidates.set(wrapper.from, candidates);
    }
    return false;
  });

  const equationIdByMathFrom = new Map<number, string>();
  for (const [wrapperFrom, candidates] of equationWrapperCandidates) {
    if (candidates.length !== 1) continue;
    const id = fencedDivInfos.get(wrapperFrom)?.id;
    if (id) equationIdByMathFrom.set(candidates[0].from, id);
  }

  const equationsByMathFrom = new Map<number, EquationPresentation>();
  numberedDisplayMath.forEach((node, index) => {
    const number = index + 1;
    const id = equationIdByMathFrom.get(node.from);
    equationsByMathFrom.set(node.from, {
      number,
      ...(id ? { id } : {}),
    });
    setFirstTarget(localTargets, id, `(${number})`);
  });

  return { equationsByMathFrom, fencedDivsByFrom, localTargets };
}

const EMPTY_DOCUMENT_PRESENTATION: DocumentPresentation = Object.freeze({
  equationsByMathFrom: new Map(),
  fencedDivsByFrom: new Map(),
  localTargets: new Map(),
});

export const cstDocumentPresentationField =
  StateField.define<DocumentPresentation>({
    create(state) {
      return buildDocumentPresentation(getPandocTree(state));
    },

    update(value, transaction) {
      return transaction.docChanged
        ? buildDocumentPresentation(getPandocTree(transaction.state))
        : value;
    },
  });

export function getDocumentPresentation(
  state: EditorState,
): DocumentPresentation {
  return state.field(cstDocumentPresentationField, false)
    ?? EMPTY_DOCUMENT_PRESENTATION;
}
