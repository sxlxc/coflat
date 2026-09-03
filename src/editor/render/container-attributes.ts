import { headingLevel, taskChecked, type SyntaxNode } from "pandocmd-cst";
import { getPandocTree } from "../cst";
import {
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
} from "@codemirror/view";
import {
  DOCUMENT_SURFACE_CLASS,
  documentSurfaceClassNames,
} from "../../core/document-surface-classes";
import {
  editorListItemLineClassNames,
} from "../../core/list-surface";
import {
  forEachOverlappingOrderedRange,
  getMergedRangeCoverage,
  rangesOverlap,
} from "../lib/range-helpers";
import { documentAnalysisField } from "../state/document-analysis";
import { frontmatterField } from "../state/frontmatter-state";
import { buildDecorations } from "./decoration-core";
import { createSimpleViewPlugin } from "./view-plugin-factories";

/**
 * Maps public CST node kinds to HTML tag names.
 * These become `data-tag-name` attributes on `cm-line` elements,
 * enabling CSS selectors like `[data-tag-name="h1"]`.
 */
const CST_TAG_NAME_MAP: Readonly<Record<string, string>> = {
  BulletList: "ul",
  OrderedList: "ol",
  FencedCodeBlock: "code",
  IndentedCodeBlock: "code",
  HorizontalRule: "hr",
  FencedDiv: "div",
  Paragraph: "p",
  Plain: "p",
};

const CST_TREE_ONLY_TAG_NAME_MAP: Readonly<Record<string, string>> = {
  BulletList: "ul",
  OrderedList: "ol",
  FencedCodeBlock: "code",
  IndentedCodeBlock: "code",
  HorizontalRule: "hr",
  Paragraph: "p",
  Plain: "p",
};

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
const LINE_CLASS_BY_TAG: Readonly<Record<string, string>> = {
  p: DOCUMENT_SURFACE_CLASS.paragraph,
};

const LINE_DECORATION_CACHE = new Map<string, Decoration>();
const LIST_LINE_DECORATION_CACHE = new Map<string, Decoration>();

function sourceLineDecoration(from: number, to: number): Decoration {
  return Decoration.line({
    attributes: {
      "data-source-from": String(from),
      "data-source-to": String(to),
    },
  });
}

function lineDecorationFor(tagName: string): Decoration {
  const classes = documentSurfaceClassNames(LINE_CLASS_BY_TAG[tagName]);
  const cached = LINE_DECORATION_CACHE.get(tagName);
  if (cached) return cached;
  const decoration = Decoration.line({
    attributes: { "data-tag-name": tagName },
    class: classes || undefined,
  });
  LINE_DECORATION_CACHE.set(tagName, decoration);
  return decoration;
}

function listLineDecorationFor(classNames: readonly string[]): Decoration {
  const classes = documentSurfaceClassNames(...classNames);
  const cached = LIST_LINE_DECORATION_CACHE.get(classes);
  if (cached) return cached;
  const decoration = Decoration.line({ class: classes });
  LIST_LINE_DECORATION_CACHE.set(classes, decoration);
  return decoration;
}

function forEachCoveredLineStart(
  state: EditorState,
  from: number,
  to: number,
  rangeFrom: number,
  rangeTo: number,
  callback: (lineStart: number) => void,
): void {
  if (!rangesOverlap({ from, to }, { from: rangeFrom, to: rangeTo })) return;

  let lineStart = state.doc.lineAt(Math.max(from, rangeFrom)).from;
  const nodeEnd = Math.min(to, rangeTo);

  while (lineStart < nodeEnd) {
    callback(lineStart);
    const line = state.doc.lineAt(lineStart);
    if (line.to >= nodeEnd) break;
    lineStart = line.to + 1;
  }
}

function assignLineTag(
  lineTagMap: Map<number, string>,
  state: EditorState,
  from: number,
  to: number,
  tagName: string,
  rangeFrom: number,
  rangeTo: number,
): void {
  forEachCoveredLineStart(state, from, to, rangeFrom, rangeTo, (lineStart) => {
    lineTagMap.set(lineStart, tagName);
  });
}

function addListLineDecorations(
  items: Range<Decoration>[],
  state: EditorState,
  from: number,
  to: number,
  classNames: readonly string[],
  rangeFrom: number,
  rangeTo: number,
): void {
  const decoration = listLineDecorationFor(classNames);
  forEachCoveredLineStart(state, from, to, rangeFrom, rangeTo, (lineStart) => {
    items.push(decoration.range(lineStart));
  });
}

function listItemLineClasses(node: SyntaxNode): readonly string[] {
  return editorListItemLineClassNames({
    ordered: node.parent?.kind === "OrderedList",
    task: node.prop(taskChecked) !== undefined,
  }).split(" ");
}

function collectLineDecorationsInRange(
  state: EditorState,
  rangeFrom: number,
  rangeTo: number,
): Range<Decoration>[] {
  const visibleFrom = Math.max(rangeFrom, hiddenFrontmatterVisualEnd(state));
  if (visibleFrom > rangeTo) return [];
  const lineTagMap = new Map<number, string>();
  const items: Range<Decoration>[] = [];
  const semantics = state.field(documentAnalysisField, false);
  const range = { from: visibleFrom, to: rangeTo };

  if (semantics) {
    forEachOverlappingOrderedRange(
      semantics.headings,
      range,
      (heading) => {
        const tagName = HEADING_TAGS[heading.level - 1];
        if (!tagName) {
          return;
        }
        assignLineTag(
          lineTagMap,
          state,
          heading.from,
          heading.to,
          tagName,
          visibleFrom,
          rangeTo,
        );
      },
    );

    forEachOverlappingOrderedRange(
      getMergedRangeCoverage(semantics.fencedDivs),
      range,
      (div) => {
        assignLineTag(
          lineTagMap,
          state,
          div.from,
          div.to,
          "div",
          visibleFrom,
          rangeTo,
        );
      },
    );
  }

  const treeTagMap = semantics ? CST_TREE_ONLY_TAG_NAME_MAP : CST_TAG_NAME_MAP;
  getPandocTree(state).iterate((node) => {
      let tagName = treeTagMap[node.kind];
      if (!semantics && (node.kind === "AtxHeading" || node.kind === "SetextHeading")) {
        tagName = HEADING_TAGS[(node.prop(headingLevel) ?? 1) - 1];
      }
      if (node.kind === "ListItem") tagName = "p";
      if (tagName) {
        assignLineTag(
          lineTagMap,
          state,
          node.from,
          node.to,
          tagName,
          visibleFrom,
          rangeTo,
        );
      }
      if (node.kind === "ListItem") {
        addListLineDecorations(
          items,
          state,
          node.from,
          node.to,
          listItemLineClasses(node),
          visibleFrom,
          rangeTo,
        );
      }
    }, { from: visibleFrom, to: rangeTo });

  for (const [pos, tagName] of [...lineTagMap.entries()].sort((a, b) => a[0] - b[0])) {
    items.push(lineDecorationFor(tagName).range(pos));
  }

  const firstLine = state.doc.lineAt(visibleFrom);
  const lastLine = state.doc.lineAt(rangeTo);
  for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber++) {
    const line = state.doc.line(lineNumber);
    items.push(sourceLineDecoration(line.from, line.to).range(line.from));
  }

  return items;
}

function hiddenFrontmatterVisualEnd(state: EditorState): number {
  const frontmatter = state.field(frontmatterField, false);
  if (!frontmatter || frontmatter.end <= 0) return 0;
  let visualEnd = frontmatter.end;
  while (visualEnd < state.doc.length) {
    const line = state.doc.lineAt(visualEnd);
    if (line.text.trim() !== "") break;
    visualEnd = line.to < state.doc.length ? line.to + 1 : line.to;
  }
  return visualEnd;
}

/**
 * Build a DecorationSet of `Decoration.line` decorations for the lines that
 * CodeMirror currently renders (the viewport expanded to line bounds), adding
 * `data-tag-name` attributes to each covered `cm-line` element.
 *
 * `Decoration.line` must be applied at the line-start position (from).
 * We iterate over every rendered line that falls within each matching node
 * and apply the decoration to each line's start. Lines outside the viewport
 * have no DOM, so decorating them would have no observable effect.
 */
function buildViewportContainerDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const rangeFrom = state.doc.lineAt(view.viewport.from).from;
  const rangeTo = state.doc.lineAt(view.viewport.to).to;
  return buildDecorations(
    collectLineDecorationsInRange(state, rangeFrom, rangeTo),
  );
}

/**
 * Viewport-scoped ViewPlugin that maintains `Decoration.line` decorations
 * for the rendered lines, adding `data-tag-name` attributes to the
 * corresponding `cm-line` DOM elements.
 *
 * Rebuilds are O(visible lines): on doc edits, viewport moves, and syntax
 * tree advancement (background parse progress dispatches tree-changing
 * updates, which re-tags any lines that were rendered from a partial tree).
 *
 * This enables CSS targeting such as:
 *   `.cm-line[data-tag-name="h1"] { ... }`
 */
const containerAttributesViewPlugin = createSimpleViewPlugin(
  buildViewportContainerDecorations,
  {
    shouldUpdate: (update) =>
      update.docChanged ||
      update.viewportChanged ||
      getPandocTree(update.state) !== getPandocTree(update.startState),
    spanName: "cm6.containerAttributes",
  },
);

/** CM6 extension that adds `data-tag-name` attributes to `cm-line` elements. */
export const containerAttributesPlugin: Extension = [
  frontmatterField,
  containerAttributesViewPlugin,
];
