import {
  type EditorState,
  type Extension,
  Facet,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "pandocmd-cst";
import type { CslJsonItem } from "../../core/citations/csl-json";
import { CSS } from "../../core/constants/css-classes";
import { resolvePandocNode } from "../cst/cursor-context";
import { getDocumentPresentation } from "../cst/document-presentation";
import { getPandocTree } from "../cst/pandoc-cst-field";
import {
  getYamlCitationMetadata,
  type YamlCitationMetadata,
} from "../cst/yaml-metadata";
import { sanitizeCslHtml } from "../lib/sanitize-csl-html";
import { collectCitationClusters, updateCitationClusters } from "./citation-model";
import type {
  BibliographyEntryPresentation,
  BibliographyFailureKind,
  BibliographyStatus,
  CitationClusterPresentation,
  CitationFormatter,
  LoadedBibliography,
} from "./types";

export type { BibliographyStatus } from "./types";

export interface CitationResourceConfiguration {
  readonly onStatusChange?: (status: BibliographyStatus) => void;
  readonly readTextResource?: (path: string) => Promise<string>;
}

const EMPTY_RESOURCE_CONFIGURATION: CitationResourceConfiguration = Object.freeze({});

const citationResourceFacet = Facet.define<
  CitationResourceConfiguration,
  CitationResourceConfiguration
>({
  combine(values) {
    return values.at(-1) ?? EMPTY_RESOURCE_CONFIGURATION;
  },
});

export function citationResourceExtension(
  configuration: CitationResourceConfiguration,
): Extension {
  return citationResourceFacet.of(configuration);
}

interface CitationData {
  readonly formatter: CitationFormatter | null;
  readonly items: readonly CslJsonItem[];
  readonly requestKey: string;
  readonly status: BibliographyStatus;
}

interface CitationDataUpdate {
  readonly formatter?: CitationFormatter;
  readonly items?: readonly CslJsonItem[];
  readonly requestKey: string;
  readonly status: BibliographyStatus;
}

const citationDataEffect = StateEffect.define<CitationDataUpdate>();
const EMPTY_CITATION_ITEMS: readonly CslJsonItem[] = Object.freeze([]);

const citationDataField = StateField.define<CitationData>({
  create() {
    return { formatter: null, items: EMPTY_CITATION_ITEMS, requestKey: "", status: { state: "idle" } };
  },

  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(citationDataEffect)) continue;
      return {
        formatter: effect.value.formatter ?? null,
        items: effect.value.items ?? EMPTY_CITATION_ITEMS,
        requestKey: effect.value.requestKey,
        status: effect.value.status,
      };
    }
    return value;
  },
});

function resourceRequestKey(metadata: YamlCitationMetadata): string {
  return [
    ...metadata.bibliographyPaths,
    metadata.cslPath ?? "",
  ].join("\0");
}

/** All loaded entries, including keys that have not yet been cited. */
export function getCitationItems(state: EditorState): readonly CslJsonItem[] {
  const data = state.field(citationDataField, false);
  return data?.requestKey === resourceRequestKey(getYamlCitationMetadata(state))
    ? data.items
    : EMPTY_CITATION_ITEMS;
}

const IDLE_BIBLIOGRAPHY_STATUS: BibliographyStatus = Object.freeze({ state: "idle" });

/** Loading state for assistance waiting on the current document's resources. */
export function getBibliographyStatus(state: EditorState): BibliographyStatus {
  const data = state.field(citationDataField, false);
  return data?.requestKey === resourceRequestKey(getYamlCitationMetadata(state))
    ? data.status
    : IDLE_BIBLIOGRAPHY_STATUS;
}

function errorKind(error: unknown): BibliographyFailureKind {
  if (typeof error !== "object" || error === null || !("kind" in error)) {
    return "unexpected";
  }
  switch (error.kind) {
    case "read-bibliography":
    case "parse-bibliography":
    case "read-csl":
    case "style-csl":
      return error.kind;
    default:
      return "unexpected";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

class CitationResourceLoader {
  private destroyed = false;
  private reader: CitationResourceConfiguration["readTextResource"];
  private requestKey = "";
  private serial = 0;

  constructor(view: EditorView) {
    this.reader = undefined;
    this.schedule(view);
  }

  update(update: ViewUpdate): void {
    const reader = update.state.facet(citationResourceFacet).readTextResource;
    if (update.docChanged || reader !== this.reader) {
      this.schedule(update.view);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.serial += 1;
  }

  private publish(
    view: EditorView,
    requestKey: string,
    update: CitationDataUpdate,
  ): void {
    if (this.destroyed || requestKey !== this.requestKey) return;
    view.dispatch({ effects: citationDataEffect.of(update) });
    view.state.facet(citationResourceFacet).onStatusChange?.(update.status);
  }

  private schedule(view: EditorView): void {
    const metadata = getYamlCitationMetadata(view.state);
    const requestKey = resourceRequestKey(metadata);
    const reader = view.state.facet(citationResourceFacet).readTextResource;
    if (requestKey === this.requestKey && reader === this.reader) return;
    this.requestKey = requestKey;
    this.reader = reader;
    const serial = ++this.serial;
    void Promise.resolve().then(async () => {
      if (this.destroyed || serial !== this.serial) return;
      if (metadata.bibliographyPaths.length === 0) {
        this.publish(view, requestKey, {
          requestKey,
          status: { state: "idle" },
        });
        return;
      }
      const statusBase = {
        bibliographyPaths: metadata.bibliographyPaths,
        ...(metadata.cslPath ? { cslPath: metadata.cslPath } : {}),
      };
      if (!reader) {
        this.publish(view, requestKey, {
          requestKey,
          status: {
            ...statusBase,
            kind: "read-bibliography",
            message: "YAML declares a bibliography, but the host did not provide readTextResource",
            state: "error",
          },
        });
        return;
      }
      this.publish(view, requestKey, {
        requestKey,
        status: { ...statusBase, state: "loading" },
      });
      try {
        const { loadBibliography } = await import("./load-bibliography");
        const loaded: LoadedBibliography = await loadBibliography(metadata, reader);
        if (serial !== this.serial) return;
        this.publish(view, requestKey, {
          formatter: loaded.formatter,
          items: loaded.items,
          requestKey,
          status: loaded.status,
        });
      } catch (error: unknown) {
        if (serial !== this.serial) return;
        this.publish(view, requestKey, {
          requestKey,
          status: {
            ...statusBase,
            kind: errorKind(error),
            message: errorMessage(error),
            state: "error",
          },
        });
      }
    });
  }
}

const citationResourceLoader = ViewPlugin.fromClass(CitationResourceLoader);

function selectionTouches(
  state: EditorState,
  cluster: CitationClusterPresentation,
): boolean {
  const { from, to } = cluster.opener ?? cluster;
  return state.selection.ranges.some((range) => (
    range.empty
      ? cluster.opener
        ? from <= range.head && range.head <= to
        : from < range.head && range.head < to
      : range.from < to && from < range.to
  ));
}

function isRenderableCitation(
  cluster: CitationClusterPresentation,
  formatter: CitationFormatter,
  localTargets: ReadonlyMap<string, unknown>,
): boolean {
  return cluster.items.every((item) => (
    formatter.keys.has(item.id) && !localTargets.has(item.id)
  ));
}

function nociteIds(
  metadata: YamlCitationMetadata,
  formatter: CitationFormatter,
): string[] {
  if (metadata.nocite === "all") return [...formatter.keys];
  return metadata.nocite.filter((id) => formatter.keys.has(id));
}

function registrationClusters(
  state: EditorState,
  formatter: CitationFormatter,
  candidates: readonly CitationClusterPresentation[],
): CitationClusterPresentation[] {
  const localTargets = getDocumentPresentation(state).localTargets;
  const clusters = candidates
    .filter((cluster) => isRenderableCitation(cluster, formatter, localTargets));
  const cited = new Set(clusters.flatMap((cluster) => (
    cluster.items.map((item) => item.id)
  )));
  const uncited = nociteIds(getYamlCitationMetadata(state), formatter)
    .filter((id) => !cited.has(id));
  if (uncited.length > 0) {
    clusters.push({
      from: state.doc.length,
      items: uncited.map((id) => ({ id })),
      narrative: false,
      raw: "",
      to: state.doc.length,
    });
  }
  return clusters;
}

function bindSourceReveal(
  element: HTMLElement,
  view: EditorView,
): void {
  element.addEventListener("mousedown", (event) => {
    if (
      event.button !== 0
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
    ) return;
    event.preventDefault();
    event.stopPropagation();
    view.focus();
    view.dispatch({
      selection: { anchor: view.posAtDOM(element) + 1 },
      scrollIntoView: true,
      userEvent: "select.pointer",
    });
  });
}

class CitationWidget extends WidgetType {
  constructor(
    private readonly cluster: CitationClusterPresentation,
    private readonly html: string,
  ) {
    super();
  }

  eq(other: CitationWidget): boolean {
    return other.cluster.raw === this.cluster.raw
      && other.cluster.narrative === this.cluster.narrative
      && other.html === this.html;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement("span");
    element.className = [
      CSS.citation,
      ...(this.cluster.narrative ? [CSS.citationNarrative] : []),
    ].join(" ");
    element.dataset.citationKeys = this.cluster.items
      .map((item) => item.id)
      .join(";");
    element.innerHTML = this.html;
    element.setAttribute("aria-label", this.cluster.raw);
    element.title = "Edit citation";
    bindSourceReveal(element, view);
    return element;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class BibliographyWidget extends WidgetType {
  constructor(private readonly entries: readonly BibliographyEntryPresentation[]) {
    super();
  }

  eq(other: BibliographyWidget): boolean {
    return other.entries.length === this.entries.length
      && other.entries.every((entry, index) => (
        entry.id === this.entries[index]?.id
        && entry.html === this.entries[index]?.html
      ));
  }

  toDOM(view: EditorView): HTMLElement {
    const ownerDocument = view.dom.ownerDocument;
    const section = ownerDocument.createElement("section");
    section.className = CSS.bibliography;
    section.setAttribute("aria-label", "Bibliography");
    const heading = ownerDocument.createElement("h2");
    heading.className = CSS.bibliographyHeading;
    heading.textContent = "Bibliography";
    section.appendChild(heading);
    const list = ownerDocument.createElement("div");
    list.className = CSS.bibliographyList;
    for (const entry of this.entries) {
      const element = ownerDocument.createElement("div");
      element.className = CSS.bibliographyEntry;
      element.id = `bib-${encodeURIComponent(entry.id)}`;
      element.dataset.citationKey = entry.id;
      element.innerHTML = entry.html;
      list.appendChild(element);
    }
    section.appendChild(list);
    return section;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

interface CitationDecorationState {
  readonly clusters: readonly CitationClusterPresentation[];
  readonly contentKey: string;
  readonly citations: readonly {
    readonly cluster: CitationClusterPresentation;
    readonly html: string;
  }[];
  readonly data: CitationData;
  readonly decorations: DecorationSet;
  readonly entries: readonly BibliographyEntryPresentation[];
  readonly renderedFrom: ReadonlySet<number>;
  readonly selectionSignature: string;
}

function citationSelectionSignature(
  state: EditorState,
  citations: CitationDecorationState["citations"],
): string {
  let signature = "";
  for (const range of state.selection.ranges) {
    let from = 0;
    let to = citations.length;
    while (from < to) {
      const middle = (from + to) >>> 1;
      const cluster = citations[middle].cluster;
      if ((cluster.opener ? cluster.opener.to + 1 : cluster.to) <= range.from) from = middle + 1;
      else to = middle;
    }
    for (let index = from; index < citations.length; index += 1) {
      const cluster = citations[index].cluster;
      if ((cluster.opener ? cluster.opener.from - 1 : cluster.from) >= range.to) break;
      if (selectionTouches(state, cluster)) signature += `${index},`;
    }
    signature += ";";
  }
  return signature;
}

function citationDecorationSet(
  state: EditorState,
  citations: CitationDecorationState["citations"],
  entries: readonly BibliographyEntryPresentation[],
): DecorationSet {
  const ranges: Array<ReturnType<Decoration["range"]>> = [];
  for (const citation of citations) {
    if (selectionTouches(state, citation.cluster)) continue;
    ranges.push(Decoration.replace({
      widget: new CitationWidget(citation.cluster, citation.html),
    }).range(citation.cluster.from, citation.cluster.to));
  }
  if (entries.length > 0) {
    ranges.push(Decoration.widget({
      block: true,
      side: 1,
      widget: new BibliographyWidget(entries),
    }).range(state.doc.length));
  }
  return Decoration.set(ranges, true);
}

function buildCitationDecorations(
  state: EditorState,
  previous?: CitationDecorationState,
  transaction?: Transaction,
): CitationDecorationState {
  const data = state.field(citationDataField);
  const formatter = data.formatter;
  if (!formatter) {
    if (previous?.data === data) return previous;
    return {
      clusters: [],
      contentKey: "",
      citations: [],
      data,
      decorations: Decoration.none,
      entries: [],
      renderedFrom: new Set(),
      selectionSignature: "",
    };
  }
  const tree = getPandocTree(state);
  const changes = transaction?.changes;
  const candidates = previous?.data.formatter
    ? transaction?.docChanged
      ? updateCitationClusters(transaction, previous.clusters)
      : previous.clusters
    : collectCitationClusters(tree);
  const clusters = registrationClusters(state, formatter, candidates);
  // Positions are intentionally excluded: prose edits can move citations
  // without changing CSL context, nocite entries, or local-target resolution.
  const contentKey = JSON.stringify(clusters.map(({ items, narrative, raw }) => (
    { items, narrative, raw }
  )));
  if (previous?.data === data && previous.contentKey === contentKey) {
    const citations = previous.citations.map((citation, index) => ({
      cluster: clusters[index],
      html: citation.html,
    }));
    const selectionSignature = citationSelectionSignature(state, citations);
    const canMap = changes
      && selectionSignature === previous.selectionSignature
      && !previous.citations.some(({ cluster }) => (
        changes.touchesRange(cluster.from, cluster.to)
      ));
    return {
      ...previous,
      clusters: candidates,
      citations,
      decorations: canMap
        ? previous.decorations.map(changes)
        : citationDecorationSet(state, citations, previous.entries),
      renderedFrom: new Set(citations.map(({ cluster }) => cluster.from)),
      selectionSignature,
    };
  }
  formatter.registerCitations(clusters);
  const citations = clusters
    .filter((cluster) => cluster.raw !== "")
    .map((cluster) => ({
      cluster,
      html: sanitizeCslHtml(formatter.cite(cluster)),
    }));
  const renderedFrom = new Set(citations.map(({ cluster }) => cluster.from));
  const entries = formatter.bibliographyEntries().map((entry) => ({
    ...entry,
    html: sanitizeCslHtml(entry.html),
  }));
  return {
    clusters: candidates,
    contentKey,
    citations,
    data,
    decorations: citationDecorationSet(state, citations, entries),
    entries,
    renderedFrom,
    selectionSignature: citationSelectionSignature(state, citations),
  };
}

const citationDecorationField = StateField.define<CitationDecorationState>({
  create(state) {
    return buildCitationDecorations(state);
  },

  update(value, transaction) {
    const data = transaction.state.field(citationDataField);
    if (
      transaction.docChanged
      || data !== value.data
    ) return buildCitationDecorations(transaction.state, value, transaction);
    if (transaction.selection && value.citations.length > 0) {
      const selectionSignature = citationSelectionSignature(
        transaction.state,
        value.citations,
      );
      if (selectionSignature === value.selectionSignature) return value;
      return {
        ...value,
        selectionSignature,
        decorations: citationDecorationSet(
          transaction.state,
          value.citations,
          value.entries,
        ),
      };
    }
    return value;
  },

  provide(field) {
    return EditorView.decorations.from(field, (value) => value.decorations);
  },
});

function containingCitation(node: SyntaxNode | null): SyntaxNode | null {
  let current = node;
  while (current) {
    if (current.kind === "Citation" || current.kind === "ExampleReference") {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function enterRenderedCitation(
  view: EditorView,
  direction: "left" | "right",
): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const citation = containingCitation(
    resolvePandocNode(getPandocTree(view.state), selection.head, direction),
  );
  if (!citation) return false;
  if (direction === "right" && citation.from !== selection.head) return false;
  if (direction === "left" && citation.to !== selection.head) return false;
  if (!view.state.field(citationDecorationField).renderedFrom.has(citation.from)) {
    return false;
  }
  const key = [...citation.children()].find((child) => (
    child.kind === "CitationKey" || child.kind === "CitationItem"
  ));
  const keyNode = key?.kind === "CitationItem"
    ? [...key.children()].find((child) => child.kind === "CitationKey")
    : key;
  if (!keyNode) return false;
  view.dispatch({
    selection: {
      anchor: direction === "right" ? keyNode.from : keyNode.to,
    },
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

const citationKeyboardNavigation = keymap.of([
  {
    key: "ArrowRight",
    run: (view) => enterRenderedCitation(view, "right"),
  },
  {
    key: "ArrowLeft",
    run: (view) => enterRenderedCitation(view, "left"),
  },
]);

const citationTheme = EditorView.theme({
  [`.${CSS.citation}`]: {
    cursor: "pointer",
    fontKerning: "none",
  },
  [`.${CSS.bibliography}`]: {
    fontFamily: "var(--cf-content-font)",
    fontSize: "0.85em",
    lineHeight: "1.4",
    marginTop: "2em",
    width: "100%",
  },
  [`.${CSS.bibliographyHeading}`]: {
    color: "var(--cf-fg)",
    fontFamily: "var(--cf-content-font)",
    fontSize: "var(--cf-h2-size)",
    fontWeight: "var(--cf-h2-weight)",
    margin: "0 0 0.5em",
  },
  [`.${CSS.bibliographyEntry} + .${CSS.bibliographyEntry}`]: {
    marginTop: "0.15em",
  },
  [`.${CSS.bibliographyEntry} > .csl-entry`]: {
    margin: "0",
  },
  [`.${CSS.bibliographyEntry} > .csl-entry:has(> .csl-left-margin):has(> .csl-right-inline)`]: {
    alignItems: "start",
    columnGap: "0.5em",
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
  },
  [`.${CSS.bibliographyEntry} .csl-left-margin`]: {
    whiteSpace: "nowrap",
  },
  [`.${CSS.bibliographyEntry} .csl-right-inline`]: {
    minWidth: "0",
    overflowWrap: "anywhere",
  },
});

export const cstCitationSurface: Extension = [
  citationDataField,
  citationDecorationField,
  citationResourceLoader,
  citationKeyboardNavigation,
  citationTheme,
];
