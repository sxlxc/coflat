import createDOMPurify from "dompurify";
import katex from "katex";
import { isSafeUrl } from "../../core/lib/url-utils";
import { buildKatexOptions } from "../lib/katex-options";

const katexHtmlCache = new Map<string, string>();
const katexErrorLogCache = new Set<string>();
const MAX_KATEX_CACHE_ENTRIES = 2000;
const MAX_KATEX_ERROR_LOG_ENTRIES = 200;
const KATEX_PURIFY_EXTRA_TAGS = ["semantics", "annotation"] as const;
const KATEX_PURIFY_EXTRA_ATTRIBUTES = ["encoding"] as const;
const KATEX_PURIFY_FORBID_TAGS = ["img"] as const;

export type KatexRenderOutputMode = "htmlAndMathml" | "html";

let katexPurify: ReturnType<typeof createDOMPurify> | null = null;

function serializeKatexMacros(macros: Record<string, string>): string {
  const keys = Object.keys(macros).sort();
  return keys.map((key) => `${key}=${macros[key]}`).join("\0");
}

function katexCacheKey(
  latex: string,
  isDisplay: boolean,
  macros: Record<string, string>,
  outputMode: KatexRenderOutputMode,
  throwOnError: boolean,
): string {
  return [
    serializeKatexMacros(macros),
    isDisplay ? "D" : "I",
    outputMode,
    throwOnError ? "E" : "e",
    latex,
  ].join("\0");
}

function getKatexPurify(): ReturnType<typeof createDOMPurify> {
  if (katexPurify) return katexPurify;
  if (typeof window === "undefined") {
    throw new Error("KaTeX rendering requires a browser-like window");
  }
  const purify = createDOMPurify(window);
  purify.addHook("afterSanitizeAttributes", (node) => {
    const href = node.getAttribute("href");
    if (href && !isSafeUrl(href)) node.removeAttribute("href");
  });
  katexPurify = purify;
  return purify;
}

function sanitizeKatexHtml(raw: string): string {
  return getKatexPurify().sanitize(raw, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    ADD_TAGS: [...KATEX_PURIFY_EXTRA_TAGS],
    ADD_ATTR: [...KATEX_PURIFY_EXTRA_ATTRIBUTES],
    FORBID_TAGS: [...KATEX_PURIFY_FORBID_TAGS],
  });
}

export function clearKatexHtmlCache(): void {
  katexHtmlCache.clear();
  katexErrorLogCache.clear();
}

export function renderKatexToHtml(
  latex: string,
  isDisplay: boolean,
  macros: Record<string, string>,
  outputMode: KatexRenderOutputMode = "htmlAndMathml",
  throwOnError = false,
): string {
  const key = katexCacheKey(latex, isDisplay, macros, outputMode, throwOnError);
  const cached = katexHtmlCache.get(key);
  if (cached !== undefined) return cached;

  let html: string;
  try {
    html = katex.renderToString(latex, {
      ...buildKatexOptions(isDisplay, macros),
      output: outputMode,
      throwOnError,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const logKey = `${key}\0${message}`;
    if (!katexErrorLogCache.has(logKey)) {
      if (katexErrorLogCache.size >= MAX_KATEX_ERROR_LOG_ENTRIES) {
        katexErrorLogCache.clear();
      }
      katexErrorLogCache.add(logKey);
      console.error("[katex] failed to render math", { latex, isDisplay }, error);
    }
    throw error;
  }

  const sanitized = sanitizeKatexHtml(html);
  if (katexHtmlCache.size >= MAX_KATEX_CACHE_ENTRIES) katexHtmlCache.clear();
  katexHtmlCache.set(key, sanitized);
  return sanitized;
}

