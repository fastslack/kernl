/**
 * The tag row is for browsing, and browsing needs genres.
 *
 * Two separate failures met here. The derived `cinema_tags` table had no
 * automatic rebuild — only a manual endpoint nothing called — so on a
 * catalogue of 68,255 tagged titles it sat at zero rows and the chip row
 * vanished entirely. And once rebuilt, the ranking is by raw frequency, which
 * on archive.org means the top of the list is Movie (14,265), trailer
 * (11,596), video, Youtube, IGN: true of almost everything, useful for
 * finding nothing.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

let db: SqliteDb;
let svc: CinemaService;

function add(id: string, subjects: string[]) {
  db.prepare(`
    INSERT INTO cinema_titles (
      identifier, title, date, year, creator, description, description_es,
      subject_json, collection_json, language, licenseurl, runtime_sec,
      downloads, week_downloads, avg_rating, num_reviews, has_torrent,
      poster_url, addeddate, publicdate, watchlist, user_rating, user_tags,
      notes, hidden, embedded_model, embedded_dim, ingested_at, last_seen_at
    ) VALUES (?,?,'',1960,'','','',?,'[]','','',0,0,0,0,0,1,'','','',0,0,'','',0,'',0,'','')
  `).run(id, id, JSON.stringify(subjects));
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as SqliteDb;
  runMigrations(db, "cinema", cinemaMigrations);
  svc = new CinemaService(db);
});

describe("rebuildTags", () => {
  it("derives the table from the titles' subjects", () => {
    add("a", ["Horror", "Silent"]);
    add("b", ["horror", "Drama"]);
    const { tags, titlesScanned } = svc.rebuildTags();
    expect(titlesScanned).toBe(2);
    expect(tags).toBeGreaterThan(0);

    const rows = svc.topTags(10);
    const horror = rows.find((r) => r.tag_norm === "horror");
    // Case is normalised for grouping, so both spellings are the same tag.
    expect(horror?.count).toBe(2);
  });

  it("is idempotent — running it twice does not double the counts", () => {
    add("a", ["Horror"]);
    svc.rebuildTags();
    svc.rebuildTags();
    expect(svc.topTags(10).find((r) => r.tag_norm === "horror")?.count).toBe(1);
  });
});

describe("topTags — the browse row", () => {
  beforeEach(() => {
    // The real shape of this catalogue: metadata dwarfs the genres.
    for (let i = 0; i < 50; i++) add(`meta-${i}`, ["Movie", "trailer", "video", "Youtube"]);
    for (let i = 0; i < 12; i++) add(`horror-${i}`, ["Horror"]);
    for (let i = 0; i < 8; i++) add(`noir-${i}`, ["Film Noir"]);
    for (let i = 0; i < 5; i++) add(`west-${i}`, ["Western"]);
    svc.rebuildTags();
  });

  it("drops the tags that describe the upload rather than the film", () => {
    const norms = svc.topTags(10).map((r) => r.tag_norm);
    expect(norms).not.toContain("movie");
    expect(norms).not.toContain("trailer");
    expect(norms).not.toContain("video");
    expect(norms).not.toContain("youtube");
  });

  it("puts the genres on the chips instead", () => {
    const norms = svc.topTags(10).map((r) => r.tag_norm);
    expect(norms).toContain("horror");
    expect(norms).toContain("film noir");
    expect(norms).toContain("western");
  });

  it("still fills the row it was asked for", () => {
    // Over-fetching before filtering is what keeps a limit of 3 returning 3
    // rather than whatever survived out of the first 3.
    expect(svc.topTags(3)).toHaveLength(3);
  });

  it("keeps frequency order among what survives", () => {
    const norms = svc.topTags(3).map((r) => r.tag_norm);
    expect(norms).toEqual(["horror", "film noir", "western"]);
  });

  it("does not filter an explicit search — typing 'trailer' means it", () => {
    const rows = svc.topTags(10, "trail");
    expect(rows.map((r) => r.tag_norm)).toContain("trailer");
  });
});
