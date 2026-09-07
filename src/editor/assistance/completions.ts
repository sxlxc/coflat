import {
  acceptCompletion,
  autocompletion,
  clearSnippet,
  type Completion,
  CompletionContext,
  completionKeymap,
  completionStatus,
  type CompletionResult,
  nextSnippetField,
  prevSnippetField,
  snippetCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import { type Extension, Prec } from "@codemirror/state";
import { keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { fenceClosed, type NodeKind, type SyntaxNode } from "pandocmd-cst";
import { getBibliographyStatus, getCitationItems } from "../citations/citation-surface";
import { resolvePandocNode } from "../cst/cursor-context";
import { getDocumentPresentation } from "../cst/document-presentation";
import { getPandocTree } from "../cst/pandoc-cst-field";
import { getReferenceCandidates } from "./references";

export interface CompletionOptions {
  readonly references: boolean;
  readonly snippets: boolean;
  readonly activateOnTyping: boolean;
}

const EXCLUDED_KINDS: ReadonlySet<NodeKind> = new Set([
  "Code", "Math", "FencedCodeBlock", "IndentedCodeBlock", "RawBlock", "RawInline",
  "YamlMetadata", "PandocTitleBlock", "LinkDestination", "LinkTitle", "AutoLink",
  "ReferenceDefinition", "ReferenceLabel", "AttributeList", "Attribute", "HtmlTag",
  "OpaqueBody", "Escape", "FootnoteReference", "Identifier",
]);

const PROSE_KINDS: ReadonlySet<NodeKind> = new Set([
  "Paragraph", "Plain", "AtxHeading", "SetextHeading", "DefinitionTerm",
  "LineBlockLine", "TableCell", "TableCaption", "FootnoteDefinition",
]);

/** CST ancestry decides where editing assistance is meaningful. */
function proseContext(context: CompletionContext, position: number): readonly SyntaxNode[] | null {
  const tree = getPandocTree(context.state);
  const path: SyntaxNode[] = [];
  const line = context.state.doc.lineAt(position);
  // At a blank line's start, its right-hand CST owns the insertion point;
  // the previous block may own the newline immediately to the left.
  let node: SyntaxNode | null = resolvePandocNode(tree, position,
    position === line.from && line.text.trim() === "" ? "right" : "left");
  while (node) {
    path.push(node);
    node = node.parent;
  }
  // A trailing newline creates an empty CM line outside a completed root
  // block, even though the CST's left-biased resolver lands in that block.
  const lastBlock = path.at(-2);
  if (position === tree.length && line.from === position
    && lastBlock && (PROSE_KINDS.has(lastBlock.kind) || lastBlock.prop(fenceClosed))) return [tree.root];
  if (path.some((part) => EXCLUDED_KINDS.has(part.kind))) return null;
  const footnote = path.find((part) => part.kind === "FootnoteDefinition");
  if (footnote) {
    for (const child of footnote.children()) {
      if (child.kind !== "Delimiter") continue;
      if (position < child.to) return null;
      break;
    }
  }
  return tree.length === 0 || path.some((part) => PROSE_KINDS.has(part.kind) || part.kind === "BlankLines")
    ? path
    : null;
}

// These expressions recognize only the incomplete token next to the cursor;
// the CST above supplies all block and inline structure.
const REFERENCE_TRIGGER = /(?:^|[^\p{L}\p{N}_])(-?)@([A-Za-z0-9_][A-Za-z0-9_:.#$%&+?<>~/-]*|)$/u;
const REFERENCE_SUFFIX = /^[A-Za-z0-9_:.#$%&+?<>~/-]*/;

function referenceCompletions(context: CompletionContext): CompletionResult | null {
  const tree = getPandocTree(context.state);
  const line = context.state.doc.lineAt(context.pos);
  const current = resolvePandocNode(tree, context.pos, "left");
  const keyAtCursor = current.kind === "CitationKey" ? current : resolvePandocNode(tree, context.pos);
  let from: number;
  if (keyAtCursor.kind === "CitationKey") {
    from = keyAtCursor.from;
  } else {
    if (current.kind !== "Text" || current.parent?.kind !== "InlineText") return null;
    // An unfinished key can end in CST text after a parsed key (e.g. @thm:).
    // Extend only across that adjacent key, keeping formatting marks outside.
    const previous = resolvePandocNode(tree, current.from, "left");
    const start = previous.kind === "CitationKey" ? previous.from - 1 : current.from;
    const match = REFERENCE_TRIGGER.exec(context.state.sliceDoc(Math.max(line.from, start), context.pos));
    if (!match) return null;
    from = context.pos - match[2].length;
  }
  const query = context.state.sliceDoc(from, context.pos);
  if (!proseContext(context, from)) return null;
  const key = resolvePandocNode(tree, from);
  const suffix = REFERENCE_SUFFIX.exec(context.state.sliceDoc(context.pos, Math.min(current.to, line.to)))?.[0] ?? "";
  // Sentence-final dots and colons are outside a completed citation key.
  const to = key.kind === "CitationKey"
    ? Math.max(context.pos, key.to)
    : context.pos + suffix.replace(/[.:]+$/, "").length;
  const needle = query.toLocaleLowerCase();
  const options = getReferenceCandidates(context.state)
    .filter((target) => `${target.id} ${target.label} ${target.detail}`.toLocaleLowerCase().includes(needle))
    .map((target): Completion => ({
      label: target.id,
      displayLabel: `@${target.id}`,
      detail: [target.label, target.detail].filter(Boolean).join(" · "),
      info: target.preview,
      type: target.from === undefined ? "text" : "variable",
    }));
  return { from, to, options, filter: false };
}

interface MarkupSnippet {
  readonly completion: Completion;
  readonly template: string;
  readonly trigger: string;
  readonly block: boolean;
}

function markupSnippet(
  label: string,
  detail: string,
  trigger: string,
  template: string,
  block = false,
): MarkupSnippet {
  return { completion: snippetCompletion(template, { label, detail, type: "text" }), template, trigger, block };
}

const MARKUP_SNIPPETS: readonly MarkupSnippet[] = [
  markupSnippet("emphasis", "Italic text", "*", "*${1:text}*${2}"),
  markupSnippet("strong", "Bold text", "**", "**${1:text}**${2}"),
  markupSnippet("link", "Link text and destination", "[", "[${1:text}](${2:https://example.com})${3}"),
  markupSnippet("inline math", "Inline formula", "$", "$${1:x}$${2}"),
  markupSnippet("display math", "Unnumbered display formula", "$$", "$$\n${1:x = y}\n$$\n${2}", true),
  markupSnippet("heading", "Section heading", "#", "## ${1:Heading}\n\n${2}", true),
  markupSnippet("code fence", "Literal code block", "```", "```${1:text}\n${2:code}\n```\n${3}", true),
  markupSnippet("theorem", "Numbered theorem with a label", ":::", "::: {.theorem #thm:${1:name} title=\"${2:Title}\"}\n${3:Statement.}\n:::\n${4}", true),
  markupSnippet("lemma", "Numbered lemma with a label", ":::", "::: {.lemma #lem:${1:name} title=\"${2:Title}\"}\n${3:Statement.}\n:::\n${4}", true),
  markupSnippet("corollary", "Numbered corollary with a label", ":::", "::: {.corollary #cor:${1:name} title=\"${2:Title}\"}\n${3:Statement.}\n:::\n${4}", true),
  markupSnippet("proposition", "Numbered proposition with a label", ":::", "::: {.proposition #prop:${1:name} title=\"${2:Title}\"}\n${3:Statement.}\n:::\n${4}", true),
  markupSnippet("definition", "Definition with a label", ":::", "::: {.definition #def:${1:name} title=\"${2:Title}\"}\n${3:Definition.}\n:::\n${4}", true),
  markupSnippet("proof", "Proof with a closing tombstone", ":::", "::: {.proof}\n${1:Proof.}\n:::\n${2}", true),
  markupSnippet("fenced div", "Block with a custom class and label", ":::", "::: {.${1:remark} #${2:rem:name}}\n${3:Content.}\n:::\n${4}", true),
  markupSnippet("equation", "Numbered display formula with a label", ":::", "::: {.equation #eq:${1:name}}\n$$\n${2:x = y}\n$$\n:::\n${3}", true),
];

const AUTOMATIC_MARKUP_TRIGGERS = new Set([":::", "**", "$$", "```"]);

function markupCompletions(context: CompletionContext, path: readonly SyntaxNode[]): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = context.state.sliceDoc(line.from, context.pos);
  if (REFERENCE_TRIGGER.test(before) || path.some((node) => node.kind === "CitationKey")) return null;
  const trigger = /(?:^|\s)(:::|\*\*|\$\$|```|\*|\[|\$|#)$/.exec(before)?.[1];
  if (!context.explicit && (!trigger || !AUTOMATIC_MARKUP_TRIGGERS.has(trigger))) return null;
  const query = trigger ?? /[A-Za-z]*$/.exec(before)?.[0] ?? "";
  const from = context.pos - query.length;
  // Root-level templates cannot accidentally introduce equal-length nested
  // div fences, list indentation, or new block structure in a table cell.
  const topLevel = path.every((node) => node.kind === "Document"
    || node.kind === "Paragraph" || node.kind === "BlankLines"
    || node.kind === "InlineText" || node.kind === "Text"
    || node.kind === "Space" || node.kind === "Whitespace" || node.kind === "LineEnding"
    || (trigger === "#" && (node.kind === "AtxHeading" || node.kind === "Delimiter")));
  const allowBlock = topLevel && from === line.from && context.pos === line.to;
  const needsBlankLine = allowBlock && from > 0 && context.state.doc.lineAt(from - 1).text.trim() !== "";
  const options = MARKUP_SNIPPETS
    .filter((item) => (!item.block || allowBlock) && (!trigger || item.trigger === trigger))
    .map((item) => item.block && needsBlankLine
      ? snippetCompletion(`\n${item.template}`, item.completion)
      : item.completion);
  // An opening bracket may already have its paired closer from typing assistance.
  const to = trigger === "[" && context.state.sliceDoc(context.pos, context.pos + 1) === "]"
    ? context.pos + 1
    : context.pos;
  return options.length ? { from, to, options, ...(trigger ? { filter: false } : {}) } : null;
}

export function editingCompletionSource(options: CompletionOptions): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    if (context.state.readOnly || !context.state.selection.main.empty) return null;
    const path = proseContext(context, context.pos);
    if (!path) return null;
    if (options.references) {
      const references = referenceCompletions(context);
      if (references) return references;
    }
    return options.snippets ? markupCompletions(context, path) : null;
  };
}

export function editingCompletionExtension(options: CompletionOptions): Extension {
  if (!options.references && !options.snippets) return [];
  const source = editingCompletionSource(options);
  const pending = new Set<(result: CompletionResult | null) => void>();
  return [
    autocompletion({
      override: [(context) => {
        const result = source(context);
        if (!context.view || result?.options.length !== 0 || getBibliographyStatus(context.state).state !== "loading") return result;
        return new Promise<CompletionResult | null>((resolve) => {
          pending.add(resolve);
          context.addEventListener("abort", () => {
            pending.delete(resolve);
            resolve(null);
          }, { onDocChange: true });
        });
      }],
      activateOnTyping: options.activateOnTyping,
      defaultKeymap: false,
    }),
    Prec.highest(keymap.of([
      ...completionKeymap,
      { key: "Tab", run: (view) => acceptCompletion(view) || nextSnippetField(view), shift: prevSnippetField },
      { key: "Escape", run: clearSnippet },
    ])),
    options.references ? ViewPlugin.fromClass(class {
      private destroyed = false;

      update(update: ViewUpdate): void {
        if (!completionStatus(update.state)) {
          for (const resolve of pending) resolve(null);
          pending.clear();
          return;
        }
        if (getCitationItems(update.startState) === getCitationItems(update.state)
          && getBibliographyStatus(update.startState).state === getBibliographyStatus(update.state).state
          && getDocumentPresentation(update.startState).localTargets === getDocumentPresentation(update.state).localTargets) return;
        if (pending.size) {
          const context = new CompletionContext(update.state, update.state.selection.main.head, false, update.view);
          for (const resolve of pending) resolve(source(context));
          pending.clear();
          return;
        }
        // CM queries pending requests against the latest state. Restarting one
        // would promote automatic typing assistance to an explicit Ctrl-Space.
        if (completionStatus(update.state) !== "active") return;
        // Dispatch after CodeMirror finishes the target or bibliography transaction.
        void Promise.resolve().then(() => {
          if (!this.destroyed && update.view.state.doc === update.state.doc
            && update.view.state.selection.eq(update.state.selection)
            && completionStatus(update.view.state)) startCompletion(update.view);
        });
      }

      destroy(): void {
        this.destroyed = true;
        for (const resolve of pending) resolve(null);
        pending.clear();
      }
    }) : [],
  ];
}
