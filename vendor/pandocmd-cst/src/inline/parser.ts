import {
  citationMode, destinationSyntax, green, htmlTagName, leaf, linkForm, mathDelimiter,
  mathDisplay, normalizedCitationKey, normalizedReferenceLabel, props, rawFormat,
  referenceForm, smartInterpretation,
  type GreenNode, type MathDelimiterStyle, type NodeKind, type PropertyBag, type ReferenceForm,
} from "../nodes.js";

const escapable = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const entity = /^&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/;
const citationKey = /(-?)@([A-Za-z0-9][A-Za-z0-9_:.#$%&+?<>~/\-]*)/g;

function mark(kind: NodeKind, length: number): GreenNode { return leaf(kind, length); }

function literal(text: string): GreenNode[] {
  const result: GreenNode[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const char = text[i]!;
    if (char === " " || char === "\t") {
      while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
      result.push(green("Space", [leaf("Whitespace", i - start)]));
    } else if (char === "\r" || char === "\n") {
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
      result.push(green("SoftBreak", [leaf("LineEnding", i - start)]));
    } else {
      i++;
      while (i < text.length && !/[ \t\r\n]/.test(text[i]!)) i++;
      result.push(green("InlineText", [leaf("Text", i - start)]));
    }
  }
  return result;
}

function findUnescaped(text: string, needle: string, from: number): number {
  let at = text.indexOf(needle, from);
  while (at >= 0) {
    let slashes = 0;
    for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
    if (slashes % 2 === 0) return at;
    at = text.indexOf(needle, at + needle.length);
  }
  return -1;
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/[\t\r\n ]+/g, " ").toLocaleLowerCase();
}

/** Parse a complete Pandoc attribute list, rejecting incomplete sigils. */
export function parseAttributeList(source: string): GreenNode | null {
  if (!/^\{[^}\r\n]*\}$/.test(source)) return null;
  const children: GreenNode[] = [mark("Delimiter", 1)];
  let i = 1;
  while (i < source.length - 1) {
    const ws = /^[ \t\r\n]+/.exec(source.slice(i));
    if (ws) { children.push(leaf(ws[0].includes("\n") ? "LineEnding" : "Whitespace", ws[0].length)); i += ws[0].length; continue; }
    const token = /^[^\s}]+/.exec(source.slice(i))?.[0] ?? source[i]!;
    const tokenChildren: GreenNode[] = [];
    if (token.startsWith("#")) {
      if (token.length === 1) return null;
      tokenChildren.push(mark("Delimiter", 1), leaf("Identifier", token.length - 1));
    } else if (token.startsWith(".")) {
      if (token.length === 1) return null;
      tokenChildren.push(mark("Delimiter", 1), leaf("ClassName", token.length - 1));
    } else {
      const eq = token.indexOf("=");
      if (eq > 0) {
        tokenChildren.push(leaf("AttributeName", eq), mark("Delimiter", 1));
        if (eq + 1 < token.length) tokenChildren.push(leaf("AttributeValue", token.length - eq - 1));
      } else tokenChildren.push(leaf("AttributeName", token.length));
    }
    children.push(green("Attribute", tokenChildren));
    i += token.length;
  }
  children.push(mark("Delimiter", 1));
  return green("AttributeList", children);
}

function delimited(kind: NodeKind, source: string, open: string, close: string, properties: PropertyBag = {}): GreenNode {
  const body = source.slice(open.length, source.length - close.length);
  return green(kind, [mark(kind === "Code" ? "CodeMark" : "Delimiter", open.length), ...parseInlines(body), mark(kind === "Code" ? "CodeMark" : "Delimiter", close.length)], properties);
}

function parseCitation(source: string): GreenNode {
  const children: GreenNode[] = [mark("BracketMark", 1)];
  const inner = source.slice(1, -1);
  for (const segment of inner.split(/(;)/)) {
    if (!segment) continue;
    if (segment === ";") {
      children.push(mark("Delimiter", 1)); continue;
    }
    citationKey.lastIndex = 0;
    const match = citationKey.exec(segment);
    if (!match) { children.push(...literal(segment)); continue; }
    const suppress = match[1] === "-";
    const prefix = segment.slice(0, match.index);
    const suffix = segment.slice(match.index + match[0].length);
    children.push(green("CitationItem", [
      ...(prefix ? [green("CitationPrefix", parseInlines(prefix))] : []),
      ...(suppress ? [mark("Delimiter", 1)] : []), mark("Delimiter", 1), leaf("CitationKey", match[2]!.length),
      ...(suffix ? [green("CitationSuffix", parseInlines(suffix))] : []),
    ], props([citationMode, suppress ? "suppress-author" : "normal"], [normalizedCitationKey, match[2]!.toLocaleLowerCase()])));
  }
  children.push(mark("BracketMark", 1));
  return green("Citation", children);
}

function parseBracket(text: string, start: number, image: boolean): { node: GreenNode; end: number } | null {
  const labelOpen = start + (image ? 1 : 0);
  const close = findUnescaped(text, "]", labelOpen + 1);
  if (close < 0) return null;
  const prefix = image ? [mark("Delimiter", 1), mark("BracketMark", 1)] : [mark("BracketMark", 1)];
  const labelBody = text.slice(labelOpen + 1, close);
  const base = [...prefix, ...parseInlines(labelBody), mark("BracketMark", 1)];
  let cursor = close + 1;

  if (!image && text[cursor] === "{") {
    const attribute = /^\{[^}\r\n]*\}/.exec(text.slice(cursor));
    if (attribute) {
      const parsed = parseAttributeList(attribute[0]);
      if (parsed) { base.push(parsed); return { node: green("Span", base), end: cursor + attribute[0].length }; }
    }
  }

  if (text[cursor] === "(") {
    const end = findUnescaped(text, ")", cursor + 1);
    if (end < 0) return null;
    const inside = text.slice(cursor + 1, end);
    const match = /^\s*(<[^>]*>|[^\s"']+)?(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*$/.exec(inside);
    if (!match) return null;
    const destination = match[1] ?? "";
    const beforeDest = destination ? inside.indexOf(destination) : 0;
    const linkChildren = [...base, mark("ParenMark", 1)];
    if (beforeDest > 0) linkChildren.push(leaf("Whitespace", beforeDest));
    if (destination) {
      const angle = destination.startsWith("<");
      linkChildren.push(green("LinkDestination", [
        ...(angle ? [mark("Delimiter", 1)] : []),
        ...(destination.length > (angle ? 2 : 0) ? [leaf("Text", destination.length - (angle ? 2 : 0))] : []),
        ...(angle ? [mark("Delimiter", 1)] : []),
      ], props([destinationSyntax, angle ? "angle" : "bare"])));
    }
    let consumed = beforeDest + destination.length;
    if (inside.length > consumed) {
      const rest = inside.slice(consumed);
      const titleAt = rest.search(/["'(]/);
      if (titleAt >= 0) {
        if (titleAt > 0) linkChildren.push(leaf("Whitespace", titleAt));
        linkChildren.push(green("LinkTitle", [leaf("Text", rest.length - titleAt)]));
      } else linkChildren.push(...literal(rest));
    }
    linkChildren.push(mark("ParenMark", 1));
    cursor = end + 1;
    const attr = /^\{[^}\r\n]*\}/.exec(text.slice(cursor));
    const parsedAttr = attr ? parseAttributeList(attr[0]) : null;
    if (attr && parsedAttr) { linkChildren.push(parsedAttr); cursor += attr[0].length; }
    return { node: green(image ? "Image" : "Link", linkChildren, props([linkForm, "inline"])), end: cursor };
  }

  let form: ReferenceForm = "shortcut";
  let reference = labelBody;
  if (text[cursor] === "[") {
    const secondClose = findUnescaped(text, "]", cursor + 1);
    if (secondClose < 0) return null;
    reference = text.slice(cursor + 1, secondClose);
    form = reference.length === 0 ? "collapsed" : "full";
    if (form === "collapsed") reference = labelBody;
    base.push(mark("BracketMark", 1));
    if (secondClose > cursor + 1) base.push(green("ReferenceLabel", [leaf("Text", secondClose - cursor - 1)]));
    base.push(mark("BracketMark", 1));
    cursor = secondClose + 1;
  }
  if (!reference.trim() || labelBody.includes("\n\n")) return null;
  return {
    node: green(image ? "ImageReferenceCandidate" : "ReferenceCandidate", base, props(
      [linkForm, form], [referenceForm, form], [normalizedReferenceLabel, normalizeLabel(reference)],
    )),
    end: cursor,
  };
}

function mathAt(text: string, start: number): { node: GreenNode; end: number } | null {
  let open: string, close: string, style: MathDelimiterStyle, display: boolean;
  if (text.startsWith("$$", start)) { open = close = "$$"; style = "double-dollar"; display = true; }
  else if (text[start] === "$") { open = close = "$"; style = "dollar"; display = false; }
  else if (text.startsWith("\\\\[", start)) { open = "\\\\["; close = "\\\\]"; style = "double-backslash"; display = true; }
  else if (text.startsWith("\\\\(", start)) { open = "\\\\("; close = "\\\\)"; style = "double-backslash"; display = false; }
  else if (text.startsWith("\\[", start)) { open = "\\["; close = "\\]"; style = "single-backslash"; display = true; }
  else if (text.startsWith("\\(", start)) { open = "\\("; close = "\\)"; style = "single-backslash"; display = false; }
  else return null;
  const end = findUnescaped(text, close, start + open.length);
  if (end < 0 || end === start + open.length) return null;
  if (open === "$" && (/\s/.test(text[start + 1]!) || /\s/.test(text[end - 1]!))) return null;
  const bodyLength = end - start - open.length;
  return {
    node: green("Math", [mark("MathMark", open.length), leaf("OpaqueBody", bodyLength), mark("MathMark", close.length)], props([mathDisplay, display], [mathDelimiter, style])),
    end: end + close.length,
  };
}

/** Parse one complete inline-bearing block. Input may contain physical line endings. */
export function parseInlines(text: string): readonly GreenNode[] {
  // Most editor text has no inline opener. Avoid running every delimiter probe
  // for those spans while retaining the exact same literal node construction.
  if (!/[\\$&`<\[\]!^*_~"'@]/.test(text) && !text.includes("...") && !text.includes("--") && !/ {2,}(?:\r\n|\n)/.test(text)) {
    return Object.freeze(literal(text));
  }
  const nodes: GreenNode[] = [];
  let i = 0, plainStart = 0;
  const flush = (end: number): void => { if (end > plainStart) nodes.push(...literal(text.slice(plainStart, end))); };
  const emit = (node: GreenNode, end: number): void => { flush(i); nodes.push(node); i = end; plainStart = end; };

  while (i < text.length) {
    const char = text[i]!;
    const math = (char === "$" || text.startsWith("\\(", i) || text.startsWith("\\[", i) || text.startsWith("\\\\(", i) || text.startsWith("\\\\[", i)) ? mathAt(text, i) : null;
    if (math) { emit(math.node, math.end); continue; }
    if (char === "\\" && i + 1 < text.length && escapable.test(text[i + 1]!)) {
      emit(green("Escape", [mark("Delimiter", 1), leaf("Text", 1)]), i + 2); continue;
    }
    if (char === "\\" && (text[i + 1] === "\n" || (text[i + 1] === "\r" && text[i + 2] === "\n"))) {
      const width = text[i + 1] === "\r" ? 2 : 1;
      emit(green("LineBreak", [leaf("Escape", 1), leaf("LineEnding", width)]), i + 1 + width); continue;
    }
    if (char === " " && /^ {2,}(?:\r\n|\n)/.test(text.slice(i))) {
      const match = /^( +)(\r\n|\n)/.exec(text.slice(i))!;
      emit(green("LineBreak", [leaf("Whitespace", match[1]!.length), leaf("LineEnding", match[2]!.length)]), i + match[0].length); continue;
    }
    if (char === "&") {
      const match = entity.exec(text.slice(i));
      if (match) { emit(leaf("Entity", match[0].length), i + match[0].length); continue; }
    }
    if (char === "`") {
      let count = 1; while (text[i + count] === "`") count++;
      const delimiter = "`".repeat(count), end = findUnescaped(text, delimiter, i + count);
      if (end >= 0) {
        const children = [mark("CodeMark", count)];
        if (end > i + count) children.push(leaf("OpaqueBody", end - i - count));
        children.push(mark("CodeMark", count));
        let after = end + count;
        const attr = /^\{[^}\r\n]*\}/.exec(text.slice(after));
        const parsedAttr = attr ? parseAttributeList(attr[0]) : null;
        if (attr && parsedAttr) {
          children.push(parsedAttr); after += attr[0].length;
          const format = /^\{=([^\s}]+)\}$/.exec(attr[0]);
          emit(green(format ? "RawInline" : "Code", children, format ? props([rawFormat, format[1]!]) : {}), after); continue;
        }
        emit(green("Code", children), after); continue;
      }
    }
    if (text.startsWith("<div", i) || text.startsWith("<span", i)) {
      const open = /^<(div|span)\b[^>]*>/i.exec(text.slice(i));
      if (open) {
        const tag = open[1]!.toLocaleLowerCase();
        const closeText = `</${tag}>`, closeAt = text.toLocaleLowerCase().indexOf(closeText, i + open[0].length);
        if (closeAt >= 0) {
          const children = [leaf("HtmlTag", open[0].length), ...parseInlines(text.slice(i + open[0].length, closeAt)), leaf("HtmlTag", closeText.length)];
          emit(green("NativeHtmlSpan", children, props([htmlTagName, tag])), closeAt + closeText.length); continue;
        }
      }
    }
    if (char === "<") {
      const auto = /^<(https?:\/\/[^ >]+|mailto:[^ >]+|[^ <>@]+@[^ <>@]+)>/.exec(text.slice(i));
      if (auto) { emit(green("AutoLink", [mark("Delimiter", 1), leaf("Text", auto[1]!.length), mark("Delimiter", 1)], props([linkForm, "autolink"])), i + auto[0].length); continue; }
      const html = /^<\/?[A-Za-z][^>]*>/.exec(text.slice(i));
      if (html) { emit(green("RawInline", [leaf("HtmlTag", html[0].length)], props([rawFormat, "html"])), i + html[0].length); continue; }
    }
    if (char === "\\" && /[A-Za-z]/.test(text[i + 1] ?? "")) {
      const command = /^\\[A-Za-z]+\*?/.exec(text.slice(i))![0];
      let end = i + command.length;
      while (text[end] === "{") {
        let depth = 1, cursor = end + 1;
        while (cursor < text.length && depth) { if (text[cursor] === "{") depth++; else if (text[cursor] === "}") depth--; cursor++; }
        if (depth) break;
        end = cursor;
      }
      emit(green("RawInline", [leaf("Delimiter", command.length), ...(end > i + command.length ? [leaf("OpaqueBody", end - i - command.length)] : [])], props([rawFormat, "tex"])), end); continue;
    }
    if (text.startsWith("[^", i)) {
      const close = findUnescaped(text, "]", i + 2);
      if (close >= 0) { emit(green("FootnoteReference", [mark("BracketMark", 2), leaf("Identifier", close - i - 2), mark("BracketMark", 1)]), close + 1); continue; }
    }
    if ((char === "!" && text[i + 1] === "[") || char === "[") {
      const contentStart = i + (char === "!" ? 2 : 1);
      const firstClose = findUnescaped(text, "]", contentStart);
      if (char === "[" && firstClose > i && /(?:^|[;\s])-?@[A-Za-z0-9]/.test(text.slice(i + 1, firstClose))) {
        emit(parseCitation(text.slice(i, firstClose + 1)), firstClose + 1); continue;
      }
      const bracket = parseBracket(text, i, char === "!");
      if (bracket) { emit(bracket.node, bracket.end); continue; }
    }
    if (text.startsWith("^[", i)) {
      const close = findUnescaped(text, "]", i + 2);
      if (close >= 0) { emit(green("InlineNote", [mark("Delimiter", 2), ...parseInlines(text.slice(i + 2, close)), mark("BracketMark", 1)]), close + 1); continue; }
    }
    if (text.startsWith("(@", i)) {
      const example = /^\(@([A-Za-z0-9_:.#$%&+?<>~\/\-]+)\)/.exec(text.slice(i));
      if (example) {
        emit(green("ExampleReference", [mark("ParenMark", 1), mark("Delimiter", 1), leaf("CitationKey", example[1]!.length), mark("ParenMark", 1)], props([normalizedCitationKey, example[1]!.toLocaleLowerCase()])), i + example[0].length);
        continue;
      }
    }
    if (char === "@" && !/[\p{L}\p{N}_]/u.test(text[i - 1] ?? "")) {
      const author = /^@[A-Za-z0-9][A-Za-z0-9_:.#$%&+?<>~\/\-]*/.exec(text.slice(i));
      if (author) {
        emit(green("ExampleReference", [mark("Delimiter", 1), leaf("CitationKey", author[0].length - 1)], props(
          [citationMode, "author-in-text"], [normalizedCitationKey, author[0].slice(1).toLocaleLowerCase()],
        )), i + author[0].length);
        continue;
      }
    }
    if (text.startsWith("***", i) || text.startsWith("___", i)) {
      const delimiter = text.slice(i, i + 3), end = findUnescaped(text, delimiter, i + 3);
      if (end > i + 3 && !/\s/.test(text[i + 3]!) && !/\s/.test(text[end - 1]!)) {
        const body = parseInlines(text.slice(i + 3, end));
        emit(green("Strong", [mark("Delimiter", 2), green("Emphasis", [mark("Delimiter", 1), ...body, mark("Delimiter", 1)]), mark("Delimiter", 2)]), end + 3);
        continue;
      }
    }
    const emphasis: readonly [string, string, NodeKind][] = [
      ["**", "**", "Strong"], ["__", "__", "Strong"],
      ["~~", "~~", "Strikeout"], ["*", "*", "Emphasis"], ["_", "_", "Emphasis"], ["^", "^", "Superscript"], ["~", "~", "Subscript"],
    ];
    let matched = false;
    for (const [open, close, kind] of emphasis) {
      if (!text.startsWith(open, i)) continue;
      if (open === "_" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[i + 1] ?? "")) continue;
      const end = findUnescaped(text, close, i + open.length);
      if (end <= i + open.length || /\s/.test(text[i + open.length]!) || /\s/.test(text[end - 1]!)) continue;
      emit(delimited(kind, text.slice(i, end + close.length), open, close), end + close.length);
      matched = true; break;
    }
    if (matched) continue;
    if ((char === "\"" || char === "'") && !(char === "'" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? ""))) {
      const end = findUnescaped(text, char, i + 1);
      if (end > i + 1) {
        emit(green("Quoted", [leaf("Delimiter", 1), ...parseInlines(text.slice(i + 1, end)), leaf("Delimiter", 1)], props([smartInterpretation, char === "\"" ? "open-double" : "open-single"])), end + 1); continue;
      }
    }
    const smart: readonly [string, "ellipsis" | "em-dash" | "en-dash"][] = [["...", "ellipsis"], ["---", "em-dash"], ["--", "en-dash"]];
    const smartMatch = smart.find(([sequence]) => text.startsWith(sequence, i));
    if (smartMatch) { emit(green("SmartSequence", [leaf("Text", smartMatch[0].length)], props([smartInterpretation, smartMatch[1]])), i + smartMatch[0].length); continue; }
    i++;
  }
  flush(text.length);
  return Object.freeze(nodes);
}

export { normalizeLabel };
