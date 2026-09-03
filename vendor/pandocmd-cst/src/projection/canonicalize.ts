/**
 * Remove representation noise before differential comparison. This deliberately
 * does not reorder arrays or attributes, which are semantically ordered by Pandoc.
 */
export function canonicalizePandocJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalizePandocJson);
    const merged: unknown[] = [];
    for (const item of items) {
      const previous = merged[merged.length - 1];
      if (isStr(previous) && isStr(item)) previous.c += item.c;
      else merged.push(item);
    }
    return merged;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = canonicalizePandocJson((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function isStr(value: unknown): value is { t: "Str"; c: string } {
  return value !== null && typeof value === "object" && (value as { t?: unknown }).t === "Str" && typeof (value as { c?: unknown }).c === "string";
}
