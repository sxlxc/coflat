import {
  EditorSelection,
  type EditorState,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "pandocmd-cst";
import { parse as parseYaml } from "yaml";
import { CSS } from "../../core/constants/css-classes";
import { DOCUMENT_SURFACE_CLASS } from "../../core/document-surface-classes";
import { getPandocTree } from "./pandoc-cst-field";

interface YamlMetadata {
  readonly editFrom: number;
  readonly from: number;
  readonly mathMacros: Record<string, string>;
  readonly mathMacrosKey: string;
  readonly source: string;
  readonly title?: string;
  readonly to: number;
}

interface YamlMetadataDecorationState {
  readonly active: boolean;
  readonly decorations: DecorationSet;
  readonly metadata: YamlMetadata | null;
}

const EMPTY_MATH_MACROS: Record<string, string> = Object.freeze({});

function mathMacrosKey(macros: Readonly<Record<string, string>>): string {
  return Object.keys(macros)
    .sort()
    .map((name) => `${name}\0${macros[name]}`)
    .join("\0");
}

function yamlMetadataNode(state: EditorState): SyntaxNode | null {
  const first = getPandocTree(state).topLevelBlocks()[0];
  return first?.kind === "YamlMetadata" ? first : null;
}

function yamlEditPosition(node: SyntaxNode): number {
  for (const child of node.children()) {
    if (child.kind === "OpaqueBody") return child.from;
  }
  for (const child of node.children()) {
    if (child.kind === "LineEnding") return child.to;
  }
  return node.from;
}

function yamlBody(node: SyntaxNode): string {
  const children = [...node.children()];
  const delimiters = children.filter((child) => child.kind === "Delimiter");
  const opener = delimiters[0];
  const closer = delimiters.at(-1);
  if (!opener || !closer || opener === closer) return "";

  let from = opener.to - node.from;
  const afterOpener = opener.nextSibling();
  if (afterOpener?.kind === "LineEnding") from = afterOpener.to - node.from;
  let to = closer.from - node.from;
  const source = node.text();
  if (source.slice(Math.max(from, to - 2), to) === "\r\n") to -= 2;
  else if (to > from && /[\r\n]/.test(source.charAt(to - 1))) to -= 1;
  return source.slice(from, to);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlTitleAndMacros(node: SyntaxNode): {
  readonly mathMacros: Record<string, string>;
  readonly title?: string;
} {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBody(node));
  } catch (_error) {
    // Invalid YAML is a normal transient state while its visible source is
    // being edited. Rendering resumes as soon as the document becomes valid.
    return { mathMacros: EMPTY_MATH_MACROS };
  }
  if (!isRecord(parsed)) return { mathMacros: EMPTY_MATH_MACROS };

  const mathMacros: Record<string, string> = {};
  const math = parsed["math"];
  if (isRecord(math)) {
    for (const [name, expansion] of Object.entries(math)) {
      if (typeof expansion !== "string") continue;
      mathMacros[name.startsWith("\\") ? name : `\\${name}`] = expansion;
    }
  }
  const title = parsed["title"];
  return {
    mathMacros: Object.keys(mathMacros).length > 0
      ? mathMacros
      : EMPTY_MATH_MACROS,
    ...(typeof title === "string" && title ? { title } : {}),
  };
}

function readYamlMetadata(state: EditorState): YamlMetadata | null {
  const node = yamlMetadataNode(state);
  if (!node) return null;
  const { mathMacros, title } = yamlTitleAndMacros(node);
  return {
    editFrom: yamlEditPosition(node),
    from: node.from,
    mathMacros,
    mathMacrosKey: mathMacrosKey(mathMacros),
    source: node.text(),
    ...(title ? { title } : {}),
    to: node.to,
  };
}

function selectionTouchesMetadata(
  state: EditorState,
  metadata: YamlMetadata,
): boolean {
  return state.selection.ranges.some((range) => (
    range.empty
      ? metadata.from <= range.head && range.head < metadata.to
      : range.from < metadata.to && metadata.from < range.to
  ));
}

function createToggleButton(
  ownerDocument: Document,
  view: EditorView,
  expanded: boolean,
  target: number,
): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.className = CSS.yamlToggle;
  button.type = "button";
  button.textContent = expanded ? "hide YAML" : "YAML";
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute(
    "aria-label",
    expanded ? "Hide YAML metadata" : "Edit YAML metadata",
  );
  button.title = expanded ? "Hide YAML metadata" : "Edit YAML metadata";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    view.focus();
    view.dispatch({
      selection: EditorSelection.cursor(target),
      scrollIntoView: true,
      userEvent: "select",
    });
  });
  return button;
}

class YamlMetadataControlWidget extends WidgetType {
  constructor(
    private readonly expanded: boolean,
    private readonly target: number,
    private readonly title: string | undefined,
  ) {
    super();
  }

  eq(other: YamlMetadataControlWidget): boolean {
    return other.expanded === this.expanded
      && other.target === this.target
      && other.title === this.title;
  }

  toDOM(view: EditorView): HTMLElement {
    const ownerDocument = view.dom.ownerDocument;
    const header = ownerDocument.createElement("div");
    header.className = CSS.yamlMetadataHeader;
    header.appendChild(createToggleButton(
      ownerDocument,
      view,
      this.expanded,
      this.target,
    ));
    if (this.title) {
      const title = ownerDocument.createElement("div");
      title.className = DOCUMENT_SURFACE_CLASS.title;
      title.textContent = this.title;
      header.appendChild(title);
    }
    return header;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class YamlTitleWidget extends WidgetType {
  constructor(private readonly title: string) {
    super();
  }

  eq(other: YamlTitleWidget): boolean {
    return other.title === this.title;
  }

  toDOM(view: EditorView): HTMLElement {
    const title = view.dom.ownerDocument.createElement("div");
    title.className = DOCUMENT_SURFACE_CLASS.title;
    title.textContent = this.title;
    return title;
  }
}

function metadataLineNumbers(
  state: EditorState,
  metadata: YamlMetadata,
): readonly number[] {
  const first = state.doc.lineAt(metadata.from).number;
  const last = state.doc.lineAt(Math.max(metadata.from, metadata.to - 1)).number;
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function buildYamlMetadataDecorations(
  state: EditorState,
  metadata: YamlMetadata | null,
  active: boolean,
): DecorationSet {
  if (!metadata) return Decoration.none;
  const ranges: Array<ReturnType<Decoration["range"]>> = [];

  if (active) {
    ranges.push(Decoration.widget({
      block: true,
      side: -1,
      widget: new YamlMetadataControlWidget(true, metadata.to, undefined),
    }).range(metadata.from));
    for (const lineNumber of metadataLineNumbers(state, metadata)) {
      ranges.push(Decoration.line({
        attributes: { class: CSS.yamlSource },
      }).range(state.doc.line(lineNumber).from));
    }
    if (metadata.title) {
      ranges.push(Decoration.widget({
        block: true,
        side: -1,
        widget: new YamlTitleWidget(metadata.title),
      }).range(metadata.to));
    }
    return Decoration.set(ranges, true);
  }

  for (const lineNumber of metadataLineNumbers(state, metadata)) {
    const line = state.doc.line(lineNumber);
    ranges.push(Decoration.line({
      attributes: { class: CSS.yamlHidden },
    }).range(line.from));
    if (line.from < line.to) {
      ranges.push(Decoration.replace({}).range(line.from, line.to));
    }
  }
  ranges.push(Decoration.widget({
    block: true,
    side: -1,
    widget: new YamlMetadataControlWidget(
      false,
      metadata.editFrom,
      metadata.title,
    ),
  }).range(metadata.to));
  return Decoration.set(ranges, true);
}

function sameYamlSource(
  metadata: YamlMetadata | null,
  node: SyntaxNode | null,
): boolean {
  return metadata !== null
    && node !== null
    && metadata.from === node.from
    && metadata.to === node.to
    && metadata.source === node.text();
}

function yamlMetadataDecorationState(
  state: EditorState,
  previous?: YamlMetadataDecorationState,
): YamlMetadataDecorationState {
  const node = yamlMetadataNode(state);
  const metadata = previous && sameYamlSource(previous.metadata, node)
    ? previous.metadata
    : readYamlMetadata(state);
  const active = metadata ? selectionTouchesMetadata(state, metadata) : false;
  return {
    active,
    decorations: buildYamlMetadataDecorations(state, metadata, active),
    metadata,
  };
}

export const cstYamlMetadataField =
  StateField.define<YamlMetadataDecorationState>({
    create(state) {
      return yamlMetadataDecorationState(state);
    },

    update(value, transaction) {
      if (!transaction.docChanged && !transaction.selection) return value;
      return yamlMetadataDecorationState(transaction.state, value);
    },

    provide(field) {
      return EditorView.decorations.from(field, (value) => value.decorations);
    },
  });

export function getYamlMathMacros(
  state: EditorState,
): Readonly<Record<string, string>> {
  return state.field(cstYamlMetadataField, false)?.metadata?.mathMacros
    ?? EMPTY_MATH_MACROS;
}

export function getYamlMathMacrosKey(state: EditorState): string {
  return state.field(cstYamlMetadataField, false)?.metadata?.mathMacrosKey ?? "";
}

export function getYamlMetadataEnd(state: EditorState): number | null {
  return state.field(cstYamlMetadataField, false)?.metadata?.to ?? null;
}

export function isYamlMetadataActive(state: EditorState): boolean {
  return state.field(cstYamlMetadataField, false)?.active ?? false;
}
