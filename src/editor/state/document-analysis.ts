import { getPandocSyntaxTree, getPandocTree } from "../cst";
import { type EditorState, StateField, type Text } from "@codemirror/state";
import { measureSync } from "../lib/perf";
import type { DocumentAnalysis, TextSource } from "../semantics/document";
import {
  createCstDocumentAnalysisSnapshot,
  type CstDocumentAnalysisSnapshot,
  type DocumentAnalysisRevisionInfo,
  type DocumentAnalysisSliceName,
  type DocumentAnalysisSliceRevisions,
  getDocumentAnalysisRevision,
  getDocumentAnalysisRevisionInfo,
  getDocumentAnalysisSliceRevision,
} from "../semantics/cst-document-analysis";

const MATERIALIZE_TEXT_AFTER_SLICE_CALLS = 8;

/**
 * Materialized full-document strings, cached per immutable `Text` instance.
 * `Text` is shared across every transaction and field on the same document
 * version, so tree-progress ticks (doc unchanged) materialize at most once
 * per document version instead of once per transaction.
 */
const materializedDocText = new WeakMap<Text, string>();

function lineAtInText(text: string, pos: number) {
  const safePos = Math.max(0, Math.min(pos, text.length));
  const from = Math.max(0, text.lastIndexOf("\n", Math.max(0, safePos - 1)) + 1);
  const nextBreak = text.indexOf("\n", safePos);
  const to = nextBreak === -1 ? text.length : nextBreak;
  return {
    from,
    to,
    text: text.slice(from, to),
  };
}

export function editorStateTextSource(state: EditorState): TextSource {
  const doc = state.doc;
  let materializedText = materializedDocText.get(doc);
  let sliceCalls = 0;

  function getMaterializedText(): string {
    if (materializedText === undefined) {
      materializedText = measureSync(
        "cm6.documentAnalysis.text.materialize",
        () => doc.toString(),
      );
      materializedDocText.set(doc, materializedText);
    }
    return materializedText;
  }

  return {
    length: doc.length,
    slice(from, to) {
      if (materializedText !== undefined) {
        return materializedText.slice(from, to);
      }
      if (from === 0 && to === doc.length) {
        // A full-document read costs the same as materializing; cache it.
        return getMaterializedText();
      }
      sliceCalls++;
      if (sliceCalls >= MATERIALIZE_TEXT_AFTER_SLICE_CALLS) {
        return getMaterializedText().slice(from, to);
      }
      return doc.sliceString(from, to);
    },
    lineAt(pos) {
      if (materializedText !== undefined) {
        return lineAtInText(materializedText, pos);
      }
      const line = doc.lineAt(pos);
      return {
        from: line.from,
        to: line.to,
        text: line.text,
      };
    },
  };
}

function buildDocumentAnalysis(
  state: EditorState,
  previous?: CstDocumentAnalysisSnapshot,
): CstDocumentAnalysisSnapshot {
  return measureSync("cm6.documentAnalysis.cstProjection", () =>
    createCstDocumentAnalysisSnapshot(
      editorStateTextSource(state),
      getPandocSyntaxTree(state),
      getPandocTree(state),
      previous,
    )
  );
}

/**
 * Shared CM6 StateField that computes document semantics once per
 * document/tree change. All CM6 renderers (section numbers, sidenotes,
 * block rendering, block counters) read from this field instead of
 * independently walking the syntax tree.
 */
export const documentAnalysisField = StateField.define<CstDocumentAnalysisSnapshot>({
  create(state) {
    return buildDocumentAnalysis(state);
  },

  update(value, tr) {
    const cst = getPandocTree(tr.state);
    // The shipped editor installs pandocCstField, whose parser instance gives
    // every changed snapshot a monotonic version. Feature-isolated tests and
    // third-party extension harnesses may install this field alone; their
    // detached one-shot CSTs all start at version 1, so a document change must
    // still force the projection to be rebuilt.
    if (!tr.docChanged && cst.version === value.cstVersion) return value;
    return buildDocumentAnalysis(tr.state, value);
  },
});

export function documentAnalysisFromSnapshot(
  snapshot: CstDocumentAnalysisSnapshot | null | undefined,
): DocumentAnalysis | undefined {
  return snapshot?.analysis;
}

export {
  type DocumentAnalysisRevisionInfo,
  type DocumentAnalysisSliceName,
  type DocumentAnalysisSliceRevisions,
  getDocumentAnalysisRevision,
  getDocumentAnalysisRevisionInfo,
  getDocumentAnalysisSliceRevision,
};
