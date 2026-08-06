/**
 * "The best sci-fi films and series" — what the catalogue could not answer.
 *
 * It had a `rating` sort, and that sort was the raw average. On the real
 * SciFi_Horror shelf that produced VIOLENCE JACK ALL OVAs and War Of The
 * Monsters at 5.0 from three reviewers each, while Das Kabinett des Doktor
 * Caligari (4.6 from thirty-one) was nowhere. The average is not the ranking:
 * a title with almost no votes is not known to be good, it is just unmeasured.
 *
 * And there was no way to ask for series rather than films. The archive has no
 * such field — a serial lives in the television collections — so the split has
 * to be made from collection membership.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

let db: SqliteDb;
let svc: CinemaService;

/** One catalogue row, with only the fields these assertions care about. */
function add(o: {
  id: string; title: string; rating: number; reviews: number;
  collections?: string[]; year?: number; downloads?: number;
}) {
  db.prepare(`
    INSERT INTO cinema_titles (
      identifier, title, date, year, creator, description, description_es,
      subject_json, collection_json, language, licenseurl, runtime_sec,
      downloads, week_downloads, avg_rating, num_reviews, has_torrent,
      poster_url, addeddate, publicdate, watchlist, user_rating, user_tags,
      notes, hidden, embedded_model, embedded_dim, ingested_at, last_seen_at
    ) VALUES (?,?,'',?,'','','','[]',?,'','',0,?,0,?,?,1,'','','',0,0,'','',0,'',0,'','')
  `).run(
    o.id, o.title, o.year ?? 1960,
    JSON.stringify(o.collections ?? ["SciFi_Horror"]),
    o.downloads ?? 100, o.rating, o.reviews,
  );
}

/**
 * A believable spread of ordinary titles.
 *
 * The weighting pulls toward the catalogue's global mean, so that mean has to
 * be realistic or the formula has nothing to pull against: with only three
 * five-star rows the mean is 4.9 and everything is "above average". The live
 * catalogue sits at 3.50 across 18,005 reviewed titles — this reproduces that.
 */
function seedBaseline() {
  for (let i = 0; i < 40; i++) {
    add({
      id: `filler-${i}`, title: `Ordinary ${i}`,
      rating: 3 + (i % 3) * 0.25, reviews: 5 + (i % 7),
      collections: ["moviesandfilms"],   // never SciFi_Horror, never television
    });
  }
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as SqliteDb;
  runMigrations(db, "cinema", cinemaMigrations);
  svc = new CinemaService(db);
  seedBaseline();
});

describe("sort=best", () => {
  it("does not let three glowing reviews outrank thirty good ones", () => {
    add({ id: "caligari", title: "Das Kabinett des Doktor Caligari", rating: 4.6, reviews: 31 });
    add({ id: "violence-jack", title: "VIOLENCE JACK ALL OVAs", rating: 5.0, reviews: 3 });
    add({ id: "war-monsters", title: "War Of The Monsters", rating: 5.0, reviews: 3 });

    const best = svc.list({ collection: "SciFi_Horror", sort: "best", limit: 10 });
    expect(best[0].identifier).toBe("caligari");

    // The raw average is still available, and still says the other thing —
    // the two sorts answer different questions on purpose.
    const raw = svc.list({ collection: "SciFi_Horror", sort: "rating", limit: 10 });
    expect(raw[0].avg_rating).toBe(5.0);
  });

  it("ignores a lone perfect score entirely", () => {
    add({ id: "unknown", title: "One Enthusiast", rating: 5.0, reviews: 1 });
    add({ id: "known", title: "Widely Liked", rating: 4.2, reviews: 200 });
    expect(svc.list({ collection: "SciFi_Horror", sort: "best", limit: 5 })[0].identifier).toBe("known");
  });

  it("keeps a title with many votes above one with few at the same average", () => {
    add({ id: "few", title: "Few", rating: 4.5, reviews: 4 });
    add({ id: "many", title: "Many", rating: 4.5, reviews: 90 });
    const [first] = svc.list({ collection: "SciFi_Horror", sort: "best", limit: 5 });
    expect(first.identifier).toBe("many");
  });

  it("leaves unreviewed titles at the bottom rather than dropping them", () => {
    add({ id: "rated", title: "Rated", rating: 4.4, reviews: 40 });
    add({ id: "unrated", title: "Unrated", rating: 0, reviews: 0 });
    const out = svc.list({ collection: "SciFi_Horror", sort: "best", limit: 5 });
    expect(out[0].identifier).toBe("rated");
    expect(out.map((t) => t.identifier)).toContain("unrated");
  });
});

describe("kind — films vs series", () => {
  beforeEach(() => {
    add({ id: "film-a", title: "Forbidden Planet", rating: 4.5, reviews: 40, collections: ["SciFi_Horror", "feature_films"] });
    add({ id: "series-a", title: "The Outer Limits", rating: 4.4, reviews: 30, collections: ["SciFi_Horror", "classic_tv"] });
    add({ id: "series-b", title: "Science Fiction Theatre", rating: 4.3, reviews: 20, collections: ["television"] });
  });

  it("returns only series when asked for series", () => {
    const ids = svc.list({ kind: "series", limit: 100 }).map((t) => t.identifier);
    expect(ids).toContain("series-a");
    expect(ids).toContain("series-b");
    expect(ids).not.toContain("film-a");
  });

  it("returns only films when asked for films", () => {
    const ids = svc.list({ collection: "SciFi_Horror", kind: "film", limit: 100 }).map((t) => t.identifier);
    expect(ids).toEqual(["film-a"]);
  });

  it("returns both when not asked", () => {
    const ids = svc.list({ collection: "SciFi_Horror", limit: 100 }).map((t) => t.identifier);
    expect(ids).toContain("film-a");
    expect(ids).toContain("series-a");
  });

  it("combines with a collection and the best ranking — the actual question", () => {
    // "the best sci-fi series"
    const out = svc.list({ collection: "SciFi_Horror", kind: "series", sort: "best", limit: 100 });
    expect(out.map((t) => t.identifier)).toEqual(["series-a"]);
  });

  it("counts agree with the list, so paging is not off by the filter", () => {
    const filter = { collection: "SciFi_Horror", kind: "series" } as const;
    expect(svc.countAll(filter)).toBe(svc.list({ ...filter, limit: 100 }).length);
  });
});

describe("best composes with a text query", () => {
  it("ranks the matches by quality, not by text relevance", () => {
    // Sci-fi series are only reachable by text: they sit in the television
    // collections with no sci-fi collection of their own. Without this the
    // question "the best sci-fi series" could not be asked — the search order
    // always won.
    add({ id: "prisoner", title: "The Prisoner science fiction series", rating: 4.9, reviews: 40, collections: ["classic_tv"] });
    add({ id: "obscure", title: "Obscure science fiction serial", rating: 5.0, reviews: 2, collections: ["classic_tv"] });

    const byBest = svc.filterByIds(["obscure", "prisoner"], { kind: "series", sort: "best" });
    expect(byBest.map((t) => t.identifier)).toEqual(["prisoner", "obscure"]);
  });

  it("still honours the search order when no sort is asked for", () => {
    add({ id: "a", title: "A", rating: 4.9, reviews: 40, collections: ["classic_tv"] });
    add({ id: "b", title: "B", rating: 3.0, reviews: 40, collections: ["classic_tv"] });
    // The caller's sequence is the ranking; the service must not second-guess it.
    expect(svc.filterByIds(["b", "a"], { kind: "series" }).map((t) => t.identifier)).toEqual(["b", "a"]);
  });
});
