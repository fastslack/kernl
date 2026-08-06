/**
 * Curated-list rails.
 *
 * Two things carry the design and are pinned here. Membership is keyed on the
 * WORK, not the upload — the Library of Congress selected a film, not
 * somebody's 480p transfer of it — so every copy inherits the rail through
 * the canonical match. And a work on two rails must appear ONCE, which is why
 * the query uses a scalar subquery and EXISTS rather than a join.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import { canonRails, CANON_LISTS, canonListByKey } from "../assets/extensions/leisure/cinema/_module/canonical/canon.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

let db: SqliteDb;
let svc: CinemaService;

function title(identifier: string, o: { title?: string } = {}) {
  const now = "2026-08-06T00:00:00Z";
  db.prepare(`
    INSERT INTO cinema_titles
      (identifier, title, date, year, creator, description, description_es,
       subject_json, collection_json, language, licenseurl, runtime_sec,
       downloads, week_downloads, avg_rating, num_reviews, has_torrent,
       poster_url, addeddate, publicdate, ingested_at, last_seen_at)
    VALUES (?, ?, '', 1930, '', '', '', '[]', '["feature_films"]', 'en', '', 0,
            0, 0, 0, 0, 1, '', ?, ?, ?, ?)
  `).run(identifier, o.title ?? identifier, now, now, now, now);
}

function identify(identifier: string, qid: string, state = "auto") {
  db.prepare(`
    INSERT OR IGNORE INTO cinema_canonical_works
      (qid, label, label_norm, year, imdb_id, director, country, genre_json,
       duration_min, fetched_at)
    VALUES (?, ?, ?, 1930, '', '', '', '[]', 0, '2026-08-06T00:00:00Z')
  `).run(qid, qid, qid.toLowerCase());
  db.prepare(`
    INSERT INTO cinema_title_matches
      (identifier, qid, score, state, candidates_json, matcher_version, matched_at)
    VALUES (?, ?, 1.0, ?, '[]', 1, '2026-08-06T00:00:00Z')
  `).run(identifier, qid, state);
}

function enrol(qid: string, listKey: string) {
  db.prepare(`INSERT OR IGNORE INTO cinema_canon (qid, list_key) VALUES (?, ?)`)
    .run(qid, listKey);
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as SqliteDb;
  runMigrations(db, "cinema", cinemaMigrations);
  svc = new CinemaService(db);
});

describe("the list registry", () => {
  it("has stable, unique keys", () => {
    const keys = CANON_LISTS.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("resolves a known key and refuses an unknown one", () => {
    expect(canonListByKey("nfr")?.label).toBe("National Film Registry");
    expect(canonListByKey("not-a-rail")).toBeUndefined();
  });

  it("only uses the two properties that were verified to carry membership", () => {
    // P1435 was checked against the live endpoint and carries four values
    // across all of Wikidata — it is not how any of this is recorded.
    for (const l of CANON_LISTS) expect(["P361", "P166"]).toContain(l.property);
  });
});

describe("rail membership on a title", () => {
  beforeEach(() => {
    title("kane", { title: "Citizen Kane" });
    identify("kane", "Q104123");
    enrol("Q104123", "nfr");
    enrol("Q104123", "best_picture");

    title("plain", { title: "Some Other Film" });
    identify("plain", "Q999");
  });

  it("attaches every list the work is on", () => {
    const t = svc.getByIdentifier("kane");
    expect(t?.canon?.sort()).toEqual(["best_picture", "nfr"]);
  });

  it("is empty for an identified work on no list", () => {
    expect(svc.getByIdentifier("plain")?.canon).toEqual([]);
  });

  it("is empty for an unidentified title", () => {
    title("unknown");
    expect(svc.getByIdentifier("unknown")?.canon).toEqual([]);
  });
});

describe("filtering by rail", () => {
  beforeEach(() => {
    title("kane"); identify("kane", "Q104123");
    enrol("Q104123", "nfr"); enrol("Q104123", "best_picture");
    title("nfronly"); identify("nfronly", "Q222"); enrol("Q222", "nfr");
    title("nothing"); identify("nothing", "Q333");
    title("unmatched");
  });

  it("narrows to one list", () => {
    expect(svc.list({ canonList: "nfr" }).map((t) => t.identifier).sort())
      .toEqual(["kane", "nfronly"]);
    expect(svc.list({ canonList: "best_picture" }).map((t) => t.identifier))
      .toEqual(["kane"]);
  });

  it("returns a work on two rails exactly once", () => {
    // The failure this guards against is a join multiplying the row.
    const rows = svc.list({ canonOnly: true });
    expect(rows.filter((t) => t.identifier === "kane")).toHaveLength(1);
  });

  it("narrows to any list at all", () => {
    expect(svc.list({ canonOnly: true }).map((t) => t.identifier).sort())
      .toEqual(["kane", "nfronly"]);
  });

  it("keeps the count in step with the listing", () => {
    expect(svc.countAll({ canonList: "nfr" })).toBe(svc.list({ canonList: "nfr" }).length);
    expect(svc.countAll({ canonOnly: true })).toBe(svc.list({ canonOnly: true }).length);
  });

  it("changes nothing when not asked for", () => {
    expect(svc.list({})).toHaveLength(4);
  });

  it("composes with the other filters", () => {
    expect(svc.list({ canonList: "nfr", identifiedOnly: true }).map((t) => t.identifier).sort())
      .toEqual(["kane", "nfronly"]);
  });
});

describe("membership follows the work, not the upload", () => {
  it("gives every copy of a listed film the rail", () => {
    title("copy-a"); title("copy-b");
    identify("copy-a", "Q104123");
    identify("copy-b", "Q104123");
    enrol("Q104123", "nfr");

    expect(svc.list({ canonList: "nfr" }).map((t) => t.identifier).sort())
      .toEqual(["copy-a", "copy-b"]);
  });

  it("shows one row per film once the copies are collapsed", () => {
    title("copy-a"); title("copy-b");
    identify("copy-a", "Q104123");
    identify("copy-b", "Q104123");
    enrol("Q104123", "nfr");
    svc.rebuildWorks();

    const rows = svc.list({ canonList: "nfr", collapse: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].copies).toBe(2);
  });

  it("does not follow a match a human rejected", () => {
    title("rejected");
    identify("rejected", "Q104123", "rejected");
    enrol("Q104123", "nfr");
    // The qid is still on the row, but the verdict says it is not that film.
    expect(svc.getByIdentifier("rejected")?.canon).toEqual([]);
  });
});

describe("canonRails", () => {
  it("reports both the list size and how much the catalogue holds", () => {
    enrol("Q1", "nfr"); enrol("Q2", "nfr"); enrol("Q3", "nfr");
    title("have"); identify("have", "Q1");

    const nfr = canonRails(db).find((r) => r.key === "nfr");
    expect(nfr?.members).toBe(3);
    expect(nfr?.held).toBe(1);
  });

  it("reports zero held for a rail the catalogue has nothing from", () => {
    enrol("Q1", "palme_dor");
    const rail = canonRails(db).find((r) => r.key === "palme_dor");
    expect(rail?.members).toBe(1);
    expect(rail?.held).toBe(0);
  });

  it("registers no rail that is known not to populate", () => {
    // Criterion was tried as P361 → Q1204187 and returns zero rows live, so
    // it is not in the registry. A rail that can never fill is worse than an
    // absent one: it looks like the catalogue is lacking rather than the
    // definition being wrong.
    expect(canonListByKey("criterion")).toBeUndefined();
  });

  it("lists every registered rail even when empty", () => {
    expect(canonRails(db)).toHaveLength(CANON_LISTS.length);
  });

  it("counts a film on two rails once per rail, not once overall", () => {
    enrol("Q1", "nfr"); enrol("Q1", "best_picture");
    title("kane"); identify("kane", "Q1");
    const rails = canonRails(db);
    expect(rails.find((r) => r.key === "nfr")?.held).toBe(1);
    expect(rails.find((r) => r.key === "best_picture")?.held).toBe(1);
  });
});
