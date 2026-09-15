import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { ingestNextChunk } from "../assets/extensions/leisure/cinema/_module/ingester.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

// Cinema keeps its own copy of the archive.org ingester, with the same trust
// in the scrape API's cursor. archive.org sometimes answers "the page after X"
// with the same page and X again (reproduced live on artsandmusicvideos and
// audio_music), and following that cursor re-fetches one page forever.

const realFetch = globalThis.fetch;

type Page = { ids: string[]; next: string | null };

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

describe("cinema ingester", () => {
  let db: SqliteDb;
  let svc: CinemaService;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as SqliteDb;
    runMigrations(db, "cinema", cinemaMigrations);
    svc = new CinemaService(db);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("closes the run when archive.org returns the cursor it was sent", async () => {
    const archive = fakeScrape({
      "": { ids: ["a1", "a2"], next: "C1" },
      C1: { ids: ["a1", "a2"], next: "C1" },
    });
    globalThis.fetch = archive.fetch;

    await ingestNextChunk(svc, ["feature_films"], { maxPages: 5 });

    expect(archive.cursorsSent).toEqual(["", "C1"]);
    const run = svc.latestRun("feature_films");
    expect(run?.status).toBe("done");
    expect(run?.error).toContain("cursor");
  }, 15_000);

  it("still walks every page of a collection whose cursor advances", async () => {
    const archive = fakeScrape({
      "": { ids: ["a1", "a2"], next: "C1" },
      C1: { ids: ["b1", "b2"], next: "C2" },
      C2: { ids: ["c1", "c2"], next: null },
    });
    globalThis.fetch = archive.fetch;

    await ingestNextChunk(svc, ["feature_films"], { maxPages: 5 });

    expect(archive.cursorsSent).toEqual(["", "C1", "C2"]);
    const run = svc.latestRun("feature_films");
    expect(run?.status).toBe("done");
    expect(run?.error ?? "").toBe("");
  }, 15_000);
});
