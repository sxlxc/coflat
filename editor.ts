/**
 * `@chaoxu/coflat` — a single editable Pandoc Markdown surface.
 *
 * CodeMirror owns text input, selection, history, and viewport behavior.
 * pandocmd-cst is the only Markdown structure and semantic authority.
 */

import {
  Annotation,
  type ChangeSet,
  EditorSelection,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { minimalChange } from "./src/core/minimal-change";
import { getPandocCursorContext } from "./src/editor/cst/cursor-context";
import { getPandocTree } from "./src/editor/cst/pandoc-cst-field";
import {
  getYamlMetadataEnd,
  isYamlMetadataActive,
} from "./src/editor/cst/yaml-metadata";
import {
  createSimpleEditor,
  type SimpleEditorConfig,
} from "./src/editor/simple-editor";

const programmaticDocumentChange = Annotation.define<boolean>();

export interface PandocCstNode {
  readonly kind: string;
  readonly from: number;
  readonly to: number;
  readonly parent: PandocCstNode | null;
  readonly childCount: number;
  firstChild(): PandocCstNode | null;
  lastChild(): PandocCstNode | null;
  child(index: number): PandocCstNode | null;
  children(): Iterable<PandocCstNode>;
  text(): string;
}

/** Public, dependency-neutral view of pandocmd-cst's authoritative snapshot. */
export interface PandocCstSnapshot {
  readonly version: number;
  readonly parserVersion: string;
  readonly dialect: string;
  readonly text: string;
  readonly length: number;
  readonly root: PandocCstNode;
  resolve(offset: number, bias?: "left" | "right"): PandocCstNode;
  topLevelBlocks(): readonly PandocCstNode[];
  checkInvariants(): void;
}

export interface PandocCursorNode {
  readonly kind: string;
  readonly from: number;
  readonly to: number;
}

export interface PandocCursorContext {
  readonly cstVersion: number;
  readonly position: number;
  readonly inline: PandocCursorNode | null;
  readonly block: PandocCursorNode | null;
  readonly path: readonly PandocCursorNode[];
}

export interface EditorDocumentChange {
  readonly changes: ChangeSet;
  /** The authoritative CST snapshot published with the changed CM6 document. */
  readonly tree: PandocCstSnapshot;
}

export interface EditorInsertTextOptions {
  /** Insert at an explicit 0-based UTF-16 source offset. */
  readonly position?: number;
  /** Replace the active selection when no explicit position is set. Defaults to true. */
  readonly replaceSelection?: boolean;
}

export interface EditorSourcePosition {
  readonly pos: number;
  readonly line: number;
  readonly viewportRatio?: number;
}

export interface EditorVisibleSourcePositionOptions {
  readonly viewportRatio?: number;
  readonly x?: number;
  readonly y?: number;
}

export interface EditorScrollToSourcePositionOptions {
  readonly pos?: number;
  readonly line?: number;
  readonly select?: boolean;
  readonly center?: boolean;
}

export interface EditorScrollToLineOptions {
  readonly column?: number;
  readonly select?: boolean;
  readonly center?: boolean;
}

export interface EditorScrollToPositionOptions {
  readonly select?: boolean;
  readonly center?: boolean;
}

export interface SaveHandler {
  save(payload: {
    source: string;
    reason: "manual" | "command" | "autosave";
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  readonly autosaveDebounceMs?: number;
  isBusy?(): boolean;
}

export interface StatusEvents {
  onSaveStart?(): void;
  onSaveSucceeded?(): void;
  onSaveFailed?(event: { readonly error: string }): void;
  onDirtyChange?(dirty: boolean): void;
}

export interface MountEditorOptions extends Omit<SimpleEditorConfig, "doc"> {
  readonly doc?: string;
  readonly onChange?: (doc: string) => void;
  readonly onDocumentChange?: (change: EditorDocumentChange) => void;
  readonly onCursorContextChange?: (context: PandocCursorContext) => void;
  readonly saveHandler?: SaveHandler;
  readonly statusEvents?: StatusEvents;
}

export interface MountedEditor {
  getDoc(): string;
  /** Return the CST snapshot paired with the current document. */
  getCst(): PandocCstSnapshot | null;
  getCursorContext(): PandocCursorContext | null;
  setDoc(doc: string): void;
  insertText(text: string, options?: EditorInsertTextOptions): void;
  getVisibleSourcePosition(
    options?: EditorVisibleSourcePositionOptions,
  ): EditorSourcePosition | null;
  scrollToSourcePosition(
    position: EditorSourcePosition | EditorScrollToSourcePositionOptions,
  ): void;
  scrollToLine(line: number, options?: EditorScrollToLineOptions): void;
  scrollToPosition(position: number, options?: EditorScrollToPositionOptions): void;
  focus(): void;
  isSaved(): boolean;
  triggerSave(reason?: "manual" | "command"): Promise<void>;
  unmount(): void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function positionForLine(view: EditorView, line: number, column = 1): number {
  const targetLine = view.state.doc.line(clamp(Math.floor(line), 1, view.state.doc.lines));
  return clamp(targetLine.from + Math.max(0, Math.floor(column) - 1), targetLine.from, targetLine.to);
}

function scrollToPosition(
  view: EditorView,
  position: number,
  options: EditorScrollToPositionOptions = {},
): void {
  const target = clamp(Math.floor(position), 0, view.state.doc.length);
  const select = options.select !== false;
  view.dispatch({
    selection: select ? EditorSelection.cursor(target) : undefined,
    effects: EditorView.scrollIntoView(
      target,
      options.center === false ? undefined : { y: "center" },
    ),
    scrollIntoView: select,
    userEvent: select ? "select" : undefined,
  });
}

function visibleSourcePosition(
  view: EditorView,
  options: EditorVisibleSourcePositionOptions = {},
): EditorSourcePosition {
  const viewportRatio = clamp(options.viewportRatio ?? 0.5, 0, 1);
  const rect = view.scrollDOM.getBoundingClientRect();
  const x = options.x ?? rect.left + Math.max(1, rect.width / 2);
  const y = options.y ?? rect.top + rect.height * viewportRatio;
  let position = view.viewport.from;
  try {
    position = view.posAtCoords({ x, y }, false) ?? position;
  } catch (_error) {
    // Lightweight DOM environments do not implement layout. The viewport
    // start is still a valid, deterministic source anchor.
  }
  const pos = clamp(position, 0, view.state.doc.length);
  return { pos, line: view.state.doc.lineAt(pos).number, viewportRatio };
}

/** Mount Coflat's only editor mode: editable CST-backed Pandoc Markdown. */
export function mountEditor(options: MountEditorOptions): MountedEditor {
  const initialDoc = options.doc ?? "";
  let view: EditorView | null = null;
  let currentDoc = initialDoc;
  let lastSavedDoc = initialDoc;
  let dirty = false;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSave: Promise<void> | null = null;

  const setDirty = (next: boolean): void => {
    if (next === dirty) return;
    dirty = next;
    options.statusEvents?.onDirtyChange?.(next);
  };

  const clearAutosave = (): void => {
    if (autosaveTimer === null) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  };

  const runSave = async (
    reason: "manual" | "command" | "autosave",
  ): Promise<void> => {
    const mountedView = view;
    const handler = options.saveHandler;
    if (!mountedView || !handler) return;
    while (pendingSave) await pendingSave;
    const source = mountedView.state.doc.toString();
    const run = (async () => {
      clearAutosave();
      options.statusEvents?.onSaveStart?.();
      try {
        const result = await handler.save({ source, reason });
        if (result.ok) {
          lastSavedDoc = source;
          setDirty(view?.state.doc.toString() !== lastSavedDoc);
          options.statusEvents?.onSaveSucceeded?.();
        } else {
          options.statusEvents?.onSaveFailed?.({ error: result.error });
        }
      } catch (error: unknown) {
        options.statusEvents?.onSaveFailed?.({ error: String(error) });
      } finally {
        pendingSave = null;
      }
    })();
    pendingSave = run;
    await run;
  };

  const scheduleAutosave = (): void => {
    clearAutosave();
    const handler = options.saveHandler;
    if (!handler || !dirty) return;
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      if (!dirty || handler.isBusy?.()) return;
      void runSave("autosave");
    }, handler.autosaveDebounceMs ?? 1500);
  };

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      const source = update.state.doc.toString();
      const tree = getPandocTree(update.state);
      if (source !== tree.text) {
        throw new Error("CodeMirror document and Pandoc CST snapshot diverged");
      }
      currentDoc = source;
      setDirty(source !== lastSavedDoc);
      scheduleAutosave();

      const isProgrammatic = update.transactions.some(
        (transaction) => transaction.annotation(programmaticDocumentChange) === true,
      );
      if (!isProgrammatic) {
        options.onChange?.(source);
        options.onDocumentChange?.({ changes: update.changes, tree });
      }
    }

    if (update.docChanged || update.selectionSet) {
      options.onCursorContextChange?.(getPandocCursorContext(update.state));
    }
  });

  const saveKeymap = keymap.of([{
    key: "Mod-s",
    preventDefault: Boolean(options.saveHandler),
    run: () => {
      if (!options.saveHandler) return false;
      void runSave("manual");
      return true;
    },
  }]);

  options.parent.replaceChildren();
  view = createSimpleEditor({
    parent: options.parent,
    doc: initialDoc,
    extensions: [
      updateListener,
      saveKeymap,
      ...(options.extensions ?? []),
    ],
  });

  return {
    getDoc() {
      return view?.state.doc.toString() ?? currentDoc;
    },

    getCst() {
      return view ? getPandocTree(view.state) : null;
    },

    getCursorContext() {
      return view ? getPandocCursorContext(view.state) : null;
    },

    setDoc(doc) {
      currentDoc = doc;
      if (!view) return;
      const previous = view.state.doc.toString();
      if (doc === previous) return;
      const preserveYamlEdit = isYamlMetadataActive(view.state);
      const change = minimalChange(previous, doc);
      view.dispatch({
        changes: change,
        annotations: programmaticDocumentChange.of(true),
        scrollIntoView: false,
      });
      const yamlEnd = getYamlMetadataEnd(view.state);
      if (
        !preserveYamlEdit
        && yamlEnd !== null
        && isYamlMetadataActive(view.state)
      ) {
        view.dispatch({
          selection: EditorSelection.cursor(yamlEnd),
          scrollIntoView: false,
        });
      }
    },

    insertText(text, insertOptions = {}) {
      if (!view || text.length === 0) return;
      const requestedPosition = insertOptions.position;
      if (typeof requestedPosition === "number" && Number.isFinite(requestedPosition)) {
        const position = clamp(Math.floor(requestedPosition), 0, view.state.doc.length);
        view.dispatch({
          changes: { from: position, insert: text },
          selection: EditorSelection.cursor(position + text.length),
          scrollIntoView: true,
          userEvent: "input",
        });
        return;
      }

      const transaction = view.state.changeByRange((range) => {
        const from = insertOptions.replaceSelection === false ? range.head : range.from;
        const to = insertOptions.replaceSelection === false ? range.head : range.to;
        return {
          changes: { from, to, insert: text },
          range: EditorSelection.cursor(from + text.length),
        };
      });
      view.dispatch(transaction, { scrollIntoView: true, userEvent: "input" });
    },

    getVisibleSourcePosition(visibleOptions) {
      return view ? visibleSourcePosition(view, visibleOptions) : null;
    },

    scrollToSourcePosition(position) {
      if (!view) return;
      const target = typeof position.pos === "number"
        ? position.pos
        : positionForLine(view, position.line ?? 1);
      scrollToPosition(view, target, {
        select: "select" in position ? position.select : undefined,
        center: "center" in position ? position.center : undefined,
      });
    },

    scrollToLine(line, scrollOptions = {}) {
      if (!view) return;
      scrollToPosition(
        view,
        positionForLine(view, line, scrollOptions.column),
        scrollOptions,
      );
    },

    scrollToPosition(position, scrollOptions) {
      if (view) scrollToPosition(view, position, scrollOptions);
    },

    focus() {
      view?.focus();
    },

    isSaved() {
      return !dirty;
    },

    async triggerSave(reason = "manual") {
      await runSave(reason);
    },

    unmount() {
      if (!view) return;
      clearAutosave();
      const mounted = view;
      view = null;
      mounted.destroy();
      options.parent.replaceChildren();
    },
  };
}

export { createSimpleEditor as createEditor };
