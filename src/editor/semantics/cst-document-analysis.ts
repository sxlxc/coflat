import type { Tree } from "@lezer/common";
import type { SyntaxTree } from "pandocmd-cst";
import { buildDocumentIR } from "../ir/document-ir-builder";
import type { DocumentIR } from "../ir/types";
import { classifyReferenceIndex } from "../references/classifier";
import type { DocumentAnalysis, TextSource } from "./document-model";
import {
  buildDocumentAnalysisBase,
  buildRevisionInfo,
  type DocumentAnalysisRevisionInfo,
  type DocumentAnalysisSliceName,
  type DocumentAnalysisSlices,
  type IncrementalDocumentAnalysisState,
  ZERO_REVISION_INFO,
} from "./incremental/slice-registry";

export type {
  DocumentAnalysisRevisionInfo,
  DocumentAnalysisSliceName,
  DocumentAnalysisSliceRevisions,
} from "./incremental/slice-registry";
import {
  buildSlicesAndExcludedRanges,
  createDocumentAnalysisSnapshotValue,
  type DocumentAnalysisSnapshot,
} from "./incremental/snapshot-finalize";
import { createHeadingSlice } from "./incremental/slices/heading-slice";
import { createMathSlice } from "./incremental/slices/math-slice";

export interface CstDocumentAnalysisSnapshot extends DocumentAnalysisSnapshot {
  /** The exact authoritative CST version from which this projection was built. */
  readonly cstVersion: number;
}

export interface DocumentArtifacts {
  readonly analysis: DocumentAnalysis;
  readonly analysisSnapshot: CstDocumentAnalysisSnapshot;
  readonly ir: DocumentIR;
}

function structuralEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => structuralEqual(value, right[index]));
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
    for (const [key, value] of left) {
      if (!right.has(key) || !structuralEqual(value, right.get(key))) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(rightRecord, key) && structuralEqual(leftRecord[key], rightRecord[key]));
}

function reuseUnchangedSlices(
  previous: IncrementalDocumentAnalysisState | undefined,
  next: DocumentAnalysisSlices,
): DocumentAnalysisSlices {
  if (!previous) return next;
  const headingSlice = structuralEqual(previous.headingSlice, next.headingSlice)
    ? previous.headingSlice
    : createHeadingSlice(reuseUnchangedRangeValues(
      previous.headingSlice.headings,
      next.headingSlice.headings,
    ));
  const mathSlice = structuralEqual(previous.mathSlice, next.mathSlice)
    ? previous.mathSlice
    : createMathSlice(reuseUnchangedRangeValues(
      previous.mathSlice.mathRegions,
      next.mathSlice.mathRegions,
    ));
  return {
    headingSlice,
    footnoteSlice: structuralEqual(previous.footnoteSlice, next.footnoteSlice) ? previous.footnoteSlice : next.footnoteSlice,
    fencedDivSlice: structuralEqual(previous.fencedDivSlice, next.fencedDivSlice) ? previous.fencedDivSlice : next.fencedDivSlice,
    equationSlice: structuralEqual(previous.equationSlice, next.equationSlice) ? previous.equationSlice : next.equationSlice,
    mathSlice,
    referenceSlice: structuralEqual(previous.referenceSlice, next.referenceSlice) ? previous.referenceSlice : next.referenceSlice,
  };
}

function reuseUnchangedRangeValues<T extends { readonly from: number; readonly to: number }>(
  previous: readonly T[],
  next: readonly T[],
): readonly T[] {
  const previousByRange = new Map(
    previous.map(value => [`${value.from}:${value.to}`, value]),
  );
  let reusedAny = false;
  const values = next.map(value => {
    const candidate = previousByRange.get(`${value.from}:${value.to}`);
    if (candidate && structuralEqual(candidate, value)) {
      reusedAny = true;
      return candidate;
    }
    return value;
  });
  return reusedAny ? values : next;
}

/**
 * Build Coflat's host-level semantic projection from one complete CST
 * snapshot. This is synchronous and version-bound; it has no parser frontier,
 * pending regions, or shadow Markdown document.
 */
export function createProjectedDocumentAnalysisSnapshot(
  doc: TextSource,
  projectedTree: Tree,
  cstVersion: number,
  previous?: CstDocumentAnalysisSnapshot,
): CstDocumentAnalysisSnapshot {
  const built = buildSlicesAndExcludedRanges(doc, projectedTree);
  const slices = reuseUnchangedSlices(previous?.incrementalState, built.slices);
  const analysisBase = buildDocumentAnalysisBase(slices);
  const referenceIndex = classifyReferenceIndex(doc, analysisBase);
  const analysis: DocumentAnalysis = { ...analysisBase, referenceIndex };
  const revisions = buildRevisionInfo(previous?.incrementalState, slices);
  const incrementalState: IncrementalDocumentAnalysisState = {
    ...slices,
    revisions,
    excludedRanges: built.excludedRanges,
    referenceIndex,
    pendingRegions: Object.freeze([]),
  };
  const snapshot = createDocumentAnalysisSnapshotValue(analysis, incrementalState) as CstDocumentAnalysisSnapshot;
  Object.defineProperty(snapshot, "cstVersion", {
    value: cstVersion,
    enumerable: true,
  });
  return Object.freeze(snapshot);
}

export function createCstDocumentAnalysisSnapshot(
  doc: TextSource,
  projectedTree: Tree,
  cst: SyntaxTree,
  previous?: CstDocumentAnalysisSnapshot,
): CstDocumentAnalysisSnapshot {
  return createProjectedDocumentAnalysisSnapshot(
    doc,
    projectedTree,
    cst.version,
    previous,
  );
}

export function buildCstDocumentArtifacts(
  doc: TextSource,
  projectedTree: Tree,
  snapshot: CstDocumentAnalysisSnapshot,
): DocumentArtifacts {
  return {
    analysis: snapshot.analysis,
    analysisSnapshot: snapshot,
    ir: buildDocumentIR({
      analysis: snapshot.analysis,
      doc,
      docText: doc.slice(0, doc.length),
      tree: projectedTree,
    }),
  };
}

export function getDocumentAnalysisRevisionInfo(
  analysis: DocumentAnalysis | DocumentAnalysisSnapshot,
): DocumentAnalysisRevisionInfo {
  return "incrementalState" in analysis
    ? analysis.incrementalState.revisions
    : ZERO_REVISION_INFO;
}

export function getDocumentAnalysisRevision(
  analysis: DocumentAnalysis | DocumentAnalysisSnapshot,
): number {
  return getDocumentAnalysisRevisionInfo(analysis).revision;
}

export function getDocumentAnalysisSliceRevision(
  analysis: DocumentAnalysis | DocumentAnalysisSnapshot,
  slice: DocumentAnalysisSliceName,
): number {
  return getDocumentAnalysisRevisionInfo(analysis).slices[slice];
}
