/**
 * CM6 StateField that parses and caches frontmatter configuration.
 *
 * Provides `FrontmatterConfig` to other extensions via
 * `state.field(frontmatterField)`.
 *
 * Rendering (Typora-style title widget / YAML reveal) lives in
 * `render/frontmatter-render.ts`.
 */
import { EditorState, StateField } from "@codemirror/state";

import {
  type BlockConfig,
  type FrontmatterConfig,
  type FrontmatterResult,
  type FrontmatterStatus,
  parseFrontmatterFromTree,
} from "../../core/parser/frontmatter";
import { getPandocTree } from "../cst";
import { mergeConfigs, projectConfigFacet } from "../project-config";

export { type FrontmatterConfig, type NumberingScheme } from "../../core/parser/frontmatter";

/** State stored in the frontmatter field. */
export interface FrontmatterState {
  /** Parsed configuration from the frontmatter. */
  config: FrontmatterConfig;
  /** Character offset where the frontmatter ends (-1 if none). */
  end: number;
  /** Structured parse status for diagnostics. */
  status: FrontmatterStatus;
  /** Increments only when the merged `blocks` config changes semantically. */
  blocksRevision: number;
}

interface FrontmatterStateInternal extends FrontmatterState {
  readonly blocksKey: string;
}

/** Parse frontmatter from an EditorState's document. */
function parseFrontmatterFromState(state: EditorState): FrontmatterResult {
  // YAML parsing is scoped to the CST-owned opaque body and cannot alter
  // Markdown boundaries.
  return parseFrontmatterFromTree(getPandocTree(state));
}

function normalizeBlockConfig(config: BlockConfig): BlockConfig {
  const normalized: BlockConfig = {};
  if (config.counter !== undefined) normalized.counter = config.counter;
  if (config.numbered !== undefined) normalized.numbered = config.numbered;
  if (config.title !== undefined) normalized.title = config.title;
  return normalized;
}

function serializeBlocksConfig(blocks: FrontmatterConfig["blocks"]): string {
  if (!blocks) return "";
  const names = Object.keys(blocks).sort();
  if (names.length === 0) return "";
  return JSON.stringify(names.map((name) => {
    const value = blocks[name];
    return [
      name,
      typeof value === "boolean" ? value : normalizeBlockConfig(value),
    ];
  }));
}

function buildFrontmatterState(
  state: EditorState,
  previous?: FrontmatterStateInternal,
): FrontmatterStateInternal {
  const result = parseFrontmatterFromState(state);
  const project = state.facet(projectConfigFacet);
  const config = mergeConfigs(project, result.config);
  const blocksKey = serializeBlocksConfig(config.blocks);
  const blocksRevision = previous && previous.blocksKey !== blocksKey
    ? previous.blocksRevision + 1
    : previous?.blocksRevision ?? 0;
  return { config, end: result.end, status: result.status, blocksRevision, blocksKey };
}

/**
 * CM6 StateField holding the parsed frontmatter config.
 *
 * Usage:
 * ```ts
 * const config = state.field(frontmatterField).config;
 * ```
 */
export const frontmatterField = StateField.define<FrontmatterStateInternal>({
  create(state) {
    return buildFrontmatterState(state);
  },

  update(value, tr) {
    if (!tr.docChanged) return value;

    let affectsFrontmatter = false;

    if (value.end === -1) {
      const startsWithDelimiter = tr.state.doc.length >= 3
        && (
          tr.state.doc.sliceString(0, 3) === "---"
          || tr.state.doc.sliceString(0, 4) === "\ufeff---"
        );
      tr.changes.iterChangedRanges((fromA) => {
        if (fromA === 0 || startsWithDelimiter) affectsFrontmatter = true;
      });
    } else {
      // When the closing `---` is the final line with no trailing newline,
      // value.end === doc.length and edits appended at the end (fromA === end)
      // extend the closing delimiter line itself, so they must invalidate the
      // cached config. A frontmatter-only doc that ends in a newline also has
      // value.end === doc.length, but there an append starts a fresh body line
      // and must NOT invalidate — so require the char before value.end to not be
      // a newline to isolate the genuine unterminated-closer case.
      const closerUnterminated =
        value.end === tr.startState.doc.length &&
        (value.end === 0 ||
          tr.startState.doc.sliceString(value.end - 1, value.end) !== "\n");
      tr.changes.iterChangedRanges((fromA) => {
        if (fromA < value.end || (closerUnterminated && fromA === value.end)) {
          affectsFrontmatter = true;
        }
      });
    }

    if (!affectsFrontmatter) return value;

    return buildFrontmatterState(tr.state, value);
  },
});
