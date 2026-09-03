import {
  exampleLabel, explicitIdentifier, fenceCharacter, fenceClosed, fenceInfo, fenceLength,
  footnoteLabel, green, greenDocument, headingLevel, htmlTagName, leaf, listTight, normalizedReferenceLabel,
  orderedListDelimiter, orderedListStart, orderedListStyle, props, rawFormat,
  referenceDestination, referenceTitle, tableAlignments, tableColumnCount, taskChecked,
  type GreenNode, type NodeKind, type PropertyBag,
} from "../nodes.js";
import { normalizeLabel, parseAttributeList, parseInlines } from "../inline/parser.js";

export interface LineRecord {
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
  readonly content: string;
  readonly ending: string;
}

export interface BlockCheckpoint {
  readonly line: number;
  readonly offset: number;
  readonly state: "base" | "paragraph" | "container";
}

export interface BlockParseResult {
  readonly root: GreenNode;
  readonly checkpoints: readonly BlockCheckpoint[];
}

export function scanLines(text: string): readonly LineRecord[] {
  const lines: LineRecord[] = [];
  let start = 0;
  while (start < text.length) {
    const lf = text.indexOf("\n", start);
    const end = lf < 0 ? text.length : lf + 1;
    const contentEnd = lf < 0 ? end : (lf > start && text.charCodeAt(lf - 1) === 13 ? lf - 1 : lf);
    lines.push({ start, contentEnd, end, content: text.slice(start, contentEnd), ending: text.slice(contentEnd, end) });
    start = end;
  }
  return Object.freeze(lines);
}

function ending(line: LineRecord): GreenNode[] { return line.ending ? [leaf("LineEnding", line.ending.length)] : []; }
function source(lines: readonly LineRecord[], from: number, to: number, text: string): string {
  return text.slice(lines[from]!.start, lines[to - 1]!.end);
}
function opaqueLine(line: LineRecord, bodyKind: NodeKind = "Text"): GreenNode[] {
  return [...(line.content.length ? [leaf(bodyKind, line.content.length)] : []), ...ending(line)];
}
function inlineLine(line: LineRecord): GreenNode[] { return [...parseInlines(line.content), ...ending(line)]; }

function blankBlock(lines: readonly LineRecord[], from: number, to: number): GreenNode {
  const children: GreenNode[] = [];
  for (let i = from; i < to; i++) children.push(...opaqueLine(lines[i]!, "Whitespace"));
  return green("BlankLines", children);
}

function fencedBlock(lines: readonly LineRecord[], from: number, close: number | null, match: RegExpExecArray): GreenNode {
  const first = lines[from]!;
  const indent = match[1]!.length, marker = match[2]!, info = match[3]!.trim();
  const children: GreenNode[] = [];
  if (indent) children.push(leaf("Whitespace", indent));
  children.push(leaf("FenceMark", marker.length));
  const rest = first.content.length - indent - marker.length;
  if (rest) children.push(green("CodeInfo", [leaf(/^\s/.test(match[3]!) ? "Whitespace" : "Text", rest)]));
  children.push(...ending(first));
  const bodyEnd = close ?? lines.length;
  for (let i = from + 1; i < bodyEnd; i++) children.push(...opaqueLine(lines[i]!, "OpaqueBody"));
  if (close !== null) children.push(...opaqueLine(lines[close]!, "FenceMark"));
  return green("FencedCodeBlock", children, props(
    [fenceCharacter, marker[0] as "`" | "~"], [fenceLength, marker.length], [fenceInfo, info], [fenceClosed, close !== null],
  ));
}

function colonDiv(lines: readonly LineRecord[], from: number, close: number | null, match: RegExpExecArray, text: string): GreenNode {
  const first = lines[from]!, marker = match[1]!, children: GreenNode[] = [leaf("FenceMark", marker.length)];
  if (first.content.length > marker.length) children.push(...parseInlines(first.content.slice(marker.length)));
  children.push(...ending(first));
  const bodyEnd = close ?? lines.length;
  if (bodyEnd > from + 1) {
    const innerStart = lines[from + 1]!.start;
    const innerEnd = lines[bodyEnd - 1]!.end;
    children.push(...parseBlocks(text.slice(innerStart, innerEnd)).root.children);
  }
  if (close !== null) children.push(...opaqueLine(lines[close]!, "FenceMark"));
  return green("FencedDiv", children, props([fenceCharacter, ":"], [fenceLength, marker.length], [fenceInfo, match[2]!.trim()], [fenceClosed, close !== null]));
}

function heading(line: LineRecord, match: RegExpExecArray): GreenNode {
  const indent = match[1]!.length, marks = match[2]!, gap = match[3]!, body = match[4]!;
  const trailing = /^(.*?)([ \t]+#+[ \t]*)$/.exec(body);
  const content = trailing ? trailing[1]! : body;
  const attrMatch = /^(.*?)([ \t]*)(\{[^}\r\n]*\})([ \t]*)$/.exec(content);
  const attr = attrMatch ? parseAttributeList(attrMatch[3]!) : null;
  const headingContent = attr ? attrMatch![1]! : content;
  const explicit = attr ? /#([^\s.}]+)/.exec(attrMatch![3]!)?.[1] : undefined;
  const children: GreenNode[] = [];
  if (indent) children.push(leaf("Whitespace", indent));
  children.push(leaf("Delimiter", marks.length));
  if (gap) children.push(leaf("Whitespace", gap.length));
  children.push(...parseInlines(headingContent));
  if (attr) {
    if (attrMatch![2]!.length) children.push(leaf("Whitespace", attrMatch![2]!.length));
    children.push(attr);
    if (attrMatch![4]!.length) children.push(leaf("Whitespace", attrMatch![4]!.length));
  }
  if (trailing) children.push(leaf("Delimiter", trailing[2]!.length));
  children.push(...ending(line));
  return green("AtxHeading", children, props([headingLevel, marks.length], ...(explicit ? [[explicitIdentifier, explicit] as const] : [])));
}

function setext(lines: readonly LineRecord[], from: number, marker: RegExpExecArray): GreenNode {
  const first = lines[from]!, second = lines[from + 1]!;
  const attrMatch = /^(.*?)([ \t]*)(\{[^}\r\n]*\})([ \t]*)$/.exec(first.content);
  const attr = attrMatch ? parseAttributeList(attrMatch[3]!) : null;
  const children: GreenNode[] = attr ? [...parseInlines(attrMatch![1]!)] : [...parseInlines(first.content)];
  if (attr) {
    if (attrMatch![2]!.length) children.push(leaf("Whitespace", attrMatch![2]!.length));
    children.push(attr);
    if (attrMatch![4]!.length) children.push(leaf("Whitespace", attrMatch![4]!.length));
  }
  children.push(...ending(first));
  if (marker[1]!.length) children.push(leaf("Whitespace", marker[1]!.length));
  children.push(leaf("Delimiter", marker[2]!.length));
  const tail = second.content.length - marker[1]!.length - marker[2]!.length;
  if (tail) children.push(leaf("Whitespace", tail));
  children.push(...ending(second));
  const explicit = attr ? /#([^\s.}]+)/.exec(attrMatch![3]!)?.[1] : undefined;
  return green("SetextHeading", children, props([headingLevel, marker[2]![0] === "=" ? 1 : 2], ...(explicit ? [[explicitIdentifier, explicit] as const] : [])));
}

function trivia(source: string): GreenNode[] {
  const result: GreenNode[] = [];
  let cursor = 0;
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    if (match.index > cursor) result.push(leaf("Whitespace", match.index - cursor));
    result.push(leaf("LineEnding", match[0].length)); cursor = match.index + match[0].length;
  }
  if (cursor < source.length) result.push(leaf("Whitespace", source.length - cursor));
  return result;
}

function referenceDefinition(source: string, match: RegExpExecArray): GreenNode {
  const before = match[1]!.length;
  const label = match[2]!, gap = match[3]!, destination = match[4]!;
  const titleGap = match[5] ?? "", titleSource = match[6] ?? "", title = match[7] ?? match[8] ?? match[9] ?? "";
  const children: GreenNode[] = [];
  if (before) children.push(leaf("Whitespace", before));
  children.push(leaf("BracketMark", 1), green("ReferenceLabel", [leaf("Text", label.length)]), leaf("BracketMark", 1), leaf("Delimiter", 1));
  let cursor = before + label.length + 3;
  if (gap) children.push(...trivia(gap));
  const angle = destination.startsWith("<") && destination.endsWith(">");
  children.push(green("LinkDestination", [
    ...(angle ? [leaf("Delimiter", 1)] : []),
    ...(destination.length > (angle ? 2 : 0) ? [leaf("Text", destination.length - (angle ? 2 : 0))] : []),
    ...(angle ? [leaf("Delimiter", 1)] : []),
  ]));
  cursor += gap.length + destination.length;
  if (titleSource) {
    children.push(...trivia(titleGap));
    children.push(green("LinkTitle", [leaf("Text", titleSource.length)])); cursor += titleGap.length + titleSource.length;
  }
  if (cursor < source.length) children.push(...trivia(source.slice(cursor)));
  return green("ReferenceDefinition", children, props(
    [normalizedReferenceLabel, normalizeLabel(label)], [referenceDestination, angle ? destination.slice(1, -1) : destination], [referenceTitle, title],
  ));
}

const referencePattern = /^( {0,3})\[([^\]]+)\]:([ \t]*(?:(?:\r\n|\r|\n)[ \t]+)?)(<[^>\r\n]*>|[^\s]+)(?:([ \t]*(?:(?:\r\n|\r|\n)[ \t]+)?)("([^"\r\n]*)"|'([^'\r\n]*)'|\(([^)\r\n]*)\)))?[ \t]*(?:(?:\r\n|\r|\n))?$/;

function referenceAt(lines: readonly LineRecord[], from: number, text: string): { node: GreenNode; end: number } | null {
  const header = /^ {0,3}\[([^\]]+)\]:(.*)$/.exec(lines[from]!.content);
  if (!header || header[1]!.startsWith("^")) return null;
  let end = from + 1;
  const afterColon = header[2]!.trim();
  if (!afterColon && end < lines.length && /^(?:[ \t]+)/.test(lines[end]!.content)) end++;
  if (end < lines.length && /^(?:[ \t]+)(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\r\n)]*\))[ \t]*$/.test(lines[end]!.content)) end++;
  for (let candidateEnd = end; candidateEnd > from; candidateEnd--) {
    const sourceText = source(lines, from, candidateEnd, text), match = referencePattern.exec(sourceText);
    if (match) return { node: referenceDefinition(sourceText, match), end: candidateEnd };
  }
  return null;
}

function tableRow(line: LineRecord): GreenNode {
  const children: GreenNode[] = [];
  let cursor = 0;
  for (const match of line.content.matchAll(/\|/g)) {
    const at = match.index;
    if (at > cursor) children.push(green("TableCell", parseInlines(line.content.slice(cursor, at))));
    children.push(leaf("TableDelimiter", 1)); cursor = at + 1;
  }
  if (cursor < line.content.length) children.push(green("TableCell", parseInlines(line.content.slice(cursor))));
  children.push(...ending(line));
  return green("TableRow", children);
}

function pipeTable(lines: readonly LineRecord[], from: number, to: number): GreenNode {
  const delimiter = lines[from + 1]!.content.split("|").map(value => value.trim()).filter(Boolean);
  const alignments = delimiter.map(value => value.startsWith(":") && value.endsWith(":") ? "center" : value.startsWith(":") ? "left" : value.endsWith(":") ? "right" : "default") as ("center" | "left" | "right" | "default")[];
  const children: GreenNode[] = [green("TableHead", [tableRow(lines[from]!), tableRow(lines[from + 1]!)])];
  if (to > from + 2) children.push(green("TableBody", Array.from({ length: to - from - 2 }, (_, i) => tableRow(lines[from + i + 2]!))));
  return green("PipeTable", children, props([tableAlignments, Object.freeze(alignments)], [tableColumnCount, alignments.length]));
}

function romanValue(source: string): number {
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let result = 0, previous = 0;
  for (const character of [...source.toLocaleLowerCase()].reverse()) {
    const value = values[character] ?? 0;
    result += value < previous ? -value : value; previous = value;
  }
  return result;
}

function listBlock(lines: readonly LineRecord[], from: number, to: number, ordered: boolean): GreenNode {
  const children: GreenNode[] = [];
  let i = from;
  let loose = false;
  let firstStart = 1, delimiter: "." | ")" = ".", style = "decimal";
  while (i < to) {
    const line = lines[i]!;
    const match = ordered
      ? /^( {0,3})((?:\d+|#|[A-Za-z]|[ivxlcdmIVXLCDM]+)([.)]))([ \t]+)(.*)$/.exec(line.content)
      : /^( {0,3})([-+*])([ \t]+)(.*)$/.exec(line.content);
    if (!match) { i++; continue; }
    const itemChildren: GreenNode[] = [];
    const indent = match[1]!.length;
    if (indent) itemChildren.push(leaf("Whitespace", indent));
    const marker = match[2]!;
    itemChildren.push(leaf("ListMark", marker.length));
    const gapIndex = ordered ? 4 : 3, bodyIndex = ordered ? 5 : 4;
    itemChildren.push(leaf("Whitespace", match[gapIndex]!.length));
    const body = match[bodyIndex]!;
    const task = /^\[([ xX])\][ \t]+/.exec(body);
    if (task) {
      itemChildren.push(leaf("BracketMark", 3), leaf("Whitespace", task[0].length - 3));
      itemChildren.push(...parseInlines(body.slice(task[0].length)));
    } else itemChildren.push(...parseInlines(body));
    itemChildren.push(...ending(line));
    const next = i + 1;
    let continuation = next;
    while (continuation < to) {
      const candidate = lines[continuation]!;
      if ((ordered ? /^( {0,3})(?:\d+|#|[A-Za-z]|[ivxlcdmIVXLCDM]+)[.)][ \t]+/.test(candidate.content) : /^( {0,3})[-+*][ \t]+/.test(candidate.content))) break;
      if (/^[ \t]*$/.test(candidate.content)) loose = true;
      itemChildren.push(...inlineLine(candidate)); continuation++;
    }
    const itemProps: [typeof taskChecked, boolean][] = task ? [[taskChecked, task[1]!.toLocaleLowerCase() === "x"]] : [];
    children.push(green("ListItem", itemChildren, props(...itemProps)));
    if (ordered && children.length === 1) {
      delimiter = match[3] as "." | ")";
      if (/^\d+$/.test(marker.slice(0, -1))) firstStart = Number.parseInt(marker, 10);
      else if (marker.startsWith("#")) style = "default";
      else {
        const value = marker.slice(0, -1);
        const roman = /^[ivxlcdm]+$/i.test(value) && (value.length > 1 || value.toLocaleLowerCase() === "i");
        style = roman ? (value === value.toLocaleUpperCase() ? "upper-roman" : "lower-roman") : (value === value.toLocaleUpperCase() ? "upper-alpha" : "lower-alpha");
        firstStart = roman ? romanValue(value) : value.toLocaleLowerCase().charCodeAt(0) - 96;
      }
    }
    i = continuation;
  }
  const properties: PropertyBag = ordered ? props([orderedListStart, firstStart], [orderedListDelimiter, delimiter], [orderedListStyle, style], [listTight, !loose]) : props([listTight, !loose]);
  return green(ordered ? "OrderedList" : "BulletList", children, properties);
}

function exampleList(lines: readonly LineRecord[], from: number, to: number): GreenNode {
  const items: GreenNode[] = [];
  for (let i = from; i < to; i++) {
    const line = lines[i]!, match = /^( {0,3})(\(@([^)]+)?\))([ \t]+)(.*)$/.exec(line.content);
    if (!match) { items[items.length - 1] = green("ListItem", [...(items[items.length - 1]?.children ?? []), ...inlineLine(line)]); continue; }
    const children: GreenNode[] = [];
    if (match[1]!.length) children.push(leaf("Whitespace", match[1]!.length));
    children.push(leaf("ListMark", match[2]!.length), leaf("Whitespace", match[4]!.length), ...parseInlines(match[5]!), ...ending(line));
    items.push(green("ListItem", children, match[3] ? props([exampleLabel, normalizeLabel(match[3]!)]) : {}));
  }
  return green("OrderedList", items, props([orderedListStart, 1], [orderedListDelimiter, ")"], [orderedListStyle, "example"], [listTight, true]));
}

function definitionList(lines: readonly LineRecord[], from: number, to: number): GreenNode {
  const children: GreenNode[] = [];
  let i = from;
  while (i < to) {
    const term = lines[i]!;
    children.push(green("DefinitionTerm", inlineLine(term)));
    i++;
    while (i < to) {
      const line = lines[i]!, match = /^( {0,3}):([ \t]+)(.*)$/.exec(line.content);
      if (!match) break;
      const body: GreenNode[] = [];
      if (match[1]!.length) body.push(leaf("Whitespace", match[1]!.length));
      body.push(leaf("Delimiter", 1), leaf("Whitespace", match[2]!.length), ...parseInlines(match[3]!), ...ending(line));
      children.push(green("DefinitionBody", body)); i++;
      while (i < to && /^(?: {2,}|\t)/.test(lines[i]!.content)) {
        children[children.length - 1] = green("DefinitionBody", [...children[children.length - 1]!.children, ...inlineLine(lines[i]!)]); i++;
      }
    }
  }
  return green("DefinitionList", children);
}

function genericTable(kind: "SimpleTable" | "MultilineTable" | "GridTable", lines: readonly LineRecord[], from: number, to: number): GreenNode {
  const rows: GreenNode[] = [];
  let columns = 0;
  for (let i = from; i < to; i++) {
    const line = lines[i]!;
    if (/^[ +|:=\-]+$/.test(line.content)) {
      rows.push(green("TableRow", opaqueLine(line, "TableDelimiter")));
      columns = Math.max(columns, (line.content.match(/\+/g)?.length ?? 1) - 1);
    } else {
      const pieces = kind === "GridTable" ? line.content.split("|") : line.content.trim().split(/ {2,}/);
      const rowChildren: GreenNode[] = [];
      let consumed = 0;
      for (let p = 0; p < pieces.length; p++) {
        const piece = pieces[p]!;
        const at = line.content.indexOf(piece, consumed);
        if (at > consumed) rowChildren.push(leaf(kind === "GridTable" ? "TableDelimiter" : "Whitespace", at - consumed));
        if (piece.length) rowChildren.push(green("TableCell", parseInlines(piece)));
        consumed = at + piece.length;
      }
      if (consumed < line.content.length) rowChildren.push(leaf(kind === "GridTable" ? "TableDelimiter" : "Whitespace", line.content.length - consumed));
      rowChildren.push(...ending(line)); rows.push(green("TableRow", rowChildren));
      columns = Math.max(columns, pieces.filter(Boolean).length);
    }
  }
  return green(kind, [green("TableBody", rows)], props([tableColumnCount, columns]));
}

function quoteBlock(lines: readonly LineRecord[], from: number, to: number): GreenNode {
  let inner = "", innerOffset = 0;
  const prefixes = new Map<number, readonly GreenNode[]>();
  for (let i = from; i < to; i++) {
    const line = lines[i]!, match = /^( {0,3})>( ?)(.*)$/.exec(line.content);
    if (!match) { inner += line.content + line.ending; innerOffset += line.content.length + line.ending.length; continue; }
    const prefix: GreenNode[] = [];
    if (match[1]!.length) prefix.push(leaf("Whitespace", match[1]!.length));
    prefix.push(leaf("QuoteMark", 1));
    if (match[2]!.length) prefix.push(leaf("Whitespace", 1));
    prefixes.set(innerOffset, prefix);
    inner += match[3]! + line.ending; innerOffset += match[3]!.length + line.ending.length;
  }
  const structuralQuoteContainers = new Set<NodeKind>(["Document", "BlockQuote", "BulletList", "OrderedList", "DefinitionList", "NativeHtmlDiv", "FencedDiv"]);
  const inject = (node: GreenNode, start: number): GreenNode => {
    if (!node.children.length) return node;
    const children: GreenNode[] = [];
    let cursor = start;
    for (const child of node.children) {
      const prefix = prefixes.get(cursor);
      if (prefix && (!structuralQuoteContainers.has(node.kind) || !child.children.length)) { children.push(...prefix); prefixes.delete(cursor); }
      children.push(inject(child, cursor)); cursor += child.length;
    }
    return green(node.kind, children, node.properties);
  };
  const parsed = inject(parseBlocks(inner).root, 0);
  const quotedChildren = [...parsed.children];
  const trailing = prefixes.get(inner.length);
  if (trailing) {
    const append = (node: GreenNode): GreenNode => {
      if (structuralQuoteContainers.has(node.kind) && node.children.length) {
        const children = [...node.children]; children[children.length - 1] = append(children[children.length - 1]!);
        return green(node.kind, children, node.properties);
      }
      return green(node.kind, [...node.children, ...trailing], node.properties);
    };
    if (quotedChildren.length) quotedChildren[quotedChildren.length - 1] = append(quotedChildren[quotedChildren.length - 1]!);
    else quotedChildren.push(green("BlankLines", trailing));
  }
  return green("BlockQuote", quotedChildren);
}

function paragraph(lines: readonly LineRecord[], from: number, to: number, text: string): GreenNode {
  return green("Paragraph", parseInlines(source(lines, from, to, text)));
}

function isBlockStart(lines: readonly LineRecord[], at: number): boolean {
  const value = lines[at]?.content ?? "";
  return /^[ \t]*$/.test(value) || /^( {0,3})(#{1,6})(?:[ \t]+|$)/.test(value) || /^( {0,3})(`{3,}|~{3,}|:{3,})/.test(value)
    || /^( {0,3})>/.test(value) || /^( {0,3})(?:[-+*][ \t]+|(?:\d+|#)[.)][ \t]+)/.test(value)
    || /^ {0,3}\[[^\]]+\]:/.test(value) || /^ {0,3}\[\^[^\]]+\]:/.test(value)
    || /^ {0,3}(?:<div\b|<\/div>|\\begin\{|\\\[)/i.test(value);
}

/** Parse block structure for a complete document or nested native container body. */
export function parseBlocks(text: string): BlockParseResult {
  const lines = scanLines(text), blocks: GreenNode[] = [], checkpoints: BlockCheckpoint[] = [];
  let i = 0;
  while (i < lines.length) {
    checkpoints.push({ line: i, offset: lines[i]!.start, state: "base" });
    const line = lines[i]!, value = line.content;
    if (/^[ \t]*$/.test(value)) {
      let end = i + 1; while (end < lines.length && /^[ \t]*$/.test(lines[end]!.content)) end++;
      blocks.push(blankBlock(lines, i, end)); i = end; continue;
    }
    if (i === 0 && /^---[ \t]*$/.test(value)) {
      let close = i + 1; while (close < lines.length && !/^(?:---|\.\.\.)[ \t]*$/.test(lines[close]!.content)) close++;
      if (close < lines.length) {
        close++;
        const children: GreenNode[] = [];
        for (let n = i; n < close; n++) children.push(...opaqueLine(lines[n]!, n === i || n === close - 1 ? "Delimiter" : "OpaqueBody"));
        blocks.push(green("YamlMetadata", children)); i = close; continue;
      }
    }
    if (i === 0 && /^%/.test(value)) {
      let end = i + 1; while (end < lines.length && (/^%/.test(lines[end]!.content) || /^\s+/.test(lines[end]!.content))) end++;
      const children: GreenNode[] = []; for (let n = i; n < end; n++) children.push(...inlineLine(lines[n]!));
      blocks.push(green("PandocTitleBlock", children)); i = end; continue;
    }
    const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(value);
    if (fence) {
      const marker = fence[2]!, pattern = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      let close: number | null = null; for (let n = i + 1; n < lines.length; n++) if (pattern.test(lines[n]!.content)) { close = n; break; }
      blocks.push(fencedBlock(lines, i, close, fence)); i = close === null ? lines.length : close + 1; continue;
    }
    const div = /^:{3,}(.*)$/.exec(value);
    if (div) {
      const opener = /^(:{3,})(.*)$/.exec(value)!;
      let close: number | null = null, depth = 1;
      for (let n = i + 1; n < lines.length; n++) {
        if (/^:{3,}\S/.test(lines[n]!.content)) depth++;
        else if (/^:{3,}[ \t]*$/.test(lines[n]!.content) && --depth === 0) { close = n; break; }
      }
      blocks.push(colonDiv(lines, i, close, opener, text)); i = close === null ? lines.length : close + 1; continue;
    }
    const atx = /^( {0,3})(#{1,6})([ \t]*)(.*)$/.exec(value);
    if (atx && (atx[3]!.length > 0 || atx[4]!.length === 0)) { blocks.push(heading(line, atx)); i++; continue; }
    if (i + 1 < lines.length && value.trim()) {
      const marker = /^( {0,3})(=+|-+)[ \t]*$/.exec(lines[i + 1]!.content);
      if (marker) { blocks.push(setext(lines, i, marker)); i += 2; continue; }
    }
    if (/^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/.test(value)) { blocks.push(green("HorizontalRule", opaqueLine(line, "Delimiter"))); i++; continue; }
    const ref = referenceAt(lines, i, text);
    if (ref) { blocks.push(ref.node); i = ref.end; continue; }
    const footnote = /^( {0,3})\[\^([^\]]+)\]:([ \t]*)(.*)$/.exec(value);
    if (footnote) {
      const children: GreenNode[] = [];
      if (footnote[1]!.length) children.push(leaf("Whitespace", footnote[1]!.length));
      children.push(leaf("BracketMark", 2), leaf("Identifier", footnote[2]!.length), leaf("BracketMark", 1), leaf("Delimiter", 1));
      if (footnote[3]!.length) children.push(leaf("Whitespace", footnote[3]!.length));
      children.push(...parseInlines(footnote[4]!)); children.push(...ending(line));
      let end = i + 1;
      while (end < lines.length && /^(?: {2,}|\t)/.test(lines[end]!.content)) { children.push(...inlineLine(lines[end]!)); end++; }
      blocks.push(green("FootnoteDefinition", children, props([footnoteLabel, normalizeLabel(footnote[2]!)]))); i = end; continue;
    }
    if (/^( {0,3})>/.test(value)) {
      let end = i + 1; while (end < lines.length && (/^( {0,3})>/.test(lines[end]!.content) || !isBlockStart(lines, end))) end++;
      blocks.push(quoteBlock(lines, i, end)); i = end; continue;
    }
    if (i + 1 < lines.length && /^ {0,3}:[ \t]+/.test(lines[i + 1]!.content)) {
      let end = i + 2;
      while (end < lines.length && (/^ {0,3}:[ \t]+/.test(lines[end]!.content) || /^(?: {2,}|\t)/.test(lines[end]!.content))) end++;
      blocks.push(definitionList(lines, i, end)); i = end; continue;
    }
    if (/^( {0,3})\(@(?:[^)]+)?\)[ \t]+/.test(value)) {
      let end = i + 1; while (end < lines.length && (/^( {0,3})\(@(?:[^)]+)?\)[ \t]+/.test(lines[end]!.content) || /^(?: {2,}|\t)/.test(lines[end]!.content))) end++;
      blocks.push(exampleList(lines, i, end)); i = end; continue;
    }
    const bullet = /^( {0,3})[-+*][ \t]+/.test(value), ordered = /^( {0,3})(?:\d+|#|[A-Za-z]|[ivxlcdmIVXLCDM]+)[.)][ \t]+/.test(value);
    if (bullet || ordered) {
      let end = i + 1;
      while (end < lines.length && !(/^[ \t]*$/.test(lines[end]!.content) && end + 1 < lines.length && !/^(?: {2,}|\t)/.test(lines[end + 1]!.content)) && !(/^( {0,3})#{1,6}[ \t]/.test(lines[end]!.content))) end++;
      blocks.push(listBlock(lines, i, end, ordered)); i = end; continue;
    }
    if (i + 1 < lines.length && value.includes("|") && /^ {0,3}\|?[ \t]*:?-{3,}:?(?:[ \t]*\|[ \t]*:?-{3,}:?)+[ \t]*\|?[ \t]*$/.test(lines[i + 1]!.content)) {
      let end = i + 2; while (end < lines.length && lines[end]!.content.includes("|") && lines[end]!.content.trim()) end++;
      blocks.push(pipeTable(lines, i, end)); i = end; continue;
    }
    if (/^\+(?:[-=:]+\+)+[ \t]*$/.test(value)) {
      let end = i + 1; while (end < lines.length && (/^[+|]/.test(lines[end]!.content) || /^[ \t]*$/.test(lines[end]!.content))) end++;
      blocks.push(genericTable("GridTable", lines, i, end)); i = end; continue;
    }
    if (i + 1 < lines.length && /^(?:-{3,}[ \t]+)+-{3,}[ \t]*$/.test(lines[i + 1]!.content)) {
      let end = i + 2, multiline = false;
      while (end < lines.length && !/^[ \t]*$/.test(lines[end]!.content)) { if (/^(?:-{3,}[ \t]+)+-{3,}[ \t]*$/.test(lines[end]!.content)) multiline = true; end++; }
      blocks.push(genericTable(multiline ? "MultilineTable" : "SimpleTable", lines, i, end)); i = end; continue;
    }
    if (/^ {0,3}(?:Table:|:)\s+/.test(value)) {
      const prefix = /^ {0,3}(?:Table:|:)\s+/.exec(value)![0];
      blocks.push(green("TableCaption", [leaf("Delimiter", prefix.length), ...parseInlines(value.slice(prefix.length)), ...ending(line)])); i++; continue;
    }
    if (/^ {0,3}\|/.test(value)) {
      let end = i + 1; while (end < lines.length && /^ {0,3}\|/.test(lines[end]!.content)) end++;
      const rows: GreenNode[] = []; for (let n = i; n < end; n++) rows.push(green("LineBlockLine", inlineLine(lines[n]!)));
      blocks.push(green("LineBlock", rows)); i = end; continue;
    }
    if (/^(?: {4}|\t)/.test(value)) {
      let end = i + 1; while (end < lines.length && (/^(?: {4}|\t)/.test(lines[end]!.content) || /^[ \t]*$/.test(lines[end]!.content))) end++;
      const children: GreenNode[] = []; for (let n = i; n < end; n++) children.push(...opaqueLine(lines[n]!, "OpaqueBody"));
      blocks.push(green("IndentedCodeBlock", children)); i = end; continue;
    }
    const htmlOpen = /^ {0,3}<div\b[^>]*>/i.exec(value);
    if (htmlOpen) {
      let end = i + 1; while (end < lines.length && !/<\/div>[ \t]*$/i.test(lines[end]!.content)) end++;
      if (end < lines.length) end++;
      const all = source(lines, i, end, text), openAt = all.indexOf("<"), openEnd = all.indexOf(">", openAt) + 1, closeAt = all.toLocaleLowerCase().lastIndexOf("</div>");
      if (closeAt >= openEnd) {
        const children: GreenNode[] = [];
        if (openAt) children.push(leaf("Whitespace", openAt));
        children.push(leaf("HtmlTag", openEnd - openAt));
        children.push(...parseBlocks(all.slice(openEnd, closeAt)).root.children);
        children.push(leaf("HtmlTag", 6));
        if (closeAt + 6 < all.length) children.push(...parseInlines(all.slice(closeAt + 6)));
        blocks.push(green("NativeHtmlDiv", children, props([htmlTagName, "div"]))); i = end; continue;
      }
    }
    if (/^ {0,3}(?:\\begin\{|\\\[|\\\]|\\[A-Za-z]+(?:\{|\s|$))/.test(value)) {
      blocks.push(green("RawBlock", opaqueLine(line, "OpaqueBody"), props([rawFormat, "tex"]))); i++; continue;
    }
    if (/^ {0,3}<[A-Za-z!/]/.test(value)) {
      blocks.push(green("RawBlock", opaqueLine(line, "OpaqueBody"), props([rawFormat, "html"]))); i++; continue;
    }
    let end = i + 1;
    while (end < lines.length && !isBlockStart(lines, end)) {
      if (end + 1 < lines.length && /^( {0,3})(=+|-+)[ \t]*$/.test(lines[end + 1]!.content)) break;
      end++;
    }
    blocks.push(paragraph(lines, i, end, text)); i = end;
  }
  return { root: greenDocument(blocks), checkpoints: Object.freeze(checkpoints) };
}
