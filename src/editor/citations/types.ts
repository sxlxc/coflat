import type { CslJsonItem } from "../../core/citations/csl-json";

export interface CitationItemPresentation {
  readonly id: string;
  readonly locator?: string;
  readonly prefix?: string;
  readonly suppressAuthor?: boolean;
}

export interface CitationClusterPresentation {
  readonly from: number;
  readonly items: readonly CitationItemPresentation[];
  readonly narrative: boolean;
  readonly raw: string;
  readonly to: number;
}

export interface BibliographyEntryPresentation {
  readonly html: string;
  readonly id: string;
}

export interface CitationFormatter {
  readonly keys: ReadonlySet<string>;
  bibliographyEntries(): readonly BibliographyEntryPresentation[];
  cite(cluster: CitationClusterPresentation): string;
  registerCitations(clusters: readonly CitationClusterPresentation[]): void;
}

export type BibliographyFailureKind =
  | "read-bibliography"
  | "parse-bibliography"
  | "read-csl"
  | "style-csl"
  | "unexpected";

export type BibliographyStatus =
  | { readonly state: "idle" }
  | {
    readonly bibliographyPaths: readonly string[];
    readonly cslPath?: string;
    readonly state: "loading";
  }
  | {
    readonly bibliographyPaths: readonly string[];
    readonly cslPath?: string;
    readonly entryCount: number;
    readonly state: "ok";
  }
  | {
    readonly bibliographyPaths: readonly string[];
    readonly cslPath?: string;
    readonly entryCount: number;
    readonly kind: BibliographyFailureKind;
    readonly message: string;
    readonly state: "warning";
  }
  | {
    readonly bibliographyPaths: readonly string[];
    readonly cslPath?: string;
    readonly kind: BibliographyFailureKind;
    readonly message: string;
    readonly state: "error";
  };

export interface LoadedBibliography {
  readonly formatter: CitationFormatter;
  readonly items: readonly CslJsonItem[];
  readonly status: BibliographyStatus;
}
