# Editor host API

`@chaoxu/coflat` exposes one editable CodeMirror surface. The host owns storage
and surrounding application chrome; Coflat owns the source document, its
synchronous CST snapshot, cursor context, and keyboard editing behavior.

```ts
const editor = mountEditor({
  parent,
  doc,
  onChange(source) {},
  onDocumentChange({ changes, tree }) {},
  onCursorContextChange({ block, inline, path }) {},
  async readTextResource(path) {
    return workspace.readTextRelativeToCurrentDocument(path);
  },
  saveHandler,
  statusEvents,
  editingAssistance: {
    referenceCompletion: true,
    markupCompletion: true,
    referencePreviews: true,
    activateOnTyping: true,
    hoverTime: 300,
  },
});
```

`onDocumentChange` is called for user edits with the CodeMirror `ChangeSet` and
the exact `pandocmd-cst` snapshot paired with the resulting document. A host
can read the same state through `getDoc()`, `getCst()`, and
`getCursorContext()`.

`setDoc()` applies a localized source change and does not echo through the host
change callbacks. It updates the current document within its existing undo
history. To open a different file, unmount the editor and mount it with that
file's source; the host retains any unsaved drafts. `insertText()` performs an ordinary CM6 source transaction.
Navigation helpers use zero-based source offsets or one-based lines.

`SaveHandler` is optional. Coflat wires `Mod-s`, dirty state, and optional
debounced autosave; the host owns persistence, authorization, conflicts, and
retry policy.

`readTextResource(path)` is optional unless the document declares YAML `bibliography`. Coflat passes each `bibliography` path and the optional `csl` path exactly as written; the host resolves it relative to the current document and returns UTF-8 text. Bibliography progress and failures are reported through `statusEvents.onBibliographyStatusChange`. Coflat never reads the host filesystem directly.

`editingAssistance` is accepted by both `mountEditor` and `createEditor`. Omit it for the defaults shown above, set it to `false` to disable all editing aids, or provide a partial `EditingAssistanceOptions` object. Options are applied when the editor is created.

| Option | Behavior |
| --- | --- |
| `referenceCompletion` | Suggest local fenced-div/equation IDs and loaded bibliography keys after `@`, including bracketed citation clusters. Local targets take precedence over matching bibliography keys. |
| `markupCompletion` | Offer canonical Markdown snippets, wrap selections with paired delimiters, and complete brackets. Block snippets are offered at the document level to preserve fenced-div nesting. |
| `referencePreviews` | Show a text excerpt of a local target, or bibliography title/author/publication details, on hover and through the keyboard. |
| `activateOnTyping` | Open enabled suggestions at supported markup triggers and `@`. When false, completion is available through Ctrl-Space. |
| `hoverTime` | Milliseconds before opening a hover preview; defaults to `300`. |

Ctrl-Space opens completion; Up/Down select an entry, Enter or Tab accepts it, and Escape dismisses it. Within a snippet, Tab/Shift-Tab move between fields. Mod-Shift-Space opens a reference preview at the caret; Escape closes it. Previews use plain text and never modify citation registration or source. Completion inserts ordinary Markdown through CodeMirror transactions and remains undoable. Code, math bodies, raw content, and YAML do not receive prose suggestions. Bibliography options become available after the host resource loader finishes; no additional resource callback is needed.

Automatic markup triggers are `:::`, `**`, `$$`, and three backticks. Ctrl-Space also offers snippets by name (for example, type `theorem` and press Ctrl-Space on an otherwise empty line). Block templates include their closing fences and insert canonical Pandoc Markdown.

Typing `*`, `_`, `$`, a backtick, `~`, `^`, either quote, or an opening `(`, `[`, `{`, or `<` wraps selected source while preserving the inner selection and its direction. Repeated typing adds another layer, so two `*` keystrokes produce strong emphasis. This works across lines and multiple selections. With an empty selection, the four opening brackets insert matching closers before whitespace, closing brackets, `:`, `;`, or the end of the document. Typing an automatically inserted closer skips it; Backspace between an empty bracket pair removes both characters. Symmetric Markdown delimiters remain literal with an empty selection. Pairing is independent of `activateOnTyping`, which controls suggestion menus, and is disabled by `markupCompletion: false` or `editingAssistance: false`. Pasting and programmatic source changes do not wrap selections.

There are no mode controls, reader APIs, application panels, uploads, or mouse-only
commands in this contract. Hosts may append normal CM6 extensions, but those
extensions must not introduce a competing Markdown parser or semantic tree.
