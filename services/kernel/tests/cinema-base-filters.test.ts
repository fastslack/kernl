/**
 * Characterization of the base filter clauses shared by `list`, `countAll`
 * and `filterByIds` (hidden, torrent, watchlist, collection, kind, year
 * range, language, tags). The three entry points must agree on every one of
 * them — a listing that shows N titles next to a count that says M is the
 * bug this guards against.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import type { CinemaListFilter } from "../assets/extensions/leisure/cinema/_module/types.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

let db: SqliteDb;
let svc: CinemaService;

interface Seed {
  year?: number;
  language?: string;
  collections?: string[];
  subjects?: string[];
  torrent?: boolean;
  hidden?: boolean;
  watchlist?: boolean;
}

function title(identifier: string, o: Seed = {}) {
  const now = "2026-08-06T00:00:00Z";
  db.prepare(`
    INSERT INTO cinema_titles
      (identifier, title, date, year, creator, description, description_es,
       subject_json, collection_json, language, licenseurl, runtime_sec,
       downloads, week_downloads, avg_rating, num_reviews, has_torrent,
       poster_url, addeddate, publicdate, ingested_at, last_seen_at,
       hidden, watchlist)
    VALUES (?, ?, '', ?, '', '', '', ?, ?, ?, '', 0,
            0, 0, 0, 0, ?, '', ?, ?, ?, ?, ?, ?)
  `).run(
    identifier, identifier, o.year ?? 1930,
    JSON.stringify(o.subjects ?? []),
    JSON.stringify(o.collections ?? ["feature_films"]),
    o.language ?? "English",
    (o.torrent ?? true) ? 1 : 0,
    now, now, now, now,
    o.hidden ? 1 : 0,
    o.watchlist ? 1 : 0,
  );
}

const ALL = ["film-a", "film-b", "series-a", "series-b", "hidden", "notorrent"];

beforeEach(() => {
  db = new Database(":memory:") as unknown as SqliteDb;
  runMigrations(db, "cinema", cinemaMigrations);
  svc = new CinemaService(db);
  title("film-a", { year: 1925, language: "English", subjects: ["silent", "drama"], watchlist: true });
  title("film-b", { year: 1950, language: "fr", subjects: ["noir"], collections: ["film_noir", "feature_films"] });
  title("series-a", { year: 1960, language: "eng", subjects: ["comedy", "drama"], collections: ["classic_tv"] });
  title("series-b", { year: 1975, language: "Spanish", subjects: ["comedy"], collections: ["television"], watchlist: true });
  title("hidden", { year: 1940, subjects: ["drama"], hidden: true });
  title("notorrent", { year: 1945, subjects: ["drama"], torrent: false });
});

/** Every entry point, answering the same filter. */
function all(filter: CinemaListFilter) {
  const listed = svc.list(filter).map((t) => t.identifier).sort();
  const counted = svc.countAll(filter);
  const byIds = svc.filterByIds(ALL, filter).map((t) => t.identifier).sort();
  expect(counted).toBe(listed.length);
  expect(byIds).toEqual(listed);
  return listed;
}

describe("base filter clauses", () => {
  it("defaults exclude hidden and torrentless titles", () => {
    expect(all({})).toEqual(["film-a", "film-b", "series-a", "series-b"]);
  });

  it("hidden: true and hasTorrent: false lift the defaults", () => {
    expect(all({ hidden: true })).toContain("hidden");
    expect(all({ hasTorrent: false })).toContain("notorrent");
    expect(all({ hidden: true, hasTorrent: false })).toEqual(ALL.slice().sort());
  });

  it("watchlist", () => {
    expect(all({ watchlist: true })).toEqual(["film-a", "series-b"]);
  });

  it("collection", () => {
    expect(all({ collection: "film_noir" })).toEqual(["film-b"]);
  });

  it("kind splits films from series", () => {
    expect(all({ kind: "series" })).toEqual(["series-a", "series-b"]);
    expect(all({ kind: "film" })).toEqual(["film-a", "film-b"]);
  });

  it("year range", () => {
    expect(all({ yearMin: 1950 })).toEqual(["film-b", "series-a", "series-b"]);
    expect(all({ yearMax: 1950 })).toEqual(["film-a", "film-b"]);
    expect(all({ yearMin: 1950, yearMax: 1960 })).toEqual(["film-b", "series-a"]);
  });

  it("language is a case-insensitive prefix", () => {
    expect(all({ language: "EN" })).toEqual(["film-a", "series-a"]);
    expect(all({ language: "fr" })).toEqual(["film-b"]);
  });

  it("tags: single, all and any", () => {
    expect(all({ tag: "drama" })).toEqual(["film-a", "series-a"]);
    expect(all({ tags: ["comedy", "drama"] })).toEqual(["series-a"]);
    expect(all({ tags: ["comedy", "drama"], tagsMatch: "any" })).toEqual(["film-a", "series-a", "series-b"]);
    expect(all({ tag: "comedy", tags: ["drama"] })).toEqual(["series-a"]);
  });

  it("combined", () => {
    expect(all({ kind: "series", tag: "comedy", yearMin: 1970 })).toEqual(["series-b"]);
    expect(all({ kind: "film", hidden: true, tag: "drama" })).toEqual(["film-a", "hidden"]);
  });

  it("filterByIds keeps the caller's order", () => {
    expect(svc.filterByIds(["series-b", "film-a", "film-b"], {}).map((t) => t.identifier))
      .toEqual(["series-b", "film-a", "film-b"]);
  });
});
