/**
 * The matcher's job is to refuse to guess.
 *
 * A missed match costs a title its badge. A wrong match hands an uploader's
 * home movie the identity, rating, and ranking slot of a canonical film —
 * which is the exact failure this whole feature exists to prevent. So most of
 * what is asserted here is what the matcher declines to do.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import {
  CandidateIndex,
  matchTitle,
  yearFactor,
  AUTO_FLOOR,
  REVIEW_FLOOR,
} from "../assets/extensions/leisure/cinema/_module/canonical/matcher.js";
import { normalizeTitle } from "../assets/extensions/leisure/cinema/_module/title-norm.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

let db: SqliteDb;
let index: CandidateIndex;

/** Seed one canonical work plus every title it is known by. */
function work(
  qid: string,
  label: string,
  year: number,
  aliases: string[] = [],
  extra: { imdb_id?: string; director?: string } = {},
) {
  db.prepare(`
    INSERT INTO cinema_canonical_works
      (qid, label, label_norm, year, imdb_id, director, country, genre_json, duration_min, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, '', '[]', 0, '2026-08-05T00:00:00Z')
  `).run(qid, label, normalizeTitle(label), year, extra.imdb_id ?? "", extra.director ?? "");

  for (const a of [label, ...aliases]) {
    const norm = normalizeTitle(a);
    if (!norm) continue;
    db.prepare(`
      INSERT OR IGNORE INTO cinema_canonical_aliases (qid, alias_norm, alias_raw, lang)
      VALUES (?, ?, ?, '')
    `).run(qid, norm, a);
  }
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as SqliteDb;
  runMigrations(db, "cinema", cinemaMigrations);

  work("Q151895", "Nosferatu", 1922, [
    "Nosferatu, eine Symphonie des Grauens",
    "Nosferatu, una sinfonía del horror",
  ], { imdb_id: "tt0013442", director: "F. W. Murnau" });

  work("Q123397", "The Cabinet of Dr. Caligari", 1920, [
    "Das Cabinet des Dr. Caligari",
    "El gabinete del doctor Caligari",
  ], { imdb_id: "tt0010323" });

  work("Q483815", "Metropolis", 1927, [], { imdb_id: "tt0017136" });

  // The remake trap: same name, different works, decades apart.
  work("Q191224", "Dracula", 1931, [], { imdb_id: "tt0021814" });
  work("Q193035", "Dracula", 1958, [], { imdb_id: "tt0051554" });
  work("Q1237326", "Dracula", 1979, []);

  // The near-miss trap: contains another film's whole title.
  work("Q1234567", "Dracula's Daughter", 1936, []);

  index = new CandidateIndex(db);
});

describe("yearFactor", () => {
  it("does not punish a one-year drift, because release dates genuinely drift", () => {
    expect(yearFactor(1922, 1922)).toBe(1);
    expect(yearFactor(1922, 1923)).toBeGreaterThan(AUTO_FLOOR);
  });

  it("treats a distant year as a different work, not a near-miss", () => {
    expect(yearFactor(1931, 1958)).toBe(0);
  });

  it("caps a yearless upload below the automatic floor", () => {
    expect(yearFactor(0, 1922)).toBeLessThan(AUTO_FLOOR);
    expect(yearFactor(0, 1922)).toBeGreaterThan(REVIEW_FLOOR);
  });
});

describe("matchTitle", () => {
  it("accepts an exact title and year", () => {
    const r = matchTitle(index, "Metropolis", 1927);
    expect(r.state).toBe("auto");
    expect(r.qid).toBe("Q483815");
  });

  it("sees through uploader annotation and rip settings", () => {
    const r = matchTitle(index, "Metropolis (1927) 1080p x264 FULL MOVIE", 0);
    expect(r.state).toBe("auto");
    expect(r.qid).toBe("Q483815");
  });

  it("matches the European silent era under its ORIGINAL title", () => {
    // The reason aliases are pulled in every language: these films are
    // uploaded as their makers named them, not as Wikidata's English label.
    const r = matchTitle(index, "Nosferatu, eine Symphonie des Grauens", 1922);
    expect(r.state).toBe("auto");
    expect(r.qid).toBe("Q151895");

    const es = matchTitle(index, "Das Cabinet des Dr. Caligari", 1920);
    expect(es.state).toBe("auto");
    expect(es.qid).toBe("Q123397");
  });

  it("picks the right remake when the year says which one", () => {
    expect(matchTitle(index, "Dracula", 1931).qid).toBe("Q191224");
    expect(matchTitle(index, "Dracula", 1958).qid).toBe("Q193035");
  });

  it("refuses to pick a remake when the upload has no year", () => {
    // Three Draculas, nothing to choose between them. A coin flip here is
    // exactly the bug being prevented.
    const r = matchTitle(index, "Dracula", 0);
    expect(r.state).toBe("review");
    expect(r.qid).toBe("");
    expect(r.candidates.length).toBeGreaterThan(1);
  });

  it("never auto-accepts a yearless upload, even on a unique exact title", () => {
    const r = matchTitle(index, "Metropolis", 0);
    expect(r.state).toBe("review");
    expect(r.qid).toBe("");
  });

  it("does not hand one film the identity of another it merely contains", () => {
    const r = matchTitle(index, "Dracula's Daughter", 1936);
    expect(r.qid).toBe("Q1234567");
    expect(r.state).toBe("auto");
  });

  it("leaves an unrelated upload unmatched", () => {
    const r = matchTitle(index, "My trip to the lake, summer 94", 1994);
    expect(r.state).toBe("none");
    expect(r.qid).toBe("");
    expect(r.candidates).toHaveLength(0);
  });

  it("rejects a title that agrees but sits decades away", () => {
    const r = matchTitle(index, "Metropolis", 1995);
    expect(r.state).toBe("none");
  });

  it("tolerates a one-year drift", () => {
    const r = matchTitle(index, "Metropolis", 1928);
    expect(r.state).toBe("auto");
    expect(r.qid).toBe("Q483815");
  });

  it("finds a work through fuzzy matching when no spelling matches exactly", () => {
    // "Cabinet of Doctor Caligari" is nobody's stored alias.
    const r = matchTitle(index, "Cabinet of Doctor Caligari", 1920);
    expect(r.qid === "Q123397" || r.candidates[0]?.qid === "Q123397").toBe(true);
    expect(r.score).toBeGreaterThan(REVIEW_FLOOR);
  });

  it("returns nothing for a title that normalizes away entirely", () => {
    const r = matchTitle(index, "1080p", 1927);
    expect(r.state).toBe("none");
  });

  it("accepts a near-miss title when nothing rivals it and the year agrees", () => {
    // Measured on the live catalogue: this band was correct every time it was
    // sampled — an episode number prefixed to a series title, a typo on
    // Wikidata's side, a displaced article. The strict floor exists to stop
    // the matcher choosing between rival works; with no rival there is
    // nothing to choose between.
    work("Q900", "Lone Wolf and Cub: Baby Cart to Hades", 1972);
    const r = matchTitle(index, "Lone Wolf And Cub: 3 - Baby Cart To Hades", 1972);
    expect(r.state).toBe("auto");
    expect(r.qid).toBe("Q900");
  });

  it("still refuses a near-miss when the year disagrees", () => {
    // The two Enoch Ardens, 1911 and 1914, are different films. The exact-year
    // requirement is what keeps the relaxed floor from swallowing them.
    work("Q901", "Enoch Arden", 1914);
    const r = matchTitle(index, "Enoch Arden", 1911);
    expect(r.state).not.toBe("auto");
  });

  it("still refuses a near-miss when something else also matched", () => {
    // Grandma's vs Grandpa's Reading Glass — a rival is exactly the situation
    // the strict floor is for, so the relaxed one must not apply.
    work("Q902", "Grandpa's Reading Glass", 1902);
    work("Q903", "Grandma's Reading Glasses", 1902);
    const r = matchTitle(index, "Grandma's Reading Glass", 1902);
    expect(r.state).not.toBe("auto");
  });

  it("reports which alias produced the score, for the review UI", () => {
    const r = matchTitle(index, "Nosferatu, eine Symphonie des Grauens", 1922);
    expect(r.candidates[0].via).toBeTruthy();
    expect(r.candidates[0].imdb_id).toBe("tt0013442");
  });
});
