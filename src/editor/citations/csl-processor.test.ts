import { plugins } from "@citation-js/core";
import "@citation-js/plugin-csl";
import { describe, expect, it, vi } from "vitest";
import type { CslJsonItem } from "../../core/citations/csl-json";
import { CslProcessor, parseLocator } from "./csl-processor";
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

// Every case below was cross-checked against Pandoc 3.11 with this
// repository's IEEE style, which is the publication authority for citation
// rendering (Text.Pandoc.Citeproc.Locator).
describe("citation locator parsing (pandoc parity)", () => {
  const cases: ReadonlyArray<readonly [string, ReturnType<typeof parseLocator>]> = [
    // Prose suffixes stay suffixes; bare roman numerals are not locators.
    ["Lemma 1", { suffix: ", Lemma 1" }],
    ["Lemma 2.3", { suffix: ", Lemma 2.3" }],
    ["Theorem 1", { suffix: ", Theorem 1" }],
    ["Corollary 3", { suffix: ", Corollary 3" }],
    ["Definition 4", { suffix: ", Definition 4" }],
    ["cf. Lemma 1", { suffix: ", cf. Lemma 1" }],
    ["iv", { suffix: ", iv" }],
    ["XI", { suffix: ", XI" }],
    ["p", { suffix: ", p" }],
    ["p.", { suffix: ", p." }],
    ["opera", { suffix: ", opera" }],
    ["sub verbo foo", { suffix: ", sub verbo foo" }],
    ["v. Lemma 2", { suffix: ", v. Lemma 2" }],
    ["p. Lemma", { suffix: ", p. Lemma" }],
    // Label spellings without a period are not locale terms.
    ["chap 3", { suffix: ", chap 3" }],
    ["ch 2", { suffix: ", ch 2" }],
    ["vols 2", { suffix: ", vols 2" }],
    ["number 3", { suffix: ", number 3" }],
    ["eq. 5", { suffix: ", eq. 5" }],
    ["table 2", { suffix: ", table 2" }],
    ["{unbalanced", { suffix: ", {unbalanced" }],
    // Bare digit-bearing words get the implicit page label.
    ["33", { label: "page", locator: "33" }],
    ["2.3", { label: "page", locator: "2.3" }],
    ["1.2.3", { label: "page", locator: "1.2.3" }],
    ["12-15", { label: "page", locator: "12-15" }],
    ["1:3", { label: "page", locator: "1:3" }],
    ["page5", { label: "page", locator: "page5" }],
    ["34(1)", { label: "page", locator: "34(1)" }],
    ["34 (1)", { label: "page", locator: "34 (1)" }],
    ["(1)(a)", { label: "page", locator: "(1)(a)" }],
    ["591 [84]", { label: "page", locator: "591 [84]" }],
    ["5 6", { label: "page", locator: "5 6" }],
    ["22, 33", { label: "page", locator: "22, 33" }],
    // Explicit labels, including case folding, plural, and symbol forms.
    ["p. 5", { label: "page", locator: "5" }],
    ["P. 5", { label: "page", locator: "5" }],
    ["p.5", { label: "page", locator: "5" }],
    ["p.  5", { label: "page", locator: "5" }],
    ["p. iv", { label: "page", locator: "iv" }],
    ["pp. 1-3", { label: "page", locator: "1-3" }],
    ["pages 2-3", { label: "page", locator: "2-3" }],
    ["l. xii", { label: "line", locator: "xii" }],
    ["l. L", { label: "line", locator: "L" }],
    ["l. civil", { label: "line", locator: "civil" }],
    ["l. xii-xiii", { label: "line", locator: "xii-xiii" }],
    ["l. iv, vi", { label: "line", locator: "iv, vi" }],
    ["§ 3", { label: "section", locator: "3" }],
    ["§§ 5-6", { label: "section", locator: "5-6" }],
    ["¶ 4", { label: "paragraph", locator: "4" }],
    ["sec. 3.2", { label: "section", locator: "3.2" }],
    ["Secs. 2-3", { label: "section", locator: "2-3" }],
    ["chap. 2", { label: "chapter", locator: "2" }],
    ["Ch. 2", { label: "chapter", locator: "2" }],
    ["chaps. 2", { label: "chapter", locator: "2" }],
    ["chapters 2", { label: "chapter", locator: "2" }],
    ["c. 3", { label: "chapter", locator: "3" }],
    ["cc. 3", { label: "chapter", locator: "3" }],
    ["fig. 3", { label: "figure", locator: "3" }],
    ["figs. 3", { label: "figure", locator: "3" }],
    ["n. 3", { label: "note", locator: "3" }],
    ["nn. 2", { label: "note", locator: "2" }],
    ["no. 3", { label: "issue", locator: "3" }],
    ["issues 3", { label: "issue", locator: "3" }],
    ["vol. 2", { label: "volume", locator: "2" }],
    ["bk. 1", { label: "book", locator: "1" }],
    ["books 2", { label: "book", locator: "2" }],
    ["col. 2", { label: "column", locator: "2" }],
    ["fol. 7", { label: "folio", locator: "7" }],
    ["op. 17", { label: "opus", locator: "17" }],
    ["opera 4", { label: "opus", locator: "4" }],
    ["pt. 2", { label: "part", locator: "2" }],
    ["para. 4", { label: "paragraph", locator: "4" }],
    ["verses 3", { label: "verse", locator: "3" }],
    ["s.v. 3", { label: "sub-verbo", locator: "3" }],
    ["sub verbis 3", { label: "sub-verbo", locator: "3" }],
    // Leftover text after a locator stays in the suffix.
    ["p. 5 and following", { label: "page", locator: "5", suffix: " and following" }],
    ["p. 5, cf. 6", { label: "page", locator: "5", suffix: ", cf. 6" }],
    ["p. 1.2. a", { label: "page", locator: "1.2", suffix: ". a" }],
    ["p. 3.", { label: "page", locator: "3", suffix: "." }],
    ["1., 2", { label: "page", locator: "1", suffix: "., 2" }],
    // Brace-delimited locators.
    ["{p. 5}", { label: "page", locator: "5" }],
    ["{5}", { label: "page", locator: "5" }],
    ["{iv}", { suffix: " iv" }],
    ["{}", {}],
    ["{p. 5} extra", { label: "page", locator: "5", suffix: " extra" }],
    ["{iv} extra", { suffix: " iv extra" }],
    [", Lemma 1", { suffix: ", Lemma 1" }],
  ];

  it.each(cases)("parses %j like pandoc", (input, expected) => {
    expect(parseLocator(input)).toEqual(expected);
  });

  it("renders prose suffixes and locators like pandoc", async () => {
    const processor = await CslProcessor.create(entries);
    const lemma: CitationClusterPresentation = {
      from: 0,
      to: 10,
      items: [{ id: "smith", locator: "Lemma 1" }],
      narrative: false,
      raw: "[@smith, Lemma 1]",
    };
    const theorem: CitationClusterPresentation = {
      from: 20,
      to: 30,
      items: [{ id: "smith", locator: "Theorem 1" }],
      narrative: false,
      raw: "[@smith, Theorem 1]",
    };
    const pages: CitationClusterPresentation = {
      from: 40,
      to: 50,
      items: [{ id: "smith", locator: "p. 42" }],
      narrative: false,
      raw: "[@smith, p. 42]",
    };
    processor.registerCitations([lemma, theorem, pages]);
    expect(text(processor.cite(lemma))).toBe("[1, Lemma 1]");
    expect(text(processor.cite(theorem))).toBe("[1, Theorem 1]");
    expect(text(processor.cite(pages))).toBe("[1, p. 42]");
  });
});
