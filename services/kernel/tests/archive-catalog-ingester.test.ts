import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { ArchiveCatalog } from "../assets/extensions/leisure/_lib/archive-catalog/service.js";
import { archiveCatalogMigrations } from "../assets/extensions/leisure/_lib/archive-catalog/migrations.js";
import { ingestNextChunk } from "../assets/extensions/leisure/_lib/archive-catalog/ingester.js";

// archive.org's scrape API sometimes hands back a `cursor` that does not move:
// asked for the page after X, it answers with the same page and X again
// (reproduced live on audio_music at identifierSorter "66-wmvrn7"). The
// ingester trusted it, so the run never finished: one archive.org request a
// minute re-fetching the same 200 rows, and no other collection ever got its
// turn again.

const realFetch = globalThis.fetch;

type Page = { ids: string[]; next: string | null };

/** Stands in for the scrape API: the page to serve for each cursor sent. */
function fakeScrape(pages: Record<string, Page>): { fetch: typeof fetch; cursorsSent: string[] } {
  const cursorsSent: string[] = [];
  const stub = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const cursor = url.searchParams.get("cursor") ?? "";
    cursorsSent.push(cursor);
    const page = pages[cursor];
    if (!page) return new Response("unexpected cursor", { status: 500 });
    return Response.json({
      items: page.ids.map((identifier) => ({ identifier, title: identifier })),
      cursor: page.next,
    });
  }) as typeof fetch;
  return { fetch: stub, cursorsSent };
}

describe("archive catalog ingester", () => {
  let db: InstanceType<typeof Database>;
  let catalog: ArchiveCatalog;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "music_catalog", archiveCatalogMigrations("music"));
    catalog = new ArchiveCatalog({ db, prefix: "music" });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    db.close();
  });

  it("closes the run when archive.org returns the cursor it was sent", async () => {
    const archive = fakeScrape({
      "": { ids: ["a1", "a2"], next: "C1" },
      C1: { ids: ["a1", "a2"], next: "C1" },
    });
    globalThis.fetch = archive.fetch;

    await ingestNextChunk(catalog, ["audio_music"], { mediatype: "audio", maxPages: 5, pageDelayMs: 0 }, "test");

    expect(archive.cursorsSent).toEqual(["", "C1"]);
    const run = catalog.latestRun("audio_music");
    expect(run?.status).toBe("done");
    expect(run?.error).toContain("cursor");
    expect(catalog.countAll()).toBe(2);
  });

  it("still walks every page of a collection whose cursor advances", async () => {
    const archive = fakeScrape({
      "": { ids: ["a1", "a2"], next: "C1" },
      C1: { ids: ["b1", "b2"], next: "C2" },
      C2: { ids: ["c1", "c2"], next: null },
    });
    globalThis.fetch = archive.fetch;

    await ingestNextChunk(catalog, ["audio_music"], { mediatype: "audio", maxPages: 5, pageDelayMs: 0 }, "test");

    expect(archive.cursorsSent).toEqual(["", "C1", "C2"]);
    const run = catalog.latestRun("audio_music");
    expect(run?.status).toBe("done");
    expect(run?.error ?? "").toBe("");
    expect(catalog.countAll()).toBe(6);
  });
});
