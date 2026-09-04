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
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  DOCUMENT_SURFACE_CLASS,
  documentSurfaceClassNames,
} from "../core/document-surface-classes";
import { CSS } from "../core/constants/css-classes";
import {
  getPandocCursorContext,
  pandocCursorContextField,
} from "./cst/cursor-context";
import {
  cstEditSurface,
} from "./cst/edit-surface";
import { pandocCstField } from "./cst/pandoc-cst-field";
import { getYamlMetadataEnd } from "./cst/yaml-metadata";
import { coflatTheme } from "./theme";

export interface SimpleEditorConfig {
  readonly parent: HTMLElement;
  readonly doc?: string;
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

const selectionMark = Decoration.mark({ class: CSS.selectionRange });

function textSelectionDecorations(state: EditorState): DecorationSet {
  return Decoration.set(state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => selectionMark.range(range.from, range.to)));
}

const textSelectionHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = textSelectionDecorations(view.state);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet) {
      this.decorations = textSelectionDecorations(update.state);
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
      ...documentSurfaceExtensions,
      history(),
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
