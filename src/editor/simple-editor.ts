import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  EditorSelection,
  EditorState,
  type Extension,
  RangeSet,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  GutterMarker,
  keymap,
  lineNumbers,
  lineNumberMarkers,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { headingLevel } from "pandocmd-cst";
import {
  DOCUMENT_SURFACE_CLASS,
  documentSurfaceClassNames,
} from "../core/document-surface-classes";
import { CSS } from "../core/constants/css-classes";
import {
  editingAssistanceExtension,
  type EditingAssistanceOptions,
} from "./assistance/editing-assistance";
import {
  getPandocCursorContext,
  pandocCursorContextField,
} from "./cst/cursor-context";
import {
  cstEditSurface,
} from "./cst/edit-surface";
import { getPandocTree, pandocCstField } from "./cst/pandoc-cst-field";
import { getYamlMetadataEnd } from "./cst/yaml-metadata";
import { coflatTheme } from "./theme";

export interface SimpleEditorConfig {
  readonly parent: HTMLElement;
  readonly doc?: string;
  /** Configure markup typing, completion, and reference previews, or disable all with false. */
  readonly editingAssistance?: EditingAssistanceOptions | false;
  readonly extensions?: readonly Extension[];
}

const documentSurfaceExtensions: readonly Extension[] = [
  EditorView.editorAttributes.of({
    class: documentSurfaceClassNames(DOCUMENT_SURFACE_CLASS.surface),
  }),
  EditorView.contentAttributes.compute(
    [pandocCursorContextField],
    (state) => {
      const context = getPandocCursorContext(state);
      return {
        class: documentSurfaceClassNames(DOCUMENT_SURFACE_CLASS.flow),
        "data-cst-version": String(context.cstVersion),
        ...(context.block ? { "data-cst-block": context.block.kind } : {}),
        ...(context.inline ? { "data-cst-inline": context.inline.kind } : {}),
      };
    },
  ),
];

class HeadingLineNumberMarker extends GutterMarker {
  readonly elementClass: string;

  constructor(readonly level: number, readonly lineNumber: number) {
    super();
    this.elementClass = CSS.headingLine(level);
  }

  toDOM(): HTMLElement {
    const number = document.createElement("span");
    number.textContent = String(this.lineNumber);
    return number;
  }

  eq(other: HeadingLineNumberMarker): boolean {
    return this.level === other.level && this.lineNumber === other.lineNumber;
  }
}

const headingLineNumbers = lineNumberMarkers.compute([pandocCstField], (state) => {
  const markers: Array<ReturnType<GutterMarker["range"]>> = [];
  getPandocTree(state).iterate((node) => {
    if (node.kind !== "AtxHeading" && node.kind !== "SetextHeading") return;
    const line = state.doc.lineAt(node.from);
    markers.push(new HeadingLineNumberMarker(node.prop(headingLevel) ?? 1, line.number)
      .range(line.from));
    return false;
  });
  return RangeSet.of(markers, true);
});

const selectionMark = Decoration.mark({ class: CSS.selectionRange });

function textSelectionDecorations(view: EditorView): DecorationSet {
  const { state, viewport } = view;
  const marks: Array<ReturnType<typeof selectionMark.range>> = [];
  const markText = (from: number, to: number): void => {
    // Including a newline can also invalidate a block widget on the next line.
    while (from < to) {
      const line = state.doc.lineAt(from);
      const end = Math.min(to, line.to);
      if (from < end) marks.push(selectionMark.range(from, end));
      from = line.to + 1;
    }
  };
  for (const selection of state.selection.ranges) {
    const selectionFrom = Math.max(selection.from, viewport.from);
    const selectionTo = Math.min(selection.to, viewport.to);
    if (selectionFrom >= selectionTo) continue;
    const replacements: Array<{ from: number; to: number }> = [];
    // Block previews paint their own selection. Marks through hidden source
    // can make CodeMirror recreate those widgets, reloading images during a drag.
    for (const decorations of state.facet(EditorView.decorations)) {
      if (typeof decorations === "function") continue;
      decorations.between(selectionFrom, selectionTo, (from, to, decoration) => {
        if (from < to && decoration.spec.block) replacements.push({ from, to });
      });
    }
    let from = selectionFrom;
    for (const replacement of replacements.sort((a, b) => a.from - b.from)) {
      if (from < replacement.from) markText(from, replacement.from);
      from = Math.max(from, replacement.to);
    }
    if (from < selectionTo) markText(from, selectionTo);
  }
  return Decoration.set(marks);
}

const textSelectionHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = textSelectionDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = textSelectionDecorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

/**
 * Mount the single Coflat editing surface.
 *
 * Markdown structure is supplied exclusively by pandocmd-cst. CodeMirror owns
 * input, selection, history, and viewport behavior; it does not parse Markdown.
 */
export function createSimpleEditor(config: SimpleEditorConfig): EditorView {
  let state = EditorState.create({
    doc: config.doc ?? "",
    extensions: [
      pandocCstField,
      pandocCursorContextField,
      cstEditSurface,
      editingAssistanceExtension(config.editingAssistance),
      ...documentSurfaceExtensions,
      history(),
      lineNumbers(),
      headingLineNumbers,
      drawSelection(),
      textSelectionHighlighter,
      dropCursor(),
      highlightSpecialChars(),
      highlightSelectionMatches(),
      EditorState.allowMultipleSelections.of(true),
      EditorState.tabSize.of(2),
      indentUnit.of("  "),
      EditorView.lineWrapping,
      keymap.of([
        indentWithTab,
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      coflatTheme,
      ...(config.extensions ?? []),
    ],
  });

  const yamlEnd = getYamlMetadataEnd(state);
  if (yamlEnd !== null && state.selection.main.head < yamlEnd) {
    // The metadata starts collapsed, so place the initial caret at its visible
    // boundary rather than leaving an invisible insertion point at offset 0.
    state = state.update({
      selection: EditorSelection.cursor(yamlEnd),
    }).state;
  }

  return new EditorView({ state, parent: config.parent });
}
