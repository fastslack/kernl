import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { watchRssFeeds } from "../assets/extensions/leisure/cinema/_module/rss-watcher.js";
import type { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";

// archive.org's scrape API answers 400 to any `count` below 100 (checked
// against the live endpoint: count=46 → 400, count=100 → 200). The watcher
// asked for exactly as many rows as it had identifiers, so every batch smaller
// than 100 was refused and new titles never reached the catalogue.

const realFetch = globalThis.fetch;

function rssFor(ids: string[]): string {
  const items = ids.map((id) => `<item><title>${id}</title><link>https://archive.org/details/${id}</link></item>`);
  return `<?xml version="1.0"?><rss><channel>${items.join("")}</channel></rss>`;
}

/** Stands in for archive.org: RSS per collection, and a scrape API with its real count floor. */
function fakeArchive(feeds: Record<string, string[]>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/collection-rss.php")) {
      return new Response(rssFor(feeds[url.searchParams.get("collection") ?? ""] ?? []));
    }
    if (url.pathname.endsWith("/scrape")) {
      if (Number(url.searchParams.get("count")) < 100) {
        return new Response(JSON.stringify({ error: "count must be between 100 and 10000" }), { status: 400 });
      }
      const wanted = [...(url.searchParams.get("q") ?? "").matchAll(/identifier:([^\s)]+)/g)].map((m) => m[1]);
      return Response.json({ items: wanted.map((identifier) => ({ identifier, title: identifier })) });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function recordingService(): { service: CinemaService; upserted: string[] } {
  const upserted: string[] = [];
  const service = {
    getByIdentifier: () => null,
    upsertFromScrape: (row: { identifier: string }) => {
      upserted.push(row.identifier);
      return { inserted: true, updated: false };
    },
  } as unknown as CinemaService;
  return { service, upserted };
}

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}_${i}`);

describe("cinema rss-watcher", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("hydrates a batch of fewer than 100 new titles", async () => {
    globalThis.fetch = fakeArchive({ feature_films: ids("film", 46) });
    const { service, upserted } = recordingService();

    const result = await watchRssFeeds(service, { collections: ["feature_films"] });

    expect(result.newIds).toBe(46);
    expect(upserted.length).toBe(46);
  });

  it("hydrates the last, partial chunk of a larger batch", async () => {
    globalThis.fetch = fakeArchive({ a: ids("a", 50), b: ids("b", 50), c: ids("c", 50) });
    const { service, upserted } = recordingService();

    const result = await watchRssFeeds(service, { collections: ["a", "b", "c"] });

    expect(result.newIds).toBe(150);
    expect(upserted.length).toBe(150);
  });
});
