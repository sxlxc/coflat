import { PandocParser, type SyntaxTree, type TextChange } from "pandocmd-cst";
import { projectPandocSyntaxTree } from "../../../core/cst/pandoc-syntax-tree";
import {
  buildCstDocumentArtifacts,
  createCstDocumentAnalysisSnapshot,
  type CstDocumentAnalysisSnapshot,
  type DocumentArtifacts,
} from "../cst-document-analysis";
import { type DocumentAnalysis, stringTextSource } from "../document-model";
import { createDocumentAnalysisSnapshotFromAnalysis } from "./snapshot-finalize";

/**
 * Bounded standalone cache for reader/indexer callers. It uses the same
 * authoritative CST parser as the editor and publishes one complete semantic
 * snapshot per text version; there is no parse frontier or pending analysis.
 */
export interface CachedDocumentAnalysis {
  readonly version: number;
  readonly text: string;
  readonly analysis: DocumentAnalysis;
  readonly snapshot: CstDocumentAnalysisSnapshot;
  readonly parser: PandocParser;
  readonly tree: SyntaxTree;
}

export interface CachedDocumentArtifacts {
  readonly version: number;
  readonly text: string;
  readonly artifacts: DocumentArtifacts;
  readonly analysis: CachedDocumentAnalysis;
}

const MAX_SHARED_DOCUMENT_ANALYSIS_ENTRIES = 64;
const sharedDocumentAnalysisCache = new Map<string, CachedDocumentAnalysis>();
const sharedDocumentArtifactsCache = new Map<string, CachedDocumentArtifacts>();

function singleTextChange(previousText: string, nextText: string): TextChange {
  let prefix = 0;
  const prefixLimit = Math.min(previousText.length, nextText.length);
  while (
    prefix < prefixLimit
    && previousText.charCodeAt(prefix) === nextText.charCodeAt(prefix)
  ) prefix++;

  let oldSuffix = previousText.length;
  let newSuffix = nextText.length;
  while (
    oldSuffix > prefix
    && newSuffix > prefix
    && previousText.charCodeAt(oldSuffix - 1) === nextText.charCodeAt(newSuffix - 1)
  ) {
    oldSuffix--;
    newSuffix--;
  }
  return { oldFrom: prefix, oldTo: oldSuffix, newFrom: prefix, newTo: newSuffix };
}

function createCached(
  text: string,
  previous?: CachedDocumentAnalysis,
): CachedDocumentAnalysis {
  if (previous?.text === text) return previous;

  const parser = previous?.parser ?? new PandocParser();
  const tree = previous
    ? parser.update(text, previous.tree, [singleTextChange(previous.text, text)]).tree
    : parser.parse(text);
  const doc = stringTextSource(text);
  const projectedTree = projectPandocSyntaxTree(tree);
  const snapshot = createCstDocumentAnalysisSnapshot(
    doc,
    projectedTree,
    tree,
    previous?.snapshot,
  );
  return {
    version: previous ? previous.version + 1 : 0,
    text,
    analysis: snapshot.analysis,
    snapshot,
    parser,
    tree,
  };
}

export function getCachedDocumentAnalysis(
  text: string,
  previous?: CachedDocumentAnalysis,
): CachedDocumentAnalysis {
  return createCached(text, previous);
}

export function rememberCachedDocumentAnalysis(
  text: string,
  analysis: DocumentAnalysis | CstDocumentAnalysisSnapshot,
  previous?: CachedDocumentAnalysis,
): CachedDocumentAnalysis {
  const adoptedAnalysis = "analysis" in analysis ? analysis.analysis : analysis;
  if (previous?.text === text && previous.analysis === adoptedAnalysis) return previous;

  const parsed = createCached(text, previous?.text === text ? undefined : previous);
  if (parsed.analysis === adoptedAnalysis) return parsed;
  const doc = stringTextSource(text);
  const projectedTree = projectPandocSyntaxTree(parsed.tree);
  const base = createDocumentAnalysisSnapshotFromAnalysis(
    doc,
    projectedTree,
    adoptedAnalysis,
  ) as CstDocumentAnalysisSnapshot;
  Object.defineProperty(base, "cstVersion", {
    value: parsed.tree.version,
    enumerable: true,
  });
  const snapshot = Object.freeze(base);
  return { ...parsed, analysis: adoptedAnalysis, snapshot };
}

export function getCachedDocumentArtifacts(
  text: string,
  previous?: CachedDocumentArtifacts,
): CachedDocumentArtifacts {
  if (previous?.text === text) return previous;
  const analysis = createCached(text, previous?.analysis);
  const doc = stringTextSource(text);
  const artifacts = buildCstDocumentArtifacts(
    doc,
    projectPandocSyntaxTree(analysis.tree),
    analysis.snapshot,
  );
  return { version: analysis.version, text, artifacts, analysis };
}

export function getDocumentAnalysis(
  text: string,
  cacheKey?: string,
): DocumentAnalysis {
  return getDocumentAnalysisSnapshot(text, cacheKey).analysis;
}

export function getDocumentAnalysisSnapshot(
  text: string,
  cacheKey?: string,
): CstDocumentAnalysisSnapshot {
  const key = normalizeCacheKey(cacheKey);
  if (!key) return createCached(text).snapshot;
  const cached = createCached(text, lruGet(sharedDocumentAnalysisCache, key));
  lruSet(sharedDocumentAnalysisCache, key, cached);
  const artifacts = sharedDocumentArtifactsCache.get(key);
  if (artifacts?.text !== text || artifacts.analysis !== cached) {
    sharedDocumentArtifactsCache.delete(key);
  }
  return cached.snapshot;
}

export function getDocumentArtifacts(
  text: string,
  cacheKey?: string,
): DocumentArtifacts {
  const key = normalizeCacheKey(cacheKey);
  if (!key) return getCachedDocumentArtifacts(text).artifacts;

  const cachedArtifacts = lruGet(sharedDocumentArtifactsCache, key);
  if (cachedArtifacts?.text === text) return cachedArtifacts.artifacts;
  const analysis = createCached(text, lruGet(sharedDocumentAnalysisCache, key));
  lruSet(sharedDocumentAnalysisCache, key, analysis);
  const doc = stringTextSource(text);
  const artifacts = buildCstDocumentArtifacts(
    doc,
    projectPandocSyntaxTree(analysis.tree),
    analysis.snapshot,
  );
  lruSet(sharedDocumentArtifactsCache, key, {
    version: analysis.version,
    text,
    artifacts,
    analysis,
  });
  return artifacts;
}

export function rememberDocumentAnalysis(
  text: string,
  analysis: DocumentAnalysis | CstDocumentAnalysisSnapshot,
  cacheKey?: string,
): DocumentAnalysis {
  return rememberDocumentAnalysisSnapshot(text, analysis, cacheKey).analysis;
}

export function rememberDocumentAnalysisSnapshot(
  text: string,
  analysis: DocumentAnalysis | CstDocumentAnalysisSnapshot,
  cacheKey?: string,
): CstDocumentAnalysisSnapshot {
  const key = normalizeCacheKey(cacheKey);
  const cached = rememberCachedDocumentAnalysis(
    text,
    analysis,
    key ? lruGet(sharedDocumentAnalysisCache, key) : undefined,
  );
  if (key) {
    lruSet(sharedDocumentAnalysisCache, key, cached);
    sharedDocumentArtifactsCache.delete(key);
  }
  return cached.snapshot;
}

export function clearDocumentAnalysisCache(): void {
  sharedDocumentAnalysisCache.clear();
  sharedDocumentArtifactsCache.clear();
}

function normalizeCacheKey(cacheKey?: string): string | undefined {
  return cacheKey && cacheKey.length > 0 ? cacheKey : undefined;
}

function lruGet<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function lruSet<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.set(key, value);
  while (cache.size > MAX_SHARED_DOCUMENT_ANALYSIS_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
