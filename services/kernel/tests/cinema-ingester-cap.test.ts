import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { ingestNextChunk } from "../assets/extensions/leisure/cinema/_module/ingester.js";
import { CINEMA_CATALOG_POLICY } from "../assets/extensions/leisure/cinema/_module/catalog-cap.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import { storageMigrations } from "../src/modules/storage/migrations.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

// The cinema ingester walked archive.org forever: it had no ceiling at all.
// It now honours the one set on System › Storage for cinema.catalog-untouched.

const realFetch = globalThis.fetch;

function pagesOf(n: number) {
  const sent: string[] = [];
  const stub = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const cursor = url.searchParams.get("cursor") ?? "";
    sent.push(cursor);
    const page = Number(cursor || "0");
    const ids = Array.from({ length: n }, (_, i) => `t${page}-${i}`);
    return Response.json({ items: ids.map((identifier) => ({ identifier, title: identifier })), cursor: String(page + 1) });
  }) as typeof fetch;
  return { stub, sent };
}

describe("cinema ingester ceiling", () => {
  let db: SqliteDb;
  let svc: CinemaService;
  const setCap = (cap: number) =>
    db.prepare("INSERT INTO retention_settings (policy_id, enabled, days, cap, updated_at) VALUES (?, 0, NULL, ?, '')")
      .run(CINEMA_CATALOG_POLICY, cap);

  beforeEach(() => {
    db = new Database(":memory:") as unknown as SqliteDb;
    runMigrations(db, "cinema", cinemaMigrations);
    runMigrations(db, "storage", storageMigrations);
    svc = new CinemaService(db);
    delete process.env.ARCHIVE_INGEST_MAX_ROWS;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("stops at the page where the catalog reaches its ceiling", async () => {
    setCap(5);
    const archive = pagesOf(3);
    globalThis.fetch = archive.stub;
    await ingestNextChunk(svc, ["feature_films"], { maxPages: 10 });
    expect(svc.catalogSize()).toBe(6); // two pages of 3, then parked
    expect(archive.sent).toHaveLength(2);
  }, 20_000);

  it("does not call archive.org at all once it is at the ceiling", async () => {
    setCap(5);
    globalThis.fetch = pagesOf(3).stub;
    await ingestNextChunk(svc, ["feature_films"], { maxPages: 10 });
    const again = pagesOf(3);
    globalThis.fetch = again.stub;
    expect(await ingestNextChunk(svc, ["feature_films"], { maxPages: 10 })).toBeNull();
    expect(again.sent).toHaveLength(0);
  }, 20_000);

  it("keeps collecting without a ceiling", async () => {
    const archive = pagesOf(3);
    globalThis.fetch = archive.stub;
    await ingestNextChunk(svc, ["feature_films"], { maxPages: 4 });
    expect(svc.catalogSize()).toBe(12);
  }, 20_000);
});
