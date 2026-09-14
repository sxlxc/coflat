import type { CslJsonItem } from "../../core/citations/csl-json";
import defaultCslStyle from "./ieee.csl?raw";
import type {
  BibliographyEntryPresentation,
  CitationClusterPresentation,
  CitationFormatter,
  CitationItemPresentation,
} from "./types";

type CiteprocEngine = import("@citation-js/core").CiteprocEngine;
type CiteprocCitationItem = import("@citation-js/core").CiteprocCitationItem;

// Numeric IEEE citations have no author component. citeproc's intext extension
// lets narrative citations reuse the style's author macro without changing the
// standard CSL asset supplied to Pandoc exports.
const defaultNarrativeStyle = defaultCslStyle.replace(
  "</style>",
  '<intext><layout><text macro="author"/></layout></intext></style>',
);

// Citation locator parsing is a port of pandoc's Text.Pandoc.Citeproc.Locator
// (https://github.com/jgm/pandoc/blob/main/src/Text/Pandoc/Citeproc/Locator.hs).
// The editor preview must split citation suffixes into label, locator, and
// suffix exactly the way the publication pipeline does, so the algorithm and
// the label spellings below mirror that module as run with the en-US locale
// (plus the "ch." chapter override embedded in the IEEE style). Each suffix
// becomes a locator only when it starts with a recognized label term or a
// digit-bearing word; prose like "Lemma 2.3" stays a plain suffix.
const LOCATOR_LABELS: ReadonlyMap<string, string> = new Map([
  ["book", "book"],
  ["books", "book"],
  ["bk.", "book"],
  ["bks.", "book"],
  ["chapter", "chapter"],
  ["chapters", "chapter"],
  ["chap.", "chapter"],
  ["chaps.", "chapter"],
  ["ch.", "chapter"],
  ["c.", "chapter"],
  ["cc.", "chapter"],
  ["column", "column"],
  ["columns", "column"],
  ["col.", "column"],
  ["cols.", "column"],
  ["figure", "figure"],
  ["figures", "figure"],
  ["fig.", "figure"],
  ["figs.", "figure"],
  ["folio", "folio"],
  ["folios", "folio"],
  ["fol.", "folio"],
  ["fols.", "folio"],
  ["issue", "issue"],
  ["issues", "issue"],
  ["no.", "issue"],
  ["nos.", "issue"],
  ["line", "line"],
  ["lines", "line"],
  ["l.", "line"],
  ["ll.", "line"],
  ["note", "note"],
  ["notes", "note"],
  ["n.", "note"],
  ["nn.", "note"],
  ["opus", "opus"],
  ["opera", "opus"],
  ["op.", "opus"],
  ["opp.", "opus"],
  ["page", "page"],
  ["pages", "page"],
  ["p.", "page"],
  ["pp.", "page"],
  ["paragraph", "paragraph"],
  ["paragraphs", "paragraph"],
  ["para.", "paragraph"],
  ["paras.", "paragraph"],
  ["¶", "paragraph"],
  ["¶¶", "paragraph"],
  ["part", "part"],
  ["parts", "part"],
  ["pt.", "part"],
  ["pts.", "part"],
  ["section", "section"],
  ["sections", "section"],
  ["sec.", "section"],
  ["secs.", "section"],
  ["§", "section"],
  ["§§", "section"],
  ["sub verbo", "sub-verbo"],
  ["sub verbis", "sub-verbo"],
  ["s.v.", "sub-verbo"],
  ["s.vv.", "sub-verbo"],
  ["verse", "verse"],
  ["verses", "verse"],
  ["v.", "verse"],
  ["vv.", "verse"],
  ["volume", "volume"],
  ["volumes", "volume"],
  ["vol.", "volume"],
  ["vols.", "volume"],
]);

interface ParsedLocator {
  readonly label?: string;
  readonly locator?: string;
  readonly suffix?: string;
}

interface LocatorWord {
  readonly text: string;
  readonly digitLike: boolean;
  readonly next: number;
}

// pandoc's splitInp: the suffix is tokenized at whitespace and punctuation
// except ':', so tokens are runs of ordinary characters plus single split
// characters.
function locatorTokens(text: string): string[] {
  return text.match(/(?:[^\s\p{P}]|:)+|\s|\p{P}/gu) ?? [];
}

function isSpaceToken(token: string): boolean {
  return /^\s$/u.test(token);
}

// pandoc's isLocatorPunct: punctuation that ends a page unit, except page
// range dashes and the volume:page colon.
function isLocatorPunct(token: string): boolean {
  return token.length === 1 && /\p{P}/u.test(token) && !"-–:".includes(token);
}

// pandoc's pPageUnit: a token consisting solely of roman-numeral letters is
// digit-like on its own; any other run is digit-like only when it contains a
// digit.
function locatorUnit(tokens: string[], start: number): LocatorWord | null {
  const token = tokens[start];
  if (token === undefined) return null;
  if (/^[ivxlcdm]+$/i.test(token)) {
    return { text: token, digitLike: true, next: start + 1 };
  }
  let next = start;
  let text = "";
  while (next < tokens.length) {
    const current = tokens[next];
    if (isSpaceToken(current) || isLocatorPunct(current)) break;
    text += current;
    next += 1;
  }
  if (next === start) return null;
  return { text, digitLike: /\d/.test(text), next };
}

// pandoc's pPageSeq: units joined by single periods; a trailing period is
// left for the suffix.
function locatorSequence(tokens: string[], start: number): LocatorWord | null {
  const first = locatorUnit(tokens, start);
  if (!first) return null;
  let { text, digitLike, next } = first;
  while (tokens[next] === ".") {
    const unit = locatorUnit(tokens, next + 1);
    if (!unit) break;
    text += `.${unit.text}`;
    digitLike = digitLike || unit.digitLike;
    next = unit.next;
  }
  return { text, digitLike, next };
}

const LOCATOR_BRACKETS: ReadonlyMap<string, string> = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

// One part of a locator word: a balanced bracketed sequence or a plain one.
function locatorWordPart(tokens: string[], start: number): LocatorWord | null {
  const open = tokens[start];
  const close = open === undefined ? undefined : LOCATOR_BRACKETS.get(open);
  if (close === undefined) return locatorSequence(tokens, start);
  if (tokens[start + 1] === close) {
    return { text: `${open}${close}`, digitLike: false, next: start + 2 };
  }
  const inner = locatorSequence(tokens, start + 1);
  if (!inner || tokens[inner.next] !== close) return null;
  return {
    text: `${open}${inner.text}${close}`,
    digitLike: inner.digitLike,
    next: inner.next + 1,
  };
}

// pandoc's pLocatorWordIntegrated: an optional "," or ";" separator, at most
// one space, then one or more bracketed or plain sequences.
function locatorWord(tokens: string[], start: number, isFirst: boolean): LocatorWord | null {
  let next = start;
  let text = "";
  if (!isFirst && (tokens[next] === "," || tokens[next] === ";")) {
    text = tokens[next];
    next += 1;
  }
  if (isSpaceToken(tokens[next] ?? "")) {
    text += " ";
    next += 1;
  }
  const first = locatorWordPart(tokens, next);
  if (!first) return null;
  text += first.text;
  let digitLike = first.digitLike;
  next = first.next;
  for (;;) {
    const part = locatorWordPart(tokens, next);
    if (!part) break;
    text += part.text;
    digitLike = digitLike || part.digitLike;
    next = part.next;
  }
  return { text, digitLike, next };
}

// pandoc's pLocatorLabel': grow the candidate over tokens, case-folded and
// trimmed, and keep the longest term match.
function locatorLabel(tokens: string[]): { label: string | undefined; next: number } {
  let label: string | undefined;
  let next = 0;
  let candidate = "";
  for (let index = 0; index < tokens.length; index += 1) {
    candidate += tokens[index];
    const term = LOCATOR_LABELS.get(candidate.trim().toLowerCase());
    if (term !== undefined) {
      label = term;
      next = index + 1;
    }
  }
  return { label, next };
}

// pandoc's pLocatorDelimited: an explicit {…} locator. Its content is any
// tokens, with at most single-token […] groups, up to the closing "}".
function delimitedLocator(tokens: string[]): ParsedLocator | null {
  if (tokens[0] !== "{") return null;
  let index = 1;
  let inside = "";
  let close = -1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "}") {
      close = index;
      break;
    }
    if (token === "{") return null;
    if (token === "[") {
      const after = tokens[index + 1];
      if (after === "]") {
        inside += "[]";
        index += 2;
        continue;
      }
      if (after === undefined || LOCATOR_BRACKETS.has(after) || after === "]") return null;
      if (tokens[index + 2] !== "]") return null;
      inside += `[${after}]`;
      index += 3;
      continue;
    }
    inside += token;
    index += 1;
  }
  if (close < 0) return null;
  const suffix = tokens.slice(close + 1).join("");
  const inner = tokens.slice(1, close);
  let start = 0;
  while (start < inner.length && isSpaceToken(inner[start])) start += 1;
  const { label, next } = locatorLabel(inner.slice(start));
  const locator = inner.slice(start + next).join("").trim();
  if (label !== undefined) {
    return {
      label,
      ...(locator ? { locator } : {}),
      ...(suffix ? { suffix } : {}),
    };
  }
  // pandoc's digit lookahead: a single digit token implies "page". Otherwise
  // pandoc keeps an unlabeled locator, which citeproc-js would force back to
  // the page label, so the suffix preserves the same visible result instead.
  if (/^\d$/.test(inner[start] ?? "")) {
    return {
      label: "page",
      locator: inside.trim(),
      ...(suffix ? { suffix } : {}),
    };
  }
  if (!inside.trim()) return suffix ? { suffix } : {};
  return { suffix: ` ${inside.trim()}${suffix}` };
}

// pandoc's pLocatorIntegrated: an optional label, then one or more locator
// words. With an implicit "page" label every word must contain a digit; with
// an explicit label roman numerals and digit-bearing runs also qualify.
function integratedLocator(tokens: string[]): ParsedLocator | null {
  const { label, next } = locatorLabel(tokens);
  const implicit = label === undefined;
  const accepts = (word: LocatorWord): boolean =>
    implicit ? /\d/.test(word.text) : word.digitLike;
  const first = locatorWord(tokens, next, !implicit);
  if (!first || !accepts(first)) return null;
  let text = first.text;
  let end = first.next;
  for (;;) {
    const word = locatorWord(tokens, end, false);
    if (!word || !accepts(word)) break;
    text += word.text;
    end = word.next;
  }
  const suffix = tokens.slice(end).join("");
  return {
    label: label ?? "page",
    locator: text.trim(),
    ...(suffix ? { suffix } : {}),
  };
}

export function parseLocator(raw: string | undefined): ParsedLocator {
  // pandoc's reader collapses whitespace runs in citation suffixes before
  // Text.Pandoc.Citeproc.Locator sees them, and its parser first skips an
  // optional comma and space.
  const text = (raw ?? "").replace(/\s+/g, " ").trim().replace(/^,\s*/, "").trim();
  if (!text) return {};
  const tokens = locatorTokens(text);
  const parsed = delimitedLocator(tokens) ?? integratedLocator(tokens);
  if (parsed) return parsed;
  return { suffix: `, ${text}` };
}

function citeprocItem(item: CitationItemPresentation): CiteprocCitationItem {
  const locator = parseLocator(item.locator);
  return {
    id: item.id,
    ...(locator.label ? { label: locator.label } : {}),
    ...(locator.locator ? { locator: locator.locator } : {}),
    ...(locator.suffix ? { suffix: locator.suffix } : {}),
    ...(item.prefix ? { prefix: `${item.prefix.trim()} ` } : {}),
    ...(item.suppressAuthor ? { "suppress-author": true } : {}),
  };
}

function entryId(
  raw: string | readonly string[] | undefined,
  known: ReadonlySet<string>,
): string | undefined {
  if (typeof raw === "string") return known.has(raw) ? raw : undefined;
  return raw?.find((id) => known.has(id));
}

export class CslProcessor implements CitationFormatter {
  readonly keys: ReadonlySet<string>;
  private readonly engine: CiteprocEngine;
  private registeredIds: readonly string[] = [];
  private readonly renderedByFrom = new Map<number, string>();

  private constructor(entries: readonly CslJsonItem[], engine: CiteprocEngine) {
    this.keys = new Set(entries.map((entry) => entry.id));
    this.engine = engine;
  }

  static async create(
    entries: readonly CslJsonItem[],
    styleXml?: string,
  ): Promise<CslProcessor> {
    const [core, { default: CSL }] = await Promise.all([
      import("@citation-js/core"),
      import("citeproc"),
      import("@citation-js/plugin-csl"),
    ]);
    const { locales } = core.plugins.config.get("@csl");
    const items = new Map(entries.map((entry) => [entry.id, entry]));
    // Own the engine directly: citation-js retains its engines and their item
    // closures in a module-level cache with no release operation.
    const engine = new CSL.Engine({
      retrieveItem(id) {
        const item = items.get(id);
        if (!item) throw new Error(`Unknown bibliography item: ${id}`);
        return item;
      },
      retrieveLocale(locale) {
        if (locales.has(locale)) return locales.get(locale);
        const alternate = locale.replace("-", "_");
        return locales.has(alternate) ? locales.get(alternate) : false;
      },
    }, styleXml ?? defaultNarrativeStyle, "en-US", true);
    engine.setOutputFormat("html");
    return new CslProcessor(entries, engine);
  }

  registerCitations(clusters: readonly CitationClusterPresentation[]): void {
    const ids = [...new Set(clusters.flatMap((cluster) => (
      cluster.items.map((item) => item.id).filter((id) => this.keys.has(id))
    )))];
    this.registeredIds = ids;
    this.renderedByFrom.clear();
    this.engine.updateItems(ids);
    const previous: Array<[string, number]> = [];
    const registered: CitationClusterPresentation[] = [];
    clusters.forEach((cluster, index) => {
      const citationItems = cluster.items
        .filter((item) => this.keys.has(item.id))
        .map(citeprocItem);
      if (citationItems.length === 0) return;
      const citationID = `cite-${index}`;
      registered.push(cluster);
      const [, updates] = this.engine.processCitationCluster({
        citationID,
        citationItems,
        properties: {
          noteIndex: 0,
          ...(cluster.narrative ? { mode: "composite" as const } : {}),
        },
      }, previous, []);
      for (const [position, html] of updates) {
        const updated = registered[position];
        if (!updated) throw new Error(`Unknown citation position: ${position}`);
        this.renderedByFrom.set(updated.from, html);
      }
      previous.push([citationID, 0]);
    });
  }

  cite(cluster: CitationClusterPresentation): string {
    const html = this.renderedByFrom.get(cluster.from);
    if (html === undefined) throw new Error("Citation was not registered");
    return cluster.narrative && cluster.raw.startsWith("(") ? `(${html})` : html;
  }

  bibliographyEntries(): readonly BibliographyEntryPresentation[] {
    if (this.registeredIds.length === 0) return [];
    const bibliography = this.engine.makeBibliography();
    if (!bibliography) return [];
    const [parameters, entries] = bibliography;
    return entries.map((html, index) => ({
      html: html.trim(),
      id: entryId(parameters.entry_ids?.[index], this.keys) ?? "",
    })).filter((entry) => entry.id !== "");
  }
}
