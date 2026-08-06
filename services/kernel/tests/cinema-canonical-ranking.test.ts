/**
 * What identification actually buys the "best" order.
 *
 * Before this, the weighted rating had nothing to weigh. Almost every row in
 * the catalogue carries zero reviews, so the score collapsed to the global
 * mean for all of them and the tiebreak — review count — quietly became the
 * whole ranking. These assertions pin the two things that changed: votes now
 * come from wherever they exist, and being a catalogued work is itself
 * evidence.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import { normalizeTitle } from "../assets/extensions/leisure/cinema/_module/title-norm.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

let db: SqliteDb;
let svc: CinemaService;

function title(
  identifier: string,
  o: {
    title?: string; year?: number; avg?: number; reviews?: number;
    downloads?: number; collection?: string;
  } = {},
) {
  const now = "2026-08-05T00:00:00Z";
  db.prepare(`
    INSERT INTO cinema_titles
      (identifier, title, date, year, creator, description, description_es,
       subject_json, collection_json, language, licenseurl, runtime_sec,
       downloads, week_downloads, avg_rating, num_reviews, has_torrent,
       poster_url, addeddate, publicdate, ingested_at, last_seen_at)
    VALUES (?, ?, '', ?, '', '', '', '[]', ?, 'en', '', 0,
            ?, 0, ?, ?, 1, '', ?, ?, ?, ?)
  `).run(
    identifier, o.title ?? identifier, o.year ?? 1930,
    JSON.stringify([o.collection ?? "feature_films"]),
    o.downloads ?? 0, o.avg ?? 0, o.reviews ?? 0, now, now, now, now,
  );
}

/** Seed a canonical work and mark a title as identified against it. */
function identify(
  identifier: string,
  qid: string,
  o: { label?: string; year?: number; extRating?: number; extVotes?: number; state?: string } = {},
) {
  const label = o.label ?? qid;
  db.prepare(`
    INSERT OR IGNORE INTO cinema_canonical_works
      (qid, label, label_norm, year, imdb_id, director, country, genre_json,
       duration_min, ext_rating, ext_votes, ext_source, fetched_at)
    VALUES (?, ?, ?, ?, '', 'A Director', 'US', '[]', 0, ?, ?, 'tmdb', '2026-08-05T00:00:00Z')
  `).run(qid, label, normalizeTitle(label), o.year ?? 1930, o.extRating ?? 0, o.extVotes ?? 0);

  db.prepare(`
    INSERT INTO cinema_title_matches
      (identifier, qid, score, state, candidates_json, matcher_version, matched_at)
    VALUES (?, ?, 1.0, ?, '[]', 1, '2026-08-05T00:00:00Z')
  `).run(identifier, qid, o.state ?? "auto");
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as SqliteDb;
  runMigrations(db, "cinema", cinemaMigrations);
  svc = new CinemaService(db);
});

describe("best order with canonical identity", () => {
  it("puts an identified title above an unidentified one when nothing else separates them", () => {
    // Both unrated and unreviewed — previously indistinguishable.
    title("known", { title: "Metropolis" });
    title("unknown", { title: "my home video" });
    identify("known", "Q483815", { label: "Metropolis" });

    const order = svc.list({ sort: "best" }).map((t) => t.identifier);
    expect(order[0]).toBe("known");
  });

  it("does not hide the unidentified tail — it only ranks it lower", () => {
    title("known", { title: "Metropolis" });
    title("unknown", { title: "Prelinger industrial short" });
    identify("known", "Q483815", { label: "Metropolis" });

    const all = svc.list({ sort: "best" }).map((t) => t.identifier);
    expect(all).toContain("unknown");
    expect(all).toHaveLength(2);
  });

  it("uses external votes when archive.org has none", () => {
    // The whole point: a film TMDb measured with thousands of votes was
    // previously scored as if nobody had ever seen it.
    title("measured", { title: "Metropolis" });
    title("alsoknown", { title: "Some Other Film" });
    identify("measured", "Q1", { label: "Metropolis", extRating: 8.4, extVotes: 4000 });
    identify("alsoknown", "Q2", { label: "Some Other Film" });

    const order = svc.list({ sort: "best" }).map((t) => t.identifier);
    expect(order[0]).toBe("measured");
  });

  it("lets a badly-scored identified film fall below a well-reviewed one", () => {
    // Identification is evidence, not a verdict — it must not outrank
    // measured quality outright.
    title("bad", { title: "Bad Film" });
    title("goodlocal", { title: "Good Film", avg: 4.9, reviews: 300 });
    identify("bad", "Q1", { label: "Bad Film", extRating: 1.5, extVotes: 2000 });

    const order = svc.list({ sort: "best" }).map((t) => t.identifier);
    expect(order[0]).toBe("goodlocal");
  });

  it("treats a review-queue verdict as NOT identified", () => {
    // A pending human decision is not an identity yet.
    title("pending", { title: "Dracula" });
    title("plain", { title: "another upload" });
    identify("pending", "Q191224", { label: "Dracula", state: "review" });

    const rows = svc.list({ sort: "best" });
    expect(rows.find((t) => t.identifier === "pending")?.canonical).toBeNull();
  });

  it("does not discount collections Wikidata has never catalogued", () => {
    // Measured against the live catalogue: classic_cartoons is 0 of 81
    // identified, because Wikidata catalogues features and not theatrical
    // animated shorts. Charging those a penalty would demote the single
    // most-downloaded thing in the catalogue on the strength of a fact about
    // Wikidata's coverage rather than about the film.
    title("cartoon", { title: "Popeye: Shuteye", collection: "classic_cartoons" });
    title("plainmiss", { title: "Unidentified Feature", collection: "feature_films" });

    const order = svc.list({ sort: "best" }).map((t) => t.identifier);
    expect(order[0]).toBe("cartoon");
  });

  it("still ranks an identified feature above an exempt-collection title of equal measure", () => {
    // The exemption removes a penalty; it does not award a bonus.
    title("cartoon", { title: "Popeye: Shuteye", collection: "classic_cartoons" });
    title("known", { title: "Metropolis", collection: "feature_films", avg: 4.8, reviews: 200 });
    identify("known", "Q483815", { label: "Metropolis" });

    expect(svc.list({ sort: "best" })[0].identifier).toBe("known");
  });

  it("counts a human confirmation as identified", () => {
    title("confirmed", { title: "Dracula" });
    identify("confirmed", "Q191224", { label: "Dracula", state: "confirmed" });

    const row = svc.list({ sort: "best" })[0];
    expect(row.canonical?.qid).toBe("Q191224");
  });
});

describe("identifiedOnly filter", () => {
  beforeEach(() => {
    title("known", { title: "Metropolis" });
    title("unknown", { title: "home video" });
    identify("known", "Q483815", { label: "Metropolis" });
  });

  it("is off by default", () => {
    expect(svc.list({}).length).toBe(2);
    expect(svc.countAll({})).toBe(2);
  });

  it("narrows to identified titles when asked", () => {
    const rows = svc.list({ identifiedOnly: true });
    expect(rows.map((t) => t.identifier)).toEqual(["known"]);
    expect(svc.countAll({ identifiedOnly: true })).toBe(1);
  });
});

describe("canonical block on a title row", () => {
  it("carries the metadata the badge needs", () => {
    title("known", { title: "Metropolis", year: 1927 });
    identify("known", "Q483815", { label: "Metropolis", year: 1927, extRating: 8.4, extVotes: 4000 });

    const t = svc.getByIdentifier("known");
    expect(t?.canonical?.label).toBe("Metropolis");
    expect(t?.canonical?.director).toBe("A Director");
    expect(t?.canonical?.country).toBe("US");
    // TMDb rates 0..10; the catalogue speaks 0..5.
    expect(t?.canonical?.ext_rating).toBeCloseTo(4.2, 5);
  });

  it("is null for an unmatched title", () => {
    title("unknown", { title: "home video" });
    expect(svc.getByIdentifier("unknown")?.canonical).toBeNull();
  });
});
