/**
 * Filtering by what an item actually contains.
 *
 * The load-bearing decision here is how UNPROBED titles behave. They fail
 * every media condition, on purpose: "at least 60 minutes" has no answer for
 * an item nobody has looked inside, and quietly letting those through would
 * make the filter useless for the hours the probe is still walking. The
 * listing and the count have to agree about that, or the grid reports a total
 * it cannot show.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

let db: SqliteDb;
let svc: CinemaService;

function title(identifier: string, o: { title?: string; runtime?: number } = {}) {
  const now = "2026-08-06T00:00:00Z";
  db.prepare(`
    INSERT INTO cinema_titles
      (identifier, title, date, year, creator, description, description_es,
       subject_json, collection_json, language, licenseurl, runtime_sec,
       downloads, week_downloads, avg_rating, num_reviews, has_torrent,
       poster_url, addeddate, publicdate, ingested_at, last_seen_at)
    VALUES (?, ?, '', 1930, '', '', '', '[]', '["feature_films"]', 'en', '', ?,
            0, 0, 0, 0, 1, '', ?, ?, ?, ?)
  `).run(identifier, o.title ?? identifier, o.runtime ?? 0, now, now, now, now);
}

function probe(
  identifier: string,
  o: {
    duration?: number; height?: number; width?: number;
    video?: boolean; streamable?: boolean; subs?: boolean; format?: string;
  } = {},
) {
  db.prepare(`
    INSERT INTO cinema_title_media
      (identifier, duration_sec, width, height, has_video, has_streamable,
       has_subtitles, video_count, total_bytes, best_format, probed_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, '2026-08-06T00:00:00Z', '')
  `).run(
    identifier, o.duration ?? 0, o.width ?? 0, o.height ?? 0,
    (o.video ?? true) ? 1 : 0, (o.streamable ?? true) ? 1 : 0,
    (o.subs ?? false) ? 1 : 0, o.format ?? "h.264",
  );
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as SqliteDb;
  runMigrations(db, "cinema", cinemaMigrations);
  svc = new CinemaService(db);
});

describe("minimum duration", () => {
  beforeEach(() => {
    title("feature", { title: "A Feature" });
    title("clip", { title: "A 40-second clip" });
    title("unprobed", { title: "Nobody looked yet" });
    probe("feature", { duration: 5400 });
    probe("clip", { duration: 40 });
  });

  it("removes the things that are not films", () => {
    const ids = svc.list({ minDurationSec: 3600 }).map((t) => t.identifier);
    expect(ids).toEqual(["feature"]);
  });

  it("excludes titles nobody has probed", () => {
    expect(svc.list({ minDurationSec: 3600 }).map((t) => t.identifier)).not.toContain("unprobed");
  });

  it("keeps the count in step with the listing", () => {
    expect(svc.countAll({ minDurationSec: 3600 })).toBe(svc.list({ minDurationSec: 3600 }).length);
  });

  it("changes nothing when not asked for", () => {
    expect(svc.list({}).length).toBe(3);
    expect(svc.countAll({})).toBe(3);
  });
});

describe("playable only", () => {
  it("drops an item whose torrent bundles no video", () => {
    // The real case: high in feature_films by downloads, has a torrent,
    // contains a thumbnail and five metadata files.
    title("real", { title: "A Real Film" });
    title("hollow", { title: "Torrent With No Film" });
    probe("real", { video: true, streamable: true });
    probe("hollow", { video: false, streamable: false });

    expect(svc.list({ playableOnly: true }).map((t) => t.identifier)).toEqual(["real"]);
    // has_torrent alone still calls both of them playable.
    expect(svc.list({}).length).toBe(2);
  });

  it("drops a video whose only format cannot be streamed", () => {
    title("realmedia");
    probe("realmedia", { video: true, streamable: false, format: "Real Media" });
    expect(svc.list({ playableOnly: true })).toHaveLength(0);
  });
});

describe("resolution and subtitles", () => {
  beforeEach(() => {
    title("hd"); title("lowres"); title("subbed");
    probe("hd", { height: 720, width: 1280 });
    probe("lowres", { height: 240, width: 320 });
    probe("subbed", { height: 480, subs: true });
  });

  it("filters by minimum height", () => {
    expect(svc.list({ minHeight: 480 }).map((t) => t.identifier).sort()).toEqual(["hd", "subbed"]);
  });

  it("filters by subtitle presence", () => {
    expect(svc.list({ hasSubtitles: true }).map((t) => t.identifier)).toEqual(["subbed"]);
  });

  it("composes several media conditions at once", () => {
    expect(svc.list({ minHeight: 400, hasSubtitles: true }).map((t) => t.identifier)).toEqual(["subbed"]);
  });
});

describe("the media block on a row", () => {
  it("is null until the item has been probed", () => {
    title("unprobed");
    expect(svc.getByIdentifier("unprobed")?.media).toBeNull();
  });

  it("tells 'not probed' apart from 'probed and empty'", () => {
    title("empty");
    probe("empty", { video: false, streamable: false });
    const m = svc.getByIdentifier("empty")?.media;
    expect(m).not.toBeNull();
    expect(m?.has_video).toBe(false);
  });

  it("carries the facts the card needs", () => {
    title("full");
    probe("full", { duration: 5400, width: 640, height: 480, subs: true, format: "h.264" });
    const m = svc.getByIdentifier("full")?.media;
    expect(m?.duration_sec).toBe(5400);
    expect(m?.height).toBe(480);
    expect(m?.has_subtitles).toBe(true);
    expect(m?.best_format).toBe("h.264");
  });
});

describe("media filters compose with the rest", () => {
  it("works alongside collapse", () => {
    title("a", { title: "Metropolis" });
    title("b", { title: "Metropolis" });
    title("short", { title: "A Clip" });
    probe("a", { duration: 5400 });
    probe("b", { duration: 5400 });
    probe("short", { duration: 30 });
    svc.rebuildWorks();

    const rows = svc.list({ collapse: true, minDurationSec: 3600 });
    expect(rows).toHaveLength(1);
    expect(rows[0].copies).toBe(2);
  });
});
