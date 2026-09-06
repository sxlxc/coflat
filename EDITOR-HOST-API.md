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

There are no mode controls, reader APIs, panels, pickers, uploads, or mouse-only
commands in this contract. Hosts may append normal CM6 extensions, but those
extensions must not introduce a competing Markdown parser or semantic tree.
