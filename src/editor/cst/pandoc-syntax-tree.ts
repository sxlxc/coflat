import type { EditorState } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import {
  parsePandocCstSource,
  projectPandocSyntaxTree,
} from "../../core/cst/pandoc-syntax-tree.js";
import { getPandocTree } from "./pandoc-cst-field.js";

const projectedTrees = new WeakMap<object, Tree>();

/** Return the complete CST-derived traversal tree for a CodeMirror state. */
export function getPandocSyntaxTree(state: EditorState): Tree {
  const source = getPandocTree(state);
  let result = projectedTrees.get(source as object);
  if (!result) {
    result = projectPandocSyntaxTree(source);
    projectedTrees.set(source as object, result);
  }
  return result;
}

/** CST snapshots are synchronous and always cover the complete document. */
export function pandocSyntaxTreeAvailable(state: EditorState, to = state.doc.length): boolean {
  return to >= 0 && to <= getPandocTree(state).length;
}

/** Return the complete synchronous CST projection when it covers `to`. */
export function ensurePandocSyntaxTree(state: EditorState, to = state.doc.length, _timeout = 0): Tree | null {
  return pandocSyntaxTreeAvailable(state, to) ? getPandocSyntaxTree(state) : null;
}

export { parsePandocCstSource };
