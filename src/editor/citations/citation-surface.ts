import {
  type ChangeDesc,
  type EditorState,
  type Extension,
  Facet,
  StateEffect,
  StateField,
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
import { CSS } from "../../core/constants/css-classes";
import { getDocumentPresentation } from "../cst/document-presentation";
import { getPandocTree } from "../cst/pandoc-cst-field";
import {
  getYamlCitationMetadata,
  type YamlCitationMetadata,
} from "../cst/yaml-metadata";
import { sanitizeCslHtml } from "../lib/sanitize-csl-html";
import { collectCitationClusters } from "./citation-model";
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
  readonly requestKey: string;
  readonly status: BibliographyStatus;
}

interface CitationDataUpdate {
  readonly formatter?: CitationFormatter;
  readonly requestKey: string;
  readonly status: BibliographyStatus;
}

const citationDataEffect = StateEffect.define<CitationDataUpdate>();

const citationDataField = StateField.define<CitationData>({
  create() {
    return { formatter: null, requestKey: "", status: { state: "idle" } };
  },

  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(citationDataEffect)) continue;
      return {
        formatter: effect.value.formatter ?? null,
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
  return state.selection.ranges.some((range) => (
    range.empty
      ? cluster.from < range.head && range.head < cluster.to
      : range.from < cluster.to && cluster.from < range.to
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
): CitationClusterPresentation[] {
  const localTargets = getDocumentPresentation(state).localTargets;
  const clusters = collectCitationClusters(getPandocTree(state))
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
  readonly contentKey: string;
  readonly citations: readonly {
    readonly cluster: CitationClusterPresentation;
    readonly html: string;
  }[];
  readonly data: CitationData;
  readonly decorations: DecorationSet;
  readonly entries: readonly BibliographyEntryPresentation[];
  readonly renderedFrom: ReadonlySet<number>;
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
  changes?: ChangeDesc,
): CitationDecorationState {
  const data = state.field(citationDataField);
  const formatter = data.formatter;
  if (!formatter) {
    return {
      contentKey: "",
      citations: [],
      data,
      decorations: Decoration.none,
      entries: [],
      renderedFrom: new Set(),
    };
  }
  const clusters = registrationClusters(state, formatter);
  // Positions are intentionally excluded: prose edits can move citations
  // without changing CSL context, nocite entries, or local-target resolution.
  const contentKey = JSON.stringify(clusters.map(({ items, narrative, raw }) => (
    { items, narrative, raw }
  )));
  if (previous?.data === data && previous.contentKey === contentKey) {
    const citations = previous.citations.map((citation, index) => {
      const cluster = clusters[index];
      const from = changes?.mapPos(citation.cluster.from, 1) ?? cluster.from;
      const to = changes?.mapPos(citation.cluster.to, -1) ?? cluster.to;
      return {
        ...citation,
        // A replacement may recreate an identical citation inside the changed
        // range. In that case the current CST supplies its exact coordinates.
        cluster: from === cluster.from && to === cluster.to
          ? { ...citation.cluster, from, to }
          : cluster,
      };
    });
    return {
      ...previous,
      citations,
      decorations: citationDecorationSet(state, citations, previous.entries),
      renderedFrom: new Set(citations.map(({ cluster }) => cluster.from)),
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
    contentKey,
    citations,
    data,
    decorations: citationDecorationSet(state, citations, entries),
    entries,
    renderedFrom,
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
    ) return buildCitationDecorations(transaction.state, value, transaction.changes);
    if (transaction.selection) {
      return {
        ...value,
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
    getPandocTree(view.state).resolve(selection.head, direction),
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
