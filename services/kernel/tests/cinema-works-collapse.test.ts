/**
 * Collapse, end to end through the service.
 *
 * The grouping rules are pinned in cinema-works-dedupe; what is asserted here
 * is that the collapsed listing and the collapsed COUNT agree, that a
 * collapsed row reports its work's totals rather than the chosen copy's share
 * of them, and that the weighted rating finally has the votes it needs.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

let db: SqliteDb;
let svc: CinemaService;

function title(
  identifier: string,
  o: {
    title?: string; year?: number; downloads?: number; runtime?: number;
    avg?: number; reviews?: number;
  } = {},
) {
  const now = "2026-08-05T00:00:00Z";
  db.prepare(`
    INSERT INTO cinema_titles
      (identifier, title, date, year, creator, description, description_es,
       subject_json, collection_json, language, licenseurl, runtime_sec,
       downloads, week_downloads, avg_rating, num_reviews, has_torrent,
       poster_url, addeddate, publicdate, ingested_at, last_seen_at)
    VALUES (?, ?, '', ?, '', '', '', '[]', '["feature_films"]', 'en', '', ?,
            ?, 0, ?, ?, 1, '', ?, ?, ?, ?)
  `).run(
    identifier, o.title ?? identifier, o.year ?? 1927, o.runtime ?? 0,
    o.downloads ?? 0, o.avg ?? 0, o.reviews ?? 0, now, now, now, now,
  );
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as SqliteDb;
  runMigrations(db, "cinema", cinemaMigrations);
  svc = new CinemaService(db);
});

describe("collapsed listing", () => {
  beforeEach(() => {
    // One film, three uploads, with the popularity split across them.
    title("metro-a", { title: "Metropolis", year: 1927, runtime: 9000, downloads: 50_000, avg: 4.6, reviews: 25 });
    title("metro-b", { title: "Metropolis (1927) 1080p", year: 1927, downloads: 800, avg: 5, reviews: 5 });
    title("metro-c", { title: "Metropolis FULL MOVIE", year: 0, downloads: 200 });
    // A second, unrelated film.
    title("other", { title: "Some Other Film", year: 1930, downloads: 100 });
    svc.rebuildWorks();
  });

  it("shows one row per film instead of one per upload", () => {
    expect(svc.list({}).length).toBe(4);
    expect(svc.list({ collapse: true }).length).toBe(2);
  });

  it("makes the count agree with the listing", () => {
    expect(svc.countAll({ collapse: true })).toBe(2);
    expect(svc.countAll({})).toBe(4);
  });

  it("reports the work's summed downloads, not the shown copy's share", () => {
    const metro = svc.list({ collapse: true }).find((t) => t.title.startsWith("Metropolis"));
    expect(metro?.downloads).toBe(51_000);
  });

  it("gives the weighted rating the votes that were split across copies", () => {
    const metro = svc.list({ collapse: true }).find((t) => t.title.startsWith("Metropolis"));
    expect(metro?.num_reviews).toBe(30);
    // Vote-weighted: (4.6*25 + 5*5) / 30
    expect(metro?.avg_rating).toBeCloseTo(4.6667, 3);
  });

  it("reports how many copies were folded in", () => {
    const rows = svc.list({ collapse: true });
    const metro = rows.find((t) => t.title.startsWith("Metropolis"));
    const other = rows.find((t) => t.identifier === "other");
    expect(metro?.copies).toBe(3);
    expect(other?.copies).toBe(1);
  });

  it("leaves uncollapsed rows reporting exactly what they did before", () => {
    const b = svc.list({}).find((t) => t.identifier === "metro-b");
    expect(b?.downloads).toBe(800);
    expect(b?.copies).toBeUndefined();
  });

  it("shows the copy with a real runtime, not the most downloaded stub", () => {
    const metro = svc.list({ collapse: true }).find((t) => t.title.startsWith("Metropolis"));
    expect(metro?.identifier).toBe("metro-a");
  });
});

describe("sibling copies", () => {
  beforeEach(() => {
    title("metro-a", { title: "Metropolis", year: 1927, runtime: 9000 });
    title("metro-b", { title: "Metropolis 1080p", year: 1927 });
    title("alone", { title: "Only Copy", year: 1930 });
    svc.rebuildWorks();
  });

  it("lists the other uploads of the same film", () => {
    expect(svc.siblingCopies("metro-a").map((t) => t.identifier)).toEqual(["metro-b"]);
  });

  it("is empty for a film with a single upload", () => {
    expect(svc.siblingCopies("alone")).toHaveLength(0);
  });

  it("never lists a title as its own sibling", () => {
    expect(svc.siblingCopies("metro-b").map((t) => t.identifier)).not.toContain("metro-b");
  });
});

describe("rebuild", () => {
  it("reports the duplication it folded away", () => {
    title("a", { title: "Metropolis", year: 1927 });
    title("b", { title: "Metropolis", year: 1927 });
    title("c", { title: "Elsewhere", year: 1930 });
    const r = svc.rebuildWorks();
    expect(r.works).toBe(2);
    expect(r.members).toBe(3);
    expect(r.collapsed).toBe(1);
    expect(r.duplicates).toBe(1);
  });

  it("is idempotent", () => {
    title("a", { title: "Metropolis", year: 1927 });
    title("b", { title: "Metropolis", year: 1927 });
    const first = svc.rebuildWorks();
    const second = svc.rebuildWorks();
    expect(second).toEqual(first);
    expect(svc.list({ collapse: true })).toHaveLength(1);
  });

  it("picks up a newly ingested copy on the next rebuild", () => {
    title("a", { title: "Metropolis", year: 1927 });
    svc.rebuildWorks();
    expect(svc.list({ collapse: true })[0].copies).toBe(1);

    title("b", { title: "Metropolis", year: 1927 });
    svc.rebuildWorks();
    expect(svc.list({ collapse: true })[0].copies).toBe(2);
  });

  it("reports catalogue-wide duplication", () => {
    title("a", { title: "Metropolis", year: 1927 });
    title("b", { title: "Metropolis", year: 1927 });
    title("c", { title: "Elsewhere", year: 1930 });
    svc.rebuildWorks();
    expect(svc.worksStats()).toEqual({ works: 2, titles: 3, collapsed: 1, duplicates: 1 });
  });
});

describe("collapse composes with the other filters", () => {
  it("still honours a year range", () => {
    title("a", { title: "Metropolis", year: 1927 });
    title("b", { title: "Metropolis", year: 1927 });
    title("c", { title: "Modern Thing", year: 1990 });
    svc.rebuildWorks();
    const rows = svc.list({ collapse: true, yearMin: 1980 });
    expect(rows.map((t) => t.identifier)).toEqual(["c"]);
  });

  it("orders collapsed rows by the work's totals", () => {
    // "quiet" wins only once its copies are summed — which is the bug.
    title("loud", { title: "Loud Film", year: 1930, downloads: 40_000 });
    title("quiet-a", { title: "Quiet Film", year: 1931, downloads: 25_000 });
    title("quiet-b", { title: "Quiet Film", year: 1931, downloads: 25_000 });
    svc.rebuildWorks();

    expect(svc.list({ sort: "downloads" })[0].identifier).toBe("loud");
    expect(svc.list({ collapse: true, sort: "downloads" })[0].title).toBe("Quiet Film");
  });
});
