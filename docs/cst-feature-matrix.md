# CST editor feature matrix

| Concern | Authoritative input | Current behavior |
|---|---|---|
| Document updates | CM6 transaction + `pandocCstField` | one synchronous CST update per document-changing transaction |
| Cursor context | CST ancestry | nearest Pandoc block, inline, and full path |
| Inline formatting | CST nodes | semantic styling; delimiters reveal at the cursor |
| Inline math | CST `Math` and `OpaqueBody` | KaTeX while inactive; raw source plus live preview while active |
| Display math | CST `Math` and `OpaqueBody` | literal keyboard-editable source |
| Headings | CST heading nodes and level property | Coflat heading typography; source prefix reveals at the cursor |
| Code blocks | CST code block nodes | literal keyboard-editable source with code styling |
| Other Pandoc blocks/inlines | CST | literal keyboard-editable source |
| Reader/read-only modes | none | removed |
| Legacy Lezer projection | none | forbidden from the shipped editor graph |

Publication features are downstream rendering concerns and do not extend the
editor grammar.
