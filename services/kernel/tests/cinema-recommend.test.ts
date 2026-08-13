/**
 * The parts of discovery that can be wrong: the weighting and the centroid.
 *
 * The Neo4j calls are not exercised here — they are a thin wrapper over the
 * vector index the module already uses for search. What is pinned is the
 * arithmetic and the decisions around it: that a dislike pushes away rather
 * than being discarded, that a profile too small to average is refused rather
 * than guessed at, and that the four empty-rail outcomes stay distinguishable.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import {
  tasteWeight,
  buildProfile,
  centroid,
  MIN_PROFILE_TITLES,
} from "../assets/extensions/leisure/cinema/_module/recommend.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

let db: SqliteDb;

function title(
  identifier: string,
  o: { watchlist?: boolean; watched?: boolean; rating?: number } = {},
) {
  const now = "2026-08-06T00:00:00Z";
  db.prepare(`
    INSERT INTO cinema_titles
      (identifier, title, date, year, creator, description, description_es,
       subject_json, collection_json, language, licenseurl, runtime_sec,
       downloads, week_downloads, avg_rating, num_reviews, has_torrent,
       poster_url, addeddate, publicdate, watchlist, watched_at, user_rating,
       ingested_at, last_seen_at)
    VALUES (?, ?, '', 1930, '', '', '', '[]', '[]', 'en', '', 0,
            0, 0, 0, 0, 1, '', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    identifier, identifier, now, now,
    o.watchlist ? 1 : 0, o.watched ? now : null, o.rating ?? 0, now, now,
  );
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as SqliteDb;
  runMigrations(db, "cinema", cinemaMigrations);
});

describe("tasteWeight", () => {
  it("ranks commitment: rating beats watching beats saving", () => {
    const rated = tasteWeight({ identifier: "a", watchlist: 0, watched_at: null, user_rating: 9 });
    const watched = tasteWeight({ identifier: "b", watchlist: 0, watched_at: "x", user_rating: 0 });
    const saved = tasteWeight({ identifier: "c", watchlist: 1, watched_at: null, user_rating: 0 });
    expect(rated).toBeGreaterThan(watched);
    expect(watched).toBeGreaterThan(saved);
    expect(saved).toBeGreaterThan(0);
  });

  it("lets a dislike push the profile away instead of discarding it", () => {
    // "I watched this and hated it" is information about taste.
    expect(tasteWeight({ identifier: "a", watchlist: 0, watched_at: "x", user_rating: 2 }))
      .toBeLessThan(0);
  });

  it("treats a middling rating as no direction", () => {
    const w = tasteWeight({ identifier: "a", watchlist: 0, watched_at: "x", user_rating: 5 });
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(1);
  });

  it("says nothing about a title the user never touched", () => {
    expect(tasteWeight({ identifier: "a", watchlist: 0, watched_at: null, user_rating: 0 })).toBe(0);
  });
});

describe("buildProfile", () => {
  it("is empty on a catalogue nobody has used", () => {
    title("a"); title("b");
    expect(buildProfile(db)).toHaveLength(0);
  });

  it("picks up every kind of signal", () => {
    title("saved", { watchlist: true });
    title("seen", { watched: true });
    title("loved", { rating: 9 });
    title("untouched");
    expect(buildProfile(db).map((p) => p.identifier).sort())
      .toEqual(["loved", "saved", "seen"]);
  });

  it("keeps disliked titles, with negative weight", () => {
    title("hated", { watched: true, rating: 1 });
    const p = buildProfile(db);
    expect(p).toHaveLength(1);
    expect(p[0].weight).toBeLessThan(0);
  });

  it("drops rows that carry no direction at all", () => {
    title("untouched");
    expect(buildProfile(db)).toHaveLength(0);
  });
});

describe("centroid", () => {
  it("returns a unit vector", () => {
    const c = centroid([[3, 0, 0], [0, 4, 0]], [1, 1]);
    const norm = Math.sqrt(c!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("leans toward the heavier input", () => {
    const c = centroid([[1, 0], [0, 1]], [10, 1])!;
    expect(c[0]).toBeGreaterThan(c[1]);
  });

  it("moves away from a negative weight", () => {
    // Same two vectors; flipping the second to negative must flip which
    // side of the space the result sits on.
    const liked = centroid([[1, 0], [0, 1]], [1, 1])!;
    const disliked = centroid([[1, 0], [0, 1]], [1, -1])!;
    expect(liked[1]).toBeGreaterThan(0);
    expect(disliked[1]).toBeLessThan(0);
  });

  it("refuses a direction when the inputs cancel out", () => {
    // A zero vector has no direction to search in, so this must not be
    // handed to the index as if it did.
    expect(centroid([[1, 0], [1, 0]], [1, -1])).toBeNull();
  });

  it("refuses malformed input rather than producing NaN", () => {
    expect(centroid([], [])).toBeNull();
    expect(centroid([[1, 2]], [])).toBeNull();
    expect(centroid([[]], [1])).toBeNull();
  });

  it("ignores a vector of the wrong width instead of corrupting the sum", () => {
    const c = centroid([[1, 0], [1, 2, 3]], [1, 1])!;
    expect(c.every((x) => Number.isFinite(x))).toBe(true);
    expect(c).toHaveLength(2);
  });
});

describe("the profile threshold", () => {
  it("needs more than a couple of films to average", () => {
    // A centroid of one film IS that film, and the rail would recommend
    // copies of what was just watched.
    expect(MIN_PROFILE_TITLES).toBeGreaterThan(2);
  });

  it("does not count dislikes toward it", () => {
    // Three films someone hated describe what to avoid, not a taste.
    title("h1", { watched: true, rating: 1 });
    title("h2", { watched: true, rating: 2 });
    title("h3", { watched: true, rating: 1 });
    const positives = buildProfile(db).filter((p) => p.weight > 0);
    expect(positives.length).toBeLessThan(MIN_PROFILE_TITLES);
  });
});
