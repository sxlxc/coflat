/**
 * Centralized block type manifest — single source of truth for all block types.
 *
 * Every block plugin, CSS rule, and counter group derives from this manifest.
 * Adding a new block type means adding one entry here; downstream code
 * auto-generates theme rules and counter groups.
 */

/** Body font style for a block type. */
export type BodyStyle = "italic" | "normal";

/** Special rendering behaviors a block type can have. */
export type SpecialBehavior = "qed" | "blockquote";

/** Fenced-div renderer family for a block type. */
export type BlockPresentationKind =
  | "blockquote"
  | "captioned"
  | "standard";

/** How a block participates in LaTeX export. */
export type LatexExportKind =
  | "algo"
  | "algorithm"
  | "blockquote"
  | "environment"
  | "equation"
  | "figure"
  | "none"
  | "table";

/**
 * How the body of a fenced div is parsed.
 *
 * - "markdown" (default): body parses as regular markdown blocks.
 * - "lines": each physical line is one `AlgoLine` node with inline content
 *   (math, emphasis, ...) and indentation carried by leading whitespace.
 *   The div parses as a `LineFencedDiv` composite instead of `FencedDiv`.
 */
export type BlockBodyMode = "lines" | "markdown";

/** Where the caption/header label is placed relative to block content. */
export type CaptionPosition = "above" | "below";

/** Whether the header label sits on its own block line or inline with content. */
export type HeaderPosition = "block" | "inline";

/** Manifest entry describing a single block type. */
export interface BlockManifestEntry {
  /** Block class name (e.g. "theorem"). */
  readonly name: string;
  /** Counter group this block belongs to. Undefined = unnumbered. */
  readonly counterGroup?: string;
  /** Whether this block type is auto-numbered. */
  readonly numbered: boolean;
  /** Body font style (italic for theorem-family, normal for others). */
  readonly bodyStyle: BodyStyle;
  /** Special rendering behavior, if any. */
  readonly specialBehavior?: SpecialBehavior;
  /** How the div body is parsed. Defaults to "markdown". */
  readonly bodyMode?: BlockBodyMode;
  /** LaTeX export strategy for this block type. Defaults to "environment". */
  readonly latexExportKind?: LatexExportKind;
  /** LaTeX environment name when latexExportKind is "environment". */
  readonly latexEnvironment?: string;
  /** Whether this block appears in semantic search type filters. Defaults to true. */
  readonly searchIndexed?: boolean;
  /** Where caption is placed. Defaults to "above". */
  readonly captionPosition?: CaptionPosition;
  /** Whether the rendered header is block-level or inline with the first body line. */
  readonly headerPosition?: HeaderPosition;
  /**
   * Display title for the rendered header. Defaults to the name with
   * the first letter capitalized. Override when the default capitalization
   * is wrong.
   */
  readonly title?: string;
  /**
   * Whether to show a rendered header label. Defaults to true.
   * Set to false for blocks like blockquote that render as styled
   * content without a label.
   */
  readonly displayHeader?: boolean;
}

/**
 * The complete block manifest.
 *
 * Order matches the registration order in default-plugins.ts.
 * The editor's one fenced-div counter is shared by theorem, lemma,
 * corollary, proposition, figure, and table. Every other div is unnumbered.
 */
export const BLOCK_MANIFEST = [
  // Document prose blocks — unnumbered
  { name: "abstract",   counterGroup: undefined,    numbered: false, bodyStyle: "normal", latexExportKind: "none", searchIndexed: false },

  // Theorem family — shared counter, italic body
  { name: "theorem",     counterGroup: "numbered-block", numbered: true,  bodyStyle: "italic", latexExportKind: "environment", latexEnvironment: "theorem" },
  { name: "lemma",       counterGroup: "numbered-block", numbered: true,  bodyStyle: "italic", latexExportKind: "environment", latexEnvironment: "lemma" },
  { name: "corollary",   counterGroup: "numbered-block", numbered: true,  bodyStyle: "italic", latexExportKind: "environment", latexEnvironment: "corollary" },
  { name: "proposition", counterGroup: "numbered-block", numbered: true,  bodyStyle: "italic", latexExportKind: "environment", latexEnvironment: "proposition" },
  { name: "conjecture",  counterGroup: undefined,        numbered: false, bodyStyle: "italic", latexExportKind: "environment", latexEnvironment: "conjecture" },

  // Other theorem-like blocks — unnumbered
  { name: "definition",  counterGroup: undefined, numbered: false, bodyStyle: "normal", latexExportKind: "environment", latexEnvironment: "definition" },

  { name: "problem",     counterGroup: undefined, numbered: false, bodyStyle: "normal", latexExportKind: "environment", latexEnvironment: "problem" },

  // Unnumbered blocks — no counter
  { name: "proof",       counterGroup: undefined,    numbered: false, bodyStyle: "normal", specialBehavior: "qed", headerPosition: "inline", latexExportKind: "environment", latexEnvironment: "proof" },
  { name: "remark",      counterGroup: undefined,    numbered: false, bodyStyle: "normal", latexExportKind: "environment", latexEnvironment: "remark" },
  { name: "example",     counterGroup: undefined,    numbered: false, bodyStyle: "normal", latexExportKind: "environment", latexEnvironment: "example" },

  // Algorithms — unnumbered
  { name: "algorithm",   counterGroup: undefined, numbered: false, bodyStyle: "normal", latexExportKind: "algorithm" },

  // Erickson-style pseudocode — line-mode body
  // (one AlgoLine per physical line, indentation = leading whitespace)
  { name: "algo",        counterGroup: undefined, numbered: false, bodyStyle: "normal", bodyMode: "lines", title: "Algorithm", latexExportKind: "algo" },

  // Figure and table — shared counter, caption below content
  { name: "figure",      counterGroup: "numbered-block", numbered: true, bodyStyle: "normal", captionPosition: "below", latexExportKind: "figure" },

  { name: "table",       counterGroup: "numbered-block", numbered: true, bodyStyle: "normal", captionPosition: "below", latexExportKind: "table" },

  // Structural wrapper that gives its sole display-math child a label.
  { name: "equation",    counterGroup: undefined, numbered: false, bodyStyle: "normal", displayHeader: false, latexExportKind: "equation", searchIndexed: false },

  // Blockquote — unnumbered, special rendering, no header label
  { name: "blockquote",  counterGroup: undefined,    numbered: false, bodyStyle: "normal", specialBehavior: "blockquote", displayHeader: false, latexExportKind: "blockquote", searchIndexed: false },

] as const satisfies readonly BlockManifestEntry[];

/** Union type of all known block names. */
export type BlockName = (typeof BLOCK_MANIFEST)[number]["name"];

/**
 * Counter groups derived from the manifest.
 *
 * Maps each counter group name to the list of block names that share it.
 */
export const COUNTER_GROUPS: Readonly<Record<string, readonly BlockName[]>> = (() => {
  const groups: Record<string, BlockName[]> = {};
  for (const entry of BLOCK_MANIFEST) {
    if (entry.counterGroup) {
      (groups[entry.counterGroup] ??= []).push(entry.name);
    }
  }
  return groups;
})();

/**
 * BLOCK_MANIFEST typed as readonly BlockManifestEntry[] for property access.
 *
 * BLOCK_MANIFEST itself is inferred as a const tuple of narrow literal types,
 * so accessing optional properties like `specialBehavior` requires this alias.
 */
export const BLOCK_MANIFEST_ENTRIES: readonly BlockManifestEntry[] = BLOCK_MANIFEST;

/** @internal convenience alias used within this module */
const entries: readonly BlockManifestEntry[] = BLOCK_MANIFEST_ENTRIES;

export const BLOCK_MANIFEST_BY_NAME: ReadonlyMap<string, BlockManifestEntry> = new Map(
  BLOCK_MANIFEST_ENTRIES.map((entry) => [entry.name, entry] as const),
);

export function getBlockManifestEntry(blockType: string | undefined): BlockManifestEntry | undefined {
  return blockType ? BLOCK_MANIFEST_BY_NAME.get(blockType) : undefined;
}

export function isCollapsibleBlockType(blockType: string | undefined): boolean {
  const entry = getBlockManifestEntry(blockType);
  return Boolean(
    blockType
    && (entry?.latexExportKind === "environment" || entry?.latexExportKind === "algo")
    && entry.headerPosition !== "inline"
    && entry.displayHeader !== false,
  );
}

export function isKnownManifestBlockType(blockType: string): boolean {
  return BLOCK_MANIFEST_BY_NAME.has(blockType);
}

/** Block classes whose div bodies parse line-by-line (`bodyMode: "lines"`). */
export const LINE_MODE_BLOCK_CLASSES: ReadonlySet<string> = new Set(
  BLOCK_MANIFEST_ENTRIES.filter((entry) => entry.bodyMode === "lines").map((entry) => entry.name),
);

/**
 * Whether a fenced-div class parses its body in line mode.
 *
 * Consulted by the parser when an opening fence is recognized, so the
 * decision is per-class and static for a given build of the manifest.
 */
export function isLineModeBlockClass(blockType: string): boolean {
  return LINE_MODE_BLOCK_CLASSES.has(blockType);
}

export function getManifestBlockTitle(entry: BlockManifestEntry): string {
  return entry.title ?? `${entry.name.slice(0, 1).toUpperCase()}${entry.name.slice(1)}`;
}

export function getBlockPresentationKind(blockType: string): BlockPresentationKind {
  const entry = getBlockManifestEntry(blockType);
  if (entry?.specialBehavior === "blockquote") {
    return "blockquote";
  }
  if (entry?.captionPosition === "below") {
    return "captioned";
  }
  return "standard";
}

export function isSearchIndexedBlock(entry: BlockManifestEntry): boolean {
  return entry.searchIndexed ?? true;
}

export function isGenericFencedDivInsertBlock(_entry: BlockManifestEntry): boolean {
  return true;
}

/**
 * Block names excluded from fallback plugin generation.
 *
 * Explicitly empty: non-canonical legacy classes such as `include` now render
 * as ordinary fenced divs if they appear in old documents.
 */
export const EXCLUDED_FROM_FALLBACK: ReadonlySet<string> = new Set();

/**
 * Block names that have per-type accent CSS variables and body style CSS variables.
 *
 * Excludes blockquote, which doesn't use the standard
 * `--cf-block-{type}-accent` / `--cf-block-{type}-style` pattern.
 */
export const STYLED_BLOCK_NAMES: readonly string[] = entries
  .filter((e) => e.specialBehavior !== "blockquote")
  .map((e) => e.name);

export const LATEX_ENVIRONMENT_BY_BLOCK: ReadonlyMap<string, string> = new Map(
  BLOCK_MANIFEST_ENTRIES
    .filter((entry) => entry.latexExportKind === "environment" && entry.latexEnvironment)
    .map((entry) => [entry.name, entry.latexEnvironment ?? entry.name] as const),
);

/** Shared counter group name for all numbered fenced divs. */
export const NUMBERED_BLOCK_COUNTER = "numbered-block";

/** @deprecated Use NUMBERED_BLOCK_COUNTER. */
export const THEOREM_COUNTER = NUMBERED_BLOCK_COUNTER;

/** Legacy counter group name retained for compatibility. */
export const DEFINITION_COUNTER = "definition";

/** Legacy counter group name retained for compatibility. */
export const ALGORITHM_COUNTER = "algorithm";

/** Shared counter group name for numbered figure blocks. */
export const FIGURE_COUNTER = NUMBERED_BLOCK_COUNTER;

/** Shared counter group name for numbered table blocks. */
export const TABLE_COUNTER = NUMBERED_BLOCK_COUNTER;
