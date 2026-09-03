# Reader retirement

The reader and rich-readonly package surfaces were removed when Coflat became a
single CST-backed editing surface. Rendering remains a separate downstream
concern: use Pandoc/Lua for publication output, or build a renderer directly
from the authoritative `pandocmd-cst` tree.

Do not add renderer-only syntax to the editor grammar and do not reconstruct a
Lezer Markdown projection for rendering.
