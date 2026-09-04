import {
  exampleLabel, explicitIdentifier, fenceCharacter, fenceClosed, fenceInfo, fenceLength,
  footnoteLabel, green, greenDocument, headingLevel, htmlTagName, leaf, listTight, normalizedReferenceLabel,
  orderedListDelimiter, orderedListStart, orderedListStyle, props, rawFormat,
  referenceDestination, referenceTitle, tableAlignments, tableColumnCount, taskChecked,
  type GreenNode, type NodeKind, type PropertyBag,
} from "../nodes.js";
import { normalizeLabel, parseAttributeList, parseInlines } from "../inline/parser.js";
import { tablePipePositions } from "./table-pipes.js";

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
  readonly blockKind: NodeKind | null;
}

export interface BlockParseResult {
  readonly root: GreenNode;
  readonly checkpoints: readonly BlockCheckpoint[];
}

const containerBlocks = new Set<NodeKind>([
  "BlockQuote", "BulletList", "OrderedList", "DefinitionList", "FencedDiv",
  "NativeHtmlDiv", "FootnoteDefinition", "PipeTable", "SimpleTable",
  "MultilineTable", "GridTable",
]);

function checkpointsFor(lines: readonly LineRecord[], blocks: readonly GreenNode[]): readonly BlockCheckpoint[] {
  const result: BlockCheckpoint[] = [];
  let blockIndex = 0;
  let blockFrom = 0;
  for (let line = 0; line < lines.length; line++) {
    const offset = lines[line]!.start;
    while (blockIndex < blocks.length && offset >= blockFrom + blocks[blockIndex]!.length) {
      blockFrom += blocks[blockIndex]!.length;
      blockIndex++;
    }
    const block = blocks[blockIndex] ?? null;
    result.push(Object.freeze({
      line,
      offset,
      state: block === null ? "base" : block.kind === "Paragraph" ? "paragraph" : containerBlocks.has(block.kind) ? "container" : "base",
      blockKind: block?.kind ?? null,
    }));
  }
  return Object.freeze(result);
}

export function checkpointsForTree(text: string, root: GreenNode): readonly BlockCheckpoint[] {
  return checkpointsFor(scanLines(text), root.children);
}

export function scanLines(text: string): readonly LineRecord[] {
  const lines: LineRecord[] = [];
  let start = 0;
  while (start < text.length) {
    let contentEnd = start;
    while (contentEnd < text.length) {
      const code = text.charCodeAt(contentEnd);
      if (code === 10 || code === 13) break;
      contentEnd++;
    }
    const hasEnding = contentEnd < text.length;
    const end = hasEnding
      ? contentEnd + (text[contentEnd] === "\r" && text[contentEnd + 1] === "\n" ? 2 : 1)
      : text.length;
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
  const first = lines[from]!, indent = match[1]!, marker = match[2]!, children: GreenNode[] = [];
  if (indent) children.push(leaf("Whitespace", indent.length));
  children.push(leaf("FenceMark", marker.length));
  if (first.content.length > indent.length + marker.length) children.push(...parseInlines(first.content.slice(indent.length + marker.length)));
  children.push(...ending(first));
  const bodyEnd = close ?? lines.length;
  if (bodyEnd > from + 1) {
    const innerStart = lines[from + 1]!.start;
    const innerEnd = lines[bodyEnd - 1]!.end;
    children.push(...parseBlocks(text.slice(innerStart, innerEnd)).root.children);
  }
  if (close !== null) children.push(...opaqueLine(lines[close]!, "FenceMark"));
  return green("FencedDiv", children, props([fenceCharacter, ":"], [fenceLength, marker.length], [fenceInfo, match[3]!.trim()], [fenceClosed, close !== null]));
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

function tableRow(line: LineRecord, pipes: readonly number[]): GreenNode {
  const children: GreenNode[] = [];
  const firstPipe = pipes[0] ?? -1;
  const lastPipe = pipes.at(-1) ?? -1;
  const hasLeadingDelimiter = firstPipe >= 0
    && line.content.slice(0, firstPipe).trim().length === 0;
  const hasTrailingDelimiter = lastPipe >= 0
    && line.content.slice(lastPipe + 1).trim().length === 0;
  let cursor = 0;
  for (const at of pipes) {
    if (at > cursor) {
      const content = line.content.slice(cursor, at);
      children.push(
        cursor === 0 && hasLeadingDelimiter
          ? leaf("Whitespace", content.length)
          : green("TableCell", parseInlines(content)),
      );
    }
    children.push(leaf("TableDelimiter", 1)); cursor = at + 1;
  }
  if (cursor < line.content.length) {
    const content = line.content.slice(cursor);
    children.push(
      hasTrailingDelimiter
        ? leaf("Whitespace", content.length)
        : green("TableCell", parseInlines(content)),
    );
  }
  children.push(...ending(line));
  return green("TableRow", children);
}

function pipeTableAlignments(value: string): ("center" | "left" | "right" | "default")[] | null {
  let content = value.trim();
  if (content.startsWith("|")) content = content.slice(1);
  if (content.endsWith("|")) content = content.slice(0, -1);
  const cells = content.split("|").map(cell => cell.trim());
  if (cells.length === 0 || cells.some(cell => !/^:?-{3,}:?$/.test(cell))) return null;
  return cells.map(cell => cell.startsWith(":") && cell.endsWith(":")
    ? "center"
    : cell.startsWith(":")
      ? "left"
      : cell.endsWith(":")
        ? "right"
        : "default");
}

function pipeTable(
  lines: readonly LineRecord[],
  from: number,
  to: number,
  alignments: readonly ("center" | "left" | "right" | "default")[],
  rowPipes: readonly (readonly number[])[],
): GreenNode {
  const children: GreenNode[] = [green("TableHead", [
    tableRow(lines[from]!, rowPipes[0]!),
    tableRow(lines[from + 1]!, rowPipes[1]!),
  ])];
  if (to > from + 2) children.push(green("TableBody", Array.from(
    { length: to - from - 2 },
    (_, i) => tableRow(lines[from + i + 2]!, rowPipes[i + 2]!),
  )));
  return green("PipeTable", children, props([tableAlignments, Object.freeze(alignments)], [tableColumnCount, alignments.length]));
}

function pipeTableAt(
  lines: readonly LineRecord[],
  from: number,
): { readonly node: GreenNode; readonly end: number } | null {
  if (from + 1 >= lines.length || !lines[from]!.content.includes("|")) return null;
  const alignments = pipeTableAlignments(lines[from + 1]!.content);
  if (!alignments) return null;

  const headerPipes = tablePipePositions(lines[from]!.content);
  if (headerPipes.length === 0) return null;
  const rowPipes: (readonly number[])[] = [
    headerPipes,
    tablePipePositions(lines[from + 1]!.content),
  ];
  let end = from + 2;
  while (end < lines.length) {
    const content = lines[end]!.content;
    if (!content.includes("|") || !content.trim()) break;
    const pipes = tablePipePositions(content);
    if (pipes.length === 0) break;
    rowPipes.push(pipes);
    end++;
  }
  return { node: pipeTable(lines, from, end, alignments, rowPipes), end };
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

function validOrderedMarker(marker: string): boolean {
  const delimiter = marker.at(-1);
  const value = marker.slice(0, -1);
  return !(delimiter === "." && /^[A-Z]$/.test(value));
}

function listBlock(lines: readonly LineRecord[], from: number, to: number, ordered: boolean): GreenNode {
  const children: GreenNode[] = [];
  const markerAt = (line: LineRecord, orderedMarker: boolean): RegExpExecArray | null => {
    if (!orderedMarker) return /^( *)[-+*][ \t]+/.exec(line.content);
    const match = /^( *)((?:\d+|#|[A-Za-z]|[ivxlcdmIVXLCDM]+)[.)])[ \t]+/.exec(line.content);
    return match && validOrderedMarker(match[2]!) ? match : null;
  };
  const firstMarker = markerAt(lines[from]!, ordered);
  const baseIndent = firstMarker?.[1]?.length ?? 0;
  let i = from;
  let loose = false;
  let firstStart = 1, delimiter: "." | ")" = ".", style = "decimal";
  while (i < to) {
    const line = lines[i]!;
    const rawMatch = ordered
      ? /^( {0,3})((?:\d+|#|[A-Za-z]|[ivxlcdmIVXLCDM]+)([.)]))([ \t]+)(.*)$/.exec(line.content)
      : /^( {0,3})([-+*])([ \t]+)(.*)$/.exec(line.content);
    const match = ordered && rawMatch && !validOrderedMarker(rawMatch[2]!) ? null : rawMatch;
    if (!match || match[1]!.length !== baseIndent) { i++; continue; }
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
    let continuation = i + 1;
    while (continuation < to) {
      const candidate = lines[continuation]!;
      const nestedBullet = markerAt(candidate, false);
      const nestedOrdered = markerAt(candidate, true);
      const nestedMarker = nestedBullet ?? nestedOrdered;
      if (nestedMarker && nestedMarker[1]!.length === baseIndent) break;
      if (nestedMarker && nestedMarker[1]!.length > baseIndent) {
        const nestedIndent = nestedMarker[1]!.length;
        let nestedEnd = continuation + 1;
        while (nestedEnd < to) {
          const following = lines[nestedEnd]!;
          const followingMarker = markerAt(following, false) ?? markerAt(following, true);
          if (followingMarker && followingMarker[1]!.length <= baseIndent) break;
          // A less-indented nonblank line resumes the parent item.
          if (!followingMarker && following.content.trim() && /^ */.exec(following.content)![0].length < nestedIndent) break;
          nestedEnd++;
        }
        itemChildren.push(listBlock(lines, continuation, nestedEnd, nestedOrdered !== null));
        continuation = nestedEnd;
        continue;
      }
      if (/^[ \t]*$/.test(candidate.content)) {
        loose = true;
        itemChildren.push(...inlineLine(candidate)); continuation++;
        continue;
      }
      const previous = itemChildren.at(-1);
      if (previous?.kind === "LineEnding") {
        itemChildren[itemChildren.length - 1] = green("SoftBreak", [previous]);
      }
      const continuationIndent = /^(?: +|\t)/.exec(candidate.content)?.[0] ?? "";
      const nestedDiv = fencedDivOpener(candidate.content);
      if (nestedDiv) {
        const close = fencedDivClose(lines, continuation, nestedDiv, to);
        const nestedEnd = close === null ? to : close + 1;
        const nestedSource = lines.slice(continuation, nestedEnd)
          .map(nestedLine => nestedLine.content + nestedLine.ending).join("");
        itemChildren.push(...parseBlocks(nestedSource).root.children);
        continuation = nestedEnd;
        continue;
      }
      const mathOpener = /^(?:\$\$|\\\[|\\\\\[)[ \t]*$/.exec(candidate.content.slice(continuationIndent.length))?.[0]?.trim();
      if (mathOpener) {
        const close = mathOpener === "$$" ? "$$" : mathOpener.startsWith("\\\\") ? "\\\\]" : "\\]";
        let mathEnd = continuation + 1;
        while (mathEnd < to) {
          const closingLine = lines[mathEnd]!.content.trim();
          if (closingLine === close) { mathEnd++; break; }
          mathEnd++;
        }
        if (mathEnd > continuation + 1 && lines[mathEnd - 1]!.content.trim() === close) {
          // The opening line's list-continuation indentation is structural, not
          // inline space. Keep it losslessly as a separate leaf so Pandoc's
          // projection does not acquire a Space before display math.
          if (continuationIndent) itemChildren.push(leaf("Whitespace", continuationIndent.length));
          const mathSource = candidate.content.slice(continuationIndent.length) + candidate.ending
            + lines.slice(continuation + 1, mathEnd).map(mathLine => mathLine.content + mathLine.ending).join("");
          itemChildren.push(...parseInlines(mathSource));
          continuation = mathEnd;
          continue;
        }
      }
      if (continuationIndent) itemChildren.push(leaf("Whitespace", continuationIndent.length));
      itemChildren.push(...parseInlines(candidate.content.slice(continuationIndent.length)), ...ending(candidate));
      continuation++;
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
        const previousBody = children[children.length - 1]!;
        const bodyChildren = [...previousBody.children];
        const previousEnding = bodyChildren.at(-1);
        if (previousEnding?.kind === "LineEnding") bodyChildren[bodyChildren.length - 1] = green("SoftBreak", [previousEnding]);
        const continuation = lines[i]!;
        const indent = /^(?: +|\t)/.exec(continuation.content)?.[0] ?? "";
        if (indent) bodyChildren.push(leaf("Whitespace", indent.length));
        bodyChildren.push(...parseInlines(continuation.content.slice(indent.length)), ...ending(continuation));
        children[children.length - 1] = green("DefinitionBody", bodyChildren); i++;
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
  let headEnd = 0;
  if (kind === "SimpleTable") {
    headEnd = Math.min(2, rows.length);
  } else if (kind === "MultilineTable") {
    const separator = lines.slice(from + 1, to).findIndex(line => /^(?:-{3,}[ \t]+)+-{3,}[ \t]*$/.test(line.content));
    headEnd = separator < 0 ? 1 : separator + 2;
  } else {
    const separator = lines.slice(from, to).findIndex(line => /^\+(?:[=:]+\+)+[ \t]*$/.test(line.content));
    headEnd = separator < 0 ? 1 : separator + 1;
  }
  const children: GreenNode[] = [];
  if (headEnd) children.push(green("TableHead", rows.slice(0, headEnd)));
  if (headEnd < rows.length) children.push(green("TableBody", rows.slice(headEnd)));
  const alignments = Array.from({ length: columns }, (_, index) =>
    kind === "GridTable" ? "default" : kind === "MultilineTable" || index === 0 ? "left" : "default"
  ) as ("left" | "right" | "center" | "default")[];
  return green(kind, children, props(
    [tableColumnCount, columns],
    [tableAlignments, Object.freeze(alignments)],
  ));
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
    if (!node.children.length) {
      // Inline constructs may span physical quote lines (for example a code
      // span whose closing backtick occurs on the next line). In that case a
      // stripped `>` prefix falls inside one opaque leaf rather than on a
      // child boundary. Split the leaf around every such prefix so the quote
      // remains lossless without changing the inline construct's extent.
      const inside = [...prefixes.entries()].filter(([offset]) => offset > start && offset < start + node.length);
      if (inside.length === 0) return node;
      const children: GreenNode[] = [];
      let cursor = start;
      for (const [offset, prefix] of inside) {
        if (offset > cursor) children.push(leaf(node.kind, offset - cursor, node.properties));
        children.push(...prefix);
        prefixes.delete(offset);
        cursor = offset;
      }
      if (cursor < start + node.length) children.push(leaf(node.kind, start + node.length - cursor, node.properties));
      return green(node.kind, children, node.properties);
    }
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

function fencedDivOpener(value: string): RegExpExecArray | null {
  // Pandoc accepts one class-like token or one braced attribute list. Extra
  // trailing prose makes the line ordinary paragraph text.
  return /^( {0,3})(:{3,})[ \t]*(\{[^}\r\n]*\}|[^\s:{}]+)[ \t]*$/.exec(value);
}

function fencedDivClose(
  lines: readonly LineRecord[],
  from: number,
  opener: RegExpExecArray,
  to = lines.length,
): number | null {
  const fenceStack = [opener[2]!.length];
  for (let line = from + 1; line < to; line++) {
    const value = lines[line]!.content;
    const nested = fencedDivOpener(value);
    if (nested) {
      fenceStack.push(nested[2]!.length);
      continue;
    }
    const closing = /^( {0,3})(:{3,})[ \t]*$/.exec(value);
    if (closing && closing[2]!.length >= fenceStack.at(-1)!) {
      fenceStack.pop();
      if (fenceStack.length === 0) return line;
    }
  }
  return null;
}

function isBlockStart(lines: readonly LineRecord[], at: number, text: string): boolean {
  const value = lines[at]?.content ?? "";
  return /^[ \t]*$/.test(value) || /^( {0,3})(#{1,6})(?:[ \t]+|$)/.test(value) || /^( {0,3})(`{3,}|~{3,})/.test(value) || fencedDivOpener(value) !== null
    || /^( {0,3})(?:[-+*][ \t]+|(?:\d+|#)[.)][ \t]+)/.test(value)
    || referenceAt(lines, at, text) !== null || /^ {0,3}\[\^[^\]]+\]:/.test(value)
    || /^ {0,3}(?:<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t/>])|<!--|<!DOCTYPE\b|<\?|\\begin\{|\\\[)/i.test(value);
}

/** Parse block structure for a complete document or nested native container body. */
export function parseBlocks(text: string): BlockParseResult {
  const lines = scanLines(text), blocks: GreenNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!, value = line.content;
    if (/^[ \t]*$/.test(value)) {
      let end = i + 1; while (end < lines.length && /^[ \t]*$/.test(lines[end]!.content)) end++;
      blocks.push(blankBlock(lines, i, end)); i = end; continue;
    }
    if (i === 0 && /^\uFEFF?---[ \t]*$/.test(value)) {
      let close = i + 1; while (close < lines.length && !/^(?:---|\.\.\.)[ \t]*$/.test(lines[close]!.content)) close++;
      if (close < lines.length) {
        close++;
        const children: GreenNode[] = [];
        for (let n = i; n < close; n++) {
          const metadataLine = lines[n]!;
          if (n === i && metadataLine.content.startsWith("\uFEFF")) {
            children.push(leaf("Text", 1), leaf("Delimiter", metadataLine.content.length - 1), ...ending(metadataLine));
          } else {
            children.push(...opaqueLine(metadataLine, n === i || n === close - 1 ? "Delimiter" : "OpaqueBody"));
          }
        }
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
      if (close !== null) {
        blocks.push(fencedBlock(lines, i, close, fence)); i = close + 1; continue;
      }
    }
    const div = fencedDivOpener(value);
    if (div) {
      const close = fencedDivClose(lines, i, div);
      blocks.push(colonDiv(lines, i, close, div, text)); i = close === null ? lines.length : close + 1; continue;
    }
    const atx = /^( {0,3})(#{1,6})([ \t]*)(.*)$/.exec(value);
    if (atx && (atx[3]!.length > 0 || atx[4]!.length === 0)) { blocks.push(heading(line, atx)); i++; continue; }
    if (/^(?:-{3,}[ \t]+)+-{3,}[ \t]*$/.test(value) && i + 2 < lines.length) {
      let headerSeparator = i + 1;
      while (headerSeparator < lines.length && !/^(?:-{3,}[ \t]+)+-{3,}[ \t]*$/.test(lines[headerSeparator]!.content)) headerSeparator++;
      if (headerSeparator < lines.length) {
        let end = headerSeparator + 1;
        while (end < lines.length) {
          if (/^(?:-{3,}[ \t]+)+-{3,}[ \t]*$/.test(lines[end]!.content)) { end++; break; }
          end++;
        }
        blocks.push(genericTable("MultilineTable", lines, i, end)); i = end; continue;
      }
    }
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
      while (end < lines.length && /^(?: {2,}|\t)/.test(lines[end]!.content)) {
        const previousEnding = children.at(-1);
        if (previousEnding?.kind === "LineEnding") children[children.length - 1] = green("SoftBreak", [previousEnding]);
        const continuation = lines[end]!;
        const indent = /^(?: +|\t)/.exec(continuation.content)?.[0] ?? "";
        if (indent) children.push(leaf("Whitespace", indent.length));
        children.push(...parseInlines(continuation.content.slice(indent.length)), ...ending(continuation)); end++;
      }
      blocks.push(green("FootnoteDefinition", children, props([footnoteLabel, normalizeLabel(footnote[2]!)]))); i = end; continue;
    }
    if (/^( {0,3})>/.test(value)) {
      let end = i + 1; while (end < lines.length && (/^( {0,3})>/.test(lines[end]!.content) || !isBlockStart(lines, end, text))) end++;
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
    const bullet = /^( {0,3})[-+*][ \t]+/.test(value);
    const orderedMatch = /^( {0,3})((?:\d+|#|[A-Za-z]|[ivxlcdmIVXLCDM]+)[.)])[ \t]+/.exec(value);
    const ordered = orderedMatch !== null && validOrderedMarker(orderedMatch[2]!);
    if (bullet || ordered) {
      const listIndent = /^( {0,3})/.exec(value)?.[1]?.length ?? 0;
      let end = i + 1;
      while (end < lines.length) {
        const candidate = lines[end]!;
        if (/^( {0,3})#{1,6}[ \t]/.test(candidate.content)) break;
        const candidateBullet = /^( {0,3})[-+*][ \t]+/.exec(candidate.content);
        const candidateOrderedMatch = /^( {0,3})((?:\d+|#|[A-Za-z]|[ivxlcdmIVXLCDM]+)[.)])[ \t]+/.exec(candidate.content);
        const candidateOrdered = candidateOrderedMatch !== null
          && validOrderedMarker(candidateOrderedMatch[2]!);
        const candidateIndent = (candidateBullet ?? candidateOrderedMatch)?.[1]?.length;
        if (
          candidateIndent === listIndent
          && (candidateBullet !== null || candidateOrdered)
          && candidateOrdered !== ordered
        ) break;
        if (/^[ \t]*$/.test(candidate.content) && end + 1 < lines.length) {
          const next = lines[end + 1]!.content;
          const nextOrdered = /^( {0,3})((?:\d+|#|[A-Za-z]|[ivxlcdmIVXLCDM]+)[.)])[ \t]+/.exec(next);
          const nextListItem = /^( {0,3})[-+*][ \t]+/.test(next)
            || nextOrdered !== null && validOrderedMarker(nextOrdered[2]!);
          if (!nextListItem && !/^(?: {2,}|\t)/.test(next)) break;
        } else if (/^[ \t]*$/.test(candidate.content)) {
          break;
        }
        end++;
      }
      blocks.push(listBlock(lines, i, end, ordered)); i = end; continue;
    }
    const pipe = pipeTableAt(lines, i);
    if (pipe) { blocks.push(pipe.node); i = pipe.end; continue; }
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
      const caption = value.slice(prefix.length);
      const attrMatch = /^(.*?)([ \t]+)(\{[^}\r\n]*\})([ \t]*)$/.exec(caption);
      const attr = attrMatch ? parseAttributeList(attrMatch[3]!) : null;
      const children: GreenNode[] = [leaf("Delimiter", prefix.length)];
      children.push(...parseInlines(attr ? attrMatch![1]! : caption));
      if (attr) {
        children.push(leaf("Whitespace", attrMatch![2]!.length), attr);
        if (attrMatch![4]!.length) children.push(leaf("Whitespace", attrMatch![4]!.length));
      }
      children.push(...ending(line));
      blocks.push(green("TableCaption", children)); i++; continue;
    }
    if (/^ {0,3}\|/.test(value)) {
      let end = i + 1; while (end < lines.length && /^ {0,3}\|/.test(lines[end]!.content)) end++;
      const rows: GreenNode[] = [];
      for (let n = i; n < end; n++) {
        const lineBlockLine = /^( {0,3})\|([ \t]?)(.*)$/.exec(lines[n]!.content)!;
        rows.push(green("LineBlockLine", [
          ...(lineBlockLine[1]!.length ? [leaf("Whitespace", lineBlockLine[1]!.length)] : []),
          leaf("Delimiter", 1),
          ...(lineBlockLine[2]!.length ? [leaf("Whitespace", lineBlockLine[2]!.length)] : []),
          ...parseInlines(lineBlockLine[3]!),
          ...ending(lines[n]!),
        ]));
      }
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
    const texEnvironment = /^ {0,3}\\begin\{([^}\r\n]+)\}/.exec(value);
    if (texEnvironment) {
      const closePattern = new RegExp(`^ {0,3}\\\\end\\{${texEnvironment[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}[ \\t]*$`);
      let end = i + 1;
      while (end < lines.length && !closePattern.test(lines[end]!.content)) end++;
      if (end < lines.length) end++;
      const children: GreenNode[] = [];
      for (let n = i; n < end; n++) children.push(...opaqueLine(lines[n]!, "OpaqueBody"));
      blocks.push(green("Paragraph", [green("RawInline", children, props([rawFormat, "tex"]))])); i = end; continue;
    }
    const bracketMath = /^( {0,3})(\\\[|\\\\\[)/.exec(value);
    if (bracketMath) {
      const opener = bracketMath[2]!;
      const closer = opener.startsWith("\\\\") ? "\\\\]" : "\\]";
      let closeLine = i;
      let closeAt = value.indexOf(closer, bracketMath[1]!.length + opener.length);
      while (closeAt < 0 && ++closeLine < lines.length) {
        closeAt = lines[closeLine]!.content.indexOf(closer);
      }
      if (closeAt >= 0) {
        let end = closeLine + 1;
        while (end < lines.length && !isBlockStart(lines, end, text)) end++;
        const children: GreenNode[] = [];
        if (bracketMath[1]!.length) children.push(leaf("Whitespace", bracketMath[1]!.length));
        const paragraphSource = text.slice(lines[i]!.start + bracketMath[1]!.length, lines[end - 1]!.end);
        children.push(...parseInlines(paragraphSource));
        blocks.push(green("Paragraph", children)); i = end; continue;
      }
    }
    if (/^ {0,3}(?:\\\[|\\\]|\\[A-Za-z]+(?:\{|\s|$))/.test(value)) {
      blocks.push(green("RawBlock", opaqueLine(line, "OpaqueBody"), props([rawFormat, "tex"]))); i++; continue;
    }
    // A URI/email autolink starts with an ASCII letter too, but it is not an
    // HTML block. Require an actual tag boundary after the tag name.
    if (/^ {0,3}<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t/>])|!--|!DOCTYPE\b|\?)/i.test(value)) {
      blocks.push(green("RawBlock", opaqueLine(line, "OpaqueBody"), props([rawFormat, "html"]))); i++; continue;
    }
    let end = i + 1;
    while (end < lines.length && !isBlockStart(lines, end, text)) {
      if (end + 1 < lines.length && /^( {0,3})(=+|-+)[ \t]*$/.test(lines[end + 1]!.content)) break;
      end++;
    }
    blocks.push(paragraph(lines, i, end, text)); i = end;
  }
  const root = greenDocument(blocks);
  return { root, checkpoints: checkpointsFor(lines, blocks) };
}
