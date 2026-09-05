import type { CslJsonItem } from "../../core/citations/csl-json";
import type { YamlCitationMetadata } from "../cst/yaml-metadata";
import { parseBibliography } from "./bibliography-parser";
import { CslProcessor } from "./csl-processor";
import type {
  BibliographyFailureKind,
  LoadedBibliography,
} from "./types";

export type ReadTextResource = (path: string) => Promise<string>;

export class BibliographyLoadError extends Error {
  constructor(
    readonly kind: BibliographyFailureKind,
    message: string,
  ) {
    super(message);
  }
}

async function readResource(
  readTextResource: ReadTextResource,
  path: string,
  kind: BibliographyFailureKind,
): Promise<string> {
  try {
    return await readTextResource(path);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BibliographyLoadError(kind, `Could not read ${path}: ${detail}`);
  }
}

export async function loadBibliography(
  metadata: YamlCitationMetadata,
  readTextResource: ReadTextResource,
): Promise<LoadedBibliography> {
  const itemsById = new Map<string, CslJsonItem>();
  let skippedEntries = 0;

  for (const path of metadata.bibliographyPaths) {
    const source = await readResource(
      readTextResource,
      path,
      "read-bibliography",
    );
    const parsed = parseBibliography(source, { path });
    if (parsed.error) {
      throw new BibliographyLoadError(
        "parse-bibliography",
        `${path}: ${parsed.error}`,
      );
    }
    skippedEntries += parsed.skippedEntries;
    for (const item of parsed.items) {
      if (!itemsById.has(item.id)) itemsById.set(item.id, item);
    }
  }

  const styleXml = metadata.cslPath
    ? await readResource(readTextResource, metadata.cslPath, "read-csl")
    : undefined;
  let formatter: CslProcessor;
  try {
    formatter = await CslProcessor.create([...itemsById.values()], styleXml);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BibliographyLoadError("style-csl", detail);
  }

  const baseStatus = {
    bibliographyPaths: metadata.bibliographyPaths,
    ...(metadata.cslPath ? { cslPath: metadata.cslPath } : {}),
    entryCount: itemsById.size,
  };
  return {
    formatter,
    items: [...itemsById.values()],
    status: skippedEntries > 0
      ? {
        ...baseStatus,
        kind: "parse-bibliography",
        message: `${skippedEntries} invalid bibliography ${skippedEntries === 1 ? "entry was" : "entries were"} skipped`,
        state: "warning",
      }
      : { ...baseStatus, state: "ok" },
  };
}
