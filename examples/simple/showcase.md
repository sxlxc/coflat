# Coflat

Coflat is a keyboard-first editor for Pandoc Markdown.

Move the caret into *emphasis*, **strong text**, `inline code`, a [link](https://pandoc.org), or math $x^2+y^2=z^2$ to edit its literal source.

## Math

Inactive math uses the Coflat KaTeX surface. Click a rendered inline formula to reveal its source. Click display math to edit it with the live Coflat preview popup.

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

## Tables

Pipe tables render as semantic tables. Click one to edit its Markdown source with a live table preview.

| Item | Value |
| --- | ---: |
| Alpha | 1 |
| Beta | 2 |

## Pandoc blocks stay source-editable

> A block quote keeps its monospace source marker.

- First list item
- Second list item

```ts
const sourceIsTruth = true;
```

::: {.thm #thm:source title="Source remains canonical"}
Fenced divs show an unnumbered class label. Enter the header to edit its Pandoc attributes.
:::

The local reference [@thm:source] resolves to the block label without adding a number.
