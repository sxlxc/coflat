import { plugins } from "@citation-js/core";
import "@citation-js/plugin-csl";
import { describe, expect, it, vi } from "vitest";
import type { CslJsonItem } from "../../core/citations/csl-json";
import { CslProcessor } from "./csl-processor";
import type { CitationClusterPresentation } from "./types";

const entries: CslJsonItem[] = [{
  id: "smith",
  type: "book",
  title: "First book",
  author: [{ family: "Smith", given: "Alice" }],
  issued: { "date-parts": [[2024]] },
}];

function cluster(from: number, id = "smith", narrative = false): CitationClusterPresentation {
  return { from, to: from + id.length + 3, items: [{ id }], narrative, raw: `[@${id}]` };
}

const positionStyle = `<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text">
  <info><title>Position regression</title><id>https://example.com/position</id></info>
  <citation><layout><choose><if position="first"><text value="FIRST"/></if><else><text value="LATER"/></else></choose></layout></citation>
  <bibliography><layout><text variable="title"/></layout></bibliography>
</style>`;

function text(html: string): string {
  const element = document.createElement("span");
  element.innerHTML = html;
  return element.textContent ?? "";
}

describe("CSL processor", () => {
  it("uses the bundled IEEE author macro for narrative citations", async () => {
    const processor = await CslProcessor.create(entries);
    const citation = cluster(0, "smith", true);
    processor.registerCitations([citation]);
    expect(text(processor.cite(citation))).toBe("A. Smith [1]");
    expect(processor.cite({ ...citation, raw: "(@smith)" })).toBe("(A. Smith [1])");
  });

  it("retains contextual output and resets it after citation removal", async () => {
    const processor = await CslProcessor.create(entries, positionStyle);
    const first = cluster(0);
    const later = cluster(20);
    processor.registerCitations([first, later]);
    expect(processor.cite(first)).toBe("FIRST");
    expect(processor.cite(later)).toBe("LATER");
    processor.registerCitations([later]);
    expect(processor.cite(later)).toBe("FIRST");
    processor.registerCitations([]);
    expect(processor.bibliographyEntries()).toEqual([]);
  });

  it("lets APA format narrative et-al, conjunctions, and disambiguation", async () => {
    const apa = plugins.config.get("@csl").templates.get("apa");
    const processor = await CslProcessor.create([
      { ...entries[0], author: [{ family: "Smith" }, { family: "Jones" }, { family: "Brown" }] },
      { ...entries[0], id: "pair", author: [{ family: "Jones" }, { family: "Brown" }] },
      { ...entries[0], id: "other", title: "Second book", author: [{ family: "Smith" }, { family: "Jones" }, { family: "Brown" }] },
    ], apa);
    const first = cluster(0, "smith", true);
    const pair = cluster(20, "pair", true);
    const other = cluster(40, "other", true);
    processor.registerCitations([first, pair, other]);
    expect(text(processor.cite(first))).toBe("Smith et al. (2024a)");
    expect(text(processor.cite(pair))).toBe("Jones & Brown (2024)");
    expect(text(processor.cite(other))).toBe("Smith et al. (2024b)");
  });

  it("does not register styles or acquire globally cached engines on repeated loads", async () => {
    const config = plugins.config.get("@csl");
    const add = vi.spyOn(config.templates, "add");
    const engine = vi.spyOn(config, "engine");
    try {
      const first = await CslProcessor.create(entries);
      first.registerCitations([cluster(0)]);
      for (let index = 0; index < 10; index += 1) {
        const processor = await CslProcessor.create([{ ...entries[0], title: `Book ${index}` }]);
        processor.registerCitations([cluster(0)]);
        expect(processor.bibliographyEntries()[0].html).toContain(`Book ${index}`);
      }
      expect(first.bibliographyEntries()[0].html).toContain("First book");
      expect(add).not.toHaveBeenCalled();
      expect(engine).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
      engine.mockRestore();
    }
  });
});
