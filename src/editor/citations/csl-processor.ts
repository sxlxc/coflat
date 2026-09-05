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

const LOCATOR_LABELS: ReadonlyMap<string, string> = new Map([
  ["chapter", "chapter"],
  ["chapters", "chapter"],
  ["chap.", "chapter"],
  ["ch.", "chapter"],
  ["equation", "equation"],
  ["equations", "equation"],
  ["eq.", "equation"],
  ["eqq.", "equation"],
  ["figure", "figure"],
  ["figures", "figure"],
  ["fig.", "figure"],
  ["line", "line"],
  ["lines", "line"],
  ["l.", "line"],
  ["ll.", "line"],
  ["note", "note"],
  ["notes", "note"],
  ["n.", "note"],
  ["nn.", "note"],
  ["page", "page"],
  ["pages", "page"],
  ["p.", "page"],
  ["pp.", "page"],
  ["paragraph", "paragraph"],
  ["paragraphs", "paragraph"],
  ["para.", "paragraph"],
  ["section", "section"],
  ["sections", "section"],
  ["sec.", "section"],
  ["secs.", "section"],
  ["table", "table"],
  ["tables", "table"],
  ["tbl.", "table"],
  ["volume", "volume"],
  ["volumes", "volume"],
  ["vol.", "volume"],
  ["vols.", "volume"],
]);

const SORTED_LOCATOR_LABELS = [...LOCATOR_LABELS.keys()]
  .sort((left, right) => right.length - left.length);
const LOCATOR_VALUE = /^(?:\d+[a-z]{0,2}|[ivxlcdm]+)(?:\s*[-–—:.]\s*(?:\d+[a-z]{0,2}|[ivxlcdm]+))*/i;

interface ParsedLocator {
  readonly label?: string;
  readonly locator?: string;
  readonly suffix?: string;
}

function parseLocator(raw: string | undefined): ParsedLocator {
  const text = raw?.trim().replace(/^,\s*/, "") ?? "";
  if (!text) return {};
  const lower = text.toLocaleLowerCase();
  for (const term of SORTED_LOCATOR_LABELS) {
    if (!lower.startsWith(term)) continue;
    const afterTerm = text[term.length];
    if (afterTerm && /[a-z]/i.test(afterTerm)) continue;
    const rest = text.slice(term.length).trimStart();
    const match = LOCATOR_VALUE.exec(rest);
    if (!match) return { suffix: `, ${text}` };
    const suffix = rest.slice(match[0].length);
    return {
      label: LOCATOR_LABELS.get(term),
      locator: match[0],
      ...(suffix.trim() ? { suffix } : {}),
    };
  }
  const match = LOCATOR_VALUE.exec(text);
  if (!match) return { suffix: `, ${text}` };
  const suffix = text.slice(match[0].length);
  return {
    locator: match[0],
    ...(suffix.trim() ? { suffix } : {}),
  };
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
