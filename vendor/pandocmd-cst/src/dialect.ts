/** The only reader configuration supported by the v1 API. */
export const PANDOCMD_READER_FORMAT =
  "markdown+tex_math_double_backslash+tex_math_single_backslash+latex_macros+raw_tex" as const;

/** Changes when serialized green-tree or parser semantics become incompatible. */
export const PANDOCMD_PARSER_VERSION = "0.1.1-local-green" as const;
