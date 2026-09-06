import type { Extension } from "@codemirror/state";
import { editingCompletionExtension } from "./completions";
import { referencePreviewExtension } from "./references";

/** Optional editing aids. Each feature is enabled by default. */
export interface EditingAssistanceOptions {
  /** Suggest local labels and loaded bibliography keys after `@`. */
  readonly referenceCompletion?: boolean;
  /** Offer canonical Markdown and fenced-div snippets. */
  readonly markupCompletion?: boolean;
  /** Show reference previews on hover and with Mod-Shift-Space. */
  readonly referencePreviews?: boolean;
  /** Open suggestions while typing. Ctrl-Space still works when false. */
  readonly activateOnTyping?: boolean;
  /** Delay before showing a hover preview, in milliseconds. Defaults to 300. */
  readonly hoverTime?: number;
}

export function editingAssistanceExtension(
  options: EditingAssistanceOptions | false = {},
): Extension {
  if (options === false) return [];
  return [
    editingCompletionExtension({
      references: options.referenceCompletion !== false,
      snippets: options.markupCompletion !== false,
      activateOnTyping: options.activateOnTyping !== false,
    }),
    options.referencePreviews === false
      ? []
      : referencePreviewExtension(options.hoverTime ?? 300),
  ];
}
