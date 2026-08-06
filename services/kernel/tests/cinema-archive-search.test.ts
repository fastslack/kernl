/**
 * Searching archive.org without building an index first.
 *
 * The catalogue page presented 74,773 pending embeddings as if nothing worked
 * until they were generated. Two things were already true: the local FTS mode
 * needs no embeddings, and archive.org runs a Solr index over its entire
 * corpus that answers for free. This covers the second one.
 *
 * The network call is not exercised here — these are the parts that decide
 * whether a query is well-formed or a 400, and whether a Solr doc survives the
 * trip into the row the catalogue renders.
 */

import { describe, it, expect, mock, afterEach } from "bun:test";
import { searchArchive } from "../assets/extensions/leisure/cinema/_module/archive-search.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Capture the URL the module builds, and reply with a canned Solr response. */
function stubFetch(docs: Array<Record<string, unknown>>, numFound = docs.length) {
  const seen: string[] = [];
  globalThis.fetch = mock(async (input: any) => {
    seen.push(String(input));
    return {
      ok: true,
      status: 200,
      json: async () => ({ response: { numFound, docs } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return seen;
}

/** URLSearchParams encodes spaces as `+`, which decodeURIComponent leaves
 *  alone — so decode the plus first or every phrase assertion misses. */
function urlText(u: string): string {
  return decodeURIComponent(u.replace(/\+/g, " "));
}

const DOC = {
  identifier: "les_vampires_1915",
  title: "Les Vampires",
  year: "1915",
  date: "1915-11-13",
  creator: "Louis Feuillade",
  description: "A serial about a criminal gang.",
  subject: ["silent", "crime"],
  collection: ["feature_films"],
  downloads: "48213",
};

describe("searchArchive — query building", () => {
  it("always restricts to films", async () => {
    const seen = stubFetch([DOC]);
    await searchArchive({ q: "vampires" });
    expect(urlText(seen[0])).toContain("mediatype:(movies)");
  });

  it("searches fields, ANDed, rather than an unfielded catch-all", async () => {
    // Measured against the live index: an unfielded `dracula` returns 2,961
    // items topped by PSICOMAGIA; `title:(dracula)` returns films. And
    // `title:(silent vampires)` ORs inside the field, matching everything
    // with "vampires" — the AND is what makes the query mean what it says.
    const seen = stubFetch([DOC]);
    await searchArchive({ q: "silent films with vampires" });
    const q = urlText(seen[0]);
    expect(q).toContain("title:(silent AND vampires)");
    expect(q).toContain("subject:(silent AND vampires)");
    // Stopwords carry no signal and only widen the match.
    expect(q).not.toContain("with AND");
    expect(q).not.toContain("films AND");
  });

  it("restricts to the curated collections by default", async () => {
    // The lever that turns 1,309 results of amateur uploads into 107 films.
    const seen = stubFetch([DOC]);
    await searchArchive({ q: "vampires" });
    const q = urlText(seen[0]);
    expect(q).toContain("collection:(");
    expect(q).toContain("feature_films");
    expect(q).toContain("silent_films");
  });

  it("can be asked for the whole archive instead", async () => {
    const seen = stubFetch([DOC]);
    await searchArchive({ q: "vampires", everywhere: true });
    expect(urlText(seen[0])).not.toContain("collection:(");
  });

  it("escapes Solr syntax instead of sending a 400", async () => {
    const seen = stubFetch([]);
    await searchArchive({ q: 'Dr. Mabuse: der Spieler [1922]' });
    const q = urlText(seen[0]);
    expect(q).toContain("\\:");
    expect(q).toContain("\\[");
  });

  it("turns a year range into a range filter", async () => {
    const seen = stubFetch([DOC]);
    await searchArchive({ q: "noir", yearFrom: 1940, yearTo: 1959 });
    expect(urlText(seen[0])).toContain("year:[1940 TO 1959]");
  });

  it("ranks by relevance unless popularity is asked for", async () => {
    // Forcing downloads desc discards Solr's score: the most-downloaded item
    // matching any single term wins, which is how About Bananas outranked Les
    // Vampires for "silent films with vampires".
    const seen = stubFetch([DOC]);
    await searchArchive({ q: "silent vampires" });
    expect(seen[0]).not.toContain("sort");

    const seen2 = stubFetch([DOC]);
    await searchArchive({ q: "silent vampires", sort: "downloads" });
    expect(urlText(seen2[0])).toContain("sort[]=downloads desc");
  });

  it("caps rows so one query cannot pull the archive", async () => {
    const seen = stubFetch([DOC]);
    await searchArchive({ q: "noir", rows: 5000 });
    expect(seen[0]).toContain("rows=100");
  });
});

describe("searchArchive — result mapping", () => {
  it("maps a Solr doc onto the catalogue row", async () => {
    stubFetch([DOC]);
    const { items } = await searchArchive({ q: "vampires" });
    expect(items).toHaveLength(1);
    const t = items[0];
    expect(t.identifier).toBe("les_vampires_1915");
    expect(t.title).toBe("Les Vampires");
    expect(t.year).toBe(1915);
    expect(t.downloads).toBe(48213);
    expect(t.subject).toEqual(["silent", "crime"]);
    expect(t.poster_url).toContain("services/img/les_vampires_1915");
    // Marked as not-yet-local so the UI can offer to add it.
    expect(t._remote).toBe(true);
  });

  it("leaves fields the index does not carry empty rather than inventing them", async () => {
    stubFetch([DOC]);
    const { items } = await searchArchive({ q: "vampires" });
    expect(items[0].runtime_sec).toBe(0);
    expect(items[0].description_es).toBe("");
  });

  it("derives the year from the date when the index omits it", async () => {
    stubFetch([{ identifier: "x", title: "X", date: "1948-02-01" }]);
    const { items } = await searchArchive({ q: "x" });
    expect(items[0].year).toBe(1948);
  });

  it("reports the archive's total, not the page size", async () => {
    stubFetch([DOC], 4213);
    const { items, total } = await searchArchive({ q: "vampires" });
    expect(items).toHaveLength(1);
    expect(total).toBe(4213);
  });

  it("drops docs with no identifier — they cannot be opened or added", async () => {
    stubFetch([{ title: "orphan" }, DOC]);
    const { items } = await searchArchive({ q: "vampires" });
    expect(items).toHaveLength(1);
  });

  it("surfaces an upstream failure instead of returning nothing quietly", async () => {
    globalThis.fetch = mock(async () => ({ ok: false, status: 503 } as unknown as Response)) as unknown as typeof fetch;
    await expect(searchArchive({ q: "vampires" })).rejects.toThrow("503");
  });
});
