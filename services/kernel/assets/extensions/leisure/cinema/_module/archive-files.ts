/**
 * What an archive.org item actually CONTAINS, as opposed to what its
 * catalogue row claims.
 *
 * The scrape API the ingester uses reports no file-level detail, so the
 * catalogue has been reasoning about playability from `format:"Archive
 * BitTorrent"` — the presence of a torrent. That proxy is wrong often enough
 * to matter: `HisNewJobCharlesChaplin-1915` sits in the top handful of
 * `feature_films` by downloads, carries a torrent, and holds six files, none
 * of which is video. The torrent bundles metadata and a thumbnail. Every
 * quality signal the catalogue has says it is a popular feature film.
 *
 * `https://archive.org/metadata/<id>` returns the real file list, verified
 * against the live endpoint: video files carry `length` (seconds, decimal
 * string), `width`, `height`, `format`, and `source` (`original` vs
 * `derivative`). That is enough to answer the three questions the catalogue
 * could not:
 *
 *   - is there anything playable here at all
 *   - how long is it really (`runtime_sec` is 0 across much of the catalogue)
 *   - what quality is it, and are there subtitles
 *
 * Parsing is separated from fetching so the shape logic is testable against
 * fixtures rather than the network.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";

const ENDPOINT = "https://archive.org/metadata";
const TIMEOUT_MS = 20_000;

/**
 * Formats that are video.
 *
 * Matched case-insensitively as substrings because archive.org's format
 * strings carry qualifiers — "512Kb MPEG4", "h.264 IA", "MPEG4" are all the
 * same family and new variants appear without warning.
 */
const VIDEO_FORMAT_PATTERNS = [
  "h.264", "mpeg4", "mpeg-4", "mpeg2", "mpeg1", "mpeg",
  "ogg video", "webm", "matroska", "quicktime", "divx", "cinepack",
  "windows media", "avi", "flash video", "real media", "3gp",
];

/**
 * Formats a browser can stream directly.
 *
 * The distinction matters for the UI: an item whose only video is a 1998
 * RealMedia original is technically "playable" and practically is not, and
 * the module's own player path expects an MP4-family derivative.
 */
const STREAMABLE_FORMAT_PATTERNS = ["h.264", "mpeg4", "mpeg-4", "webm", "ogg video"];

const SUBTITLE_FORMAT_PATTERNS = ["subrip", "webvtt", "closed caption", "scc", "vtt"];

/** One entry from the endpoint's `files` array. Everything arrives as strings. */
export interface ArchiveFileEntry {
  name?: string;
  format?: string;
  source?: string;
  size?: string;
  length?: string;
  width?: string;
  height?: string;
}

export interface ArchiveMetadataResponse {
  metadata?: { runtime?: string; length?: string };
  files?: ArchiveFileEntry[];
}

export interface MediaFacts {
  /** Real duration in seconds, 0 when nothing reported one. */
  duration_sec: number;
  width: number;
  height: number;
  /** Any video file at all, streamable or not. */
  has_video: boolean;
  /** A format the player can actually stream. */
  has_streamable: boolean;
  has_subtitles: boolean;
  video_count: number;
  total_bytes: number;
  /** The format of the file the other numbers were taken from. */
  best_format: string;
}

function matchesAny(format: string, patterns: string[]): boolean {
  const f = format.toLowerCase();
  return patterns.some((p) => f.includes(p));
}

function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Parse a duration that archive.org wrote for humans.
 *
 * Two shapes appear on `metadata.runtime`, both verified live: "1:17:26" and
 * "20:33". A bare number of seconds also turns up. Anything else yields 0
 * rather than a guess.
 */
export function parseRuntime(raw: string | undefined): number {
  if (!raw) return 0;
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) return 0;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p.trim()))) return 0;
  const n = parts.map((p) => Number(p.trim()));
  const [h, m, sec] = n.length === 3 ? n : [0, n[0], n[1]];
  return Math.round(h * 3600 + m * 60 + sec);
}

/**
 * Reduce a metadata response to the facts the catalogue needs.
 *
 * The representative file is the LONGEST video, preferring a streamable one:
 * an item commonly holds a 4-second sample alongside the feature, and the
 * feature is the one whose duration and resolution describe the item.
 */
export function parseMediaFacts(body: ArchiveMetadataResponse): MediaFacts {
  const files = body.files ?? [];

  const videos = files.filter((f) => f.format && matchesAny(f.format, VIDEO_FORMAT_PATTERNS));
  const subtitles = files.filter(
    (f) => (f.format && matchesAny(f.format, SUBTITLE_FORMAT_PATTERNS)) ||
           (f.name ?? "").toLowerCase().endsWith(".srt"),
  );

  let totalBytes = 0;
  for (const f of files) totalBytes += num(f.size);

  // Rank candidates: streamable first, then by duration, then by pixel count.
  // Duration beats resolution because a 4-second 1080p sample is not the film
  // and a 90-minute 640x480 transfer is.
  const ranked = [...videos].sort((a, b) => {
    const aStream = matchesAny(a.format ?? "", STREAMABLE_FORMAT_PATTERNS) ? 1 : 0;
    const bStream = matchesAny(b.format ?? "", STREAMABLE_FORMAT_PATTERNS) ? 1 : 0;
    if (aStream !== bStream) return bStream - aStream;
    const aLen = num(a.length);
    const bLen = num(b.length);
    if (aLen !== bLen) return bLen - aLen;
    return (num(b.width) * num(b.height)) - (num(a.width) * num(a.height));
  });
  const best = ranked[0];

  // Duration from the longest video regardless of which file won on
  // streamability — a streamable derivative is sometimes truncated while the
  // original is complete, and the item's real length is the longer one.
  const longest = videos.reduce((max, f) => Math.max(max, num(f.length)), 0);
  const duration = longest || parseRuntime(body.metadata?.runtime ?? body.metadata?.length);

  return {
    duration_sec: Math.round(duration),
    width: num(best?.width),
    height: num(best?.height),
    has_video: videos.length > 0,
    has_streamable: videos.some((f) => matchesAny(f.format ?? "", STREAMABLE_FORMAT_PATTERNS)),
    has_subtitles: subtitles.length > 0,
    video_count: videos.length,
    total_bytes: totalBytes,
    best_format: best?.format ?? "",
  };
}

/** Fetch and parse one item. Network errors propagate to the caller. */
export async function probeItem(identifier: string): Promise<MediaFacts> {
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(identifier)}`, {
    headers: { "user-agent": "Kernl/cinema-probe" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`archive.org metadata returned ${res.status}`);
  return parseMediaFacts((await res.json()) as ArchiveMetadataResponse);
}

/**
 * Store what a probe found.
 *
 * Written even when the item turned out to hold nothing playable — that IS
 * the finding, and re-probing it on every pass forever would be the bug.
 */
export function recordFacts(db: SqliteDb, identifier: string, facts: MediaFacts): void {
  db.prepare(`
    INSERT INTO cinema_title_media
      (identifier, duration_sec, width, height, has_video, has_streamable,
       has_subtitles, video_count, total_bytes, best_format, probed_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
    ON CONFLICT(identifier) DO UPDATE SET
      duration_sec = excluded.duration_sec,
      width = excluded.width, height = excluded.height,
      has_video = excluded.has_video, has_streamable = excluded.has_streamable,
      has_subtitles = excluded.has_subtitles, video_count = excluded.video_count,
      total_bytes = excluded.total_bytes, best_format = excluded.best_format,
      probed_at = excluded.probed_at, error = ''
  `).run(
    identifier, facts.duration_sec, facts.width, facts.height,
    facts.has_video ? 1 : 0, facts.has_streamable ? 1 : 0,
    facts.has_subtitles ? 1 : 0, facts.video_count, facts.total_bytes,
    facts.best_format, new Date().toISOString(),
  );
}

/**
 * Stamp a failed probe.
 *
 * Recorded so the item leaves the pending set — an identifier that 404s will
 * 404 forever, and a runner that keeps retrying it never reaches the rest of
 * the catalogue. The error is kept so the row can be told apart from a
 * genuine "nothing here".
 */
export function recordProbeError(db: SqliteDb, identifier: string, message: string): void {
  db.prepare(`
    INSERT INTO cinema_title_media (identifier, probed_at, error)
    VALUES (?, ?, ?)
    ON CONFLICT(identifier) DO UPDATE SET
      probed_at = excluded.probed_at, error = excluded.error
  `).run(identifier, new Date().toISOString(), message.slice(0, 240));
}

/** Identifiers never probed. Absence of a row is the pending signal. */
export function pendingProbes(db: SqliteDb, limit: number): string[] {
  const rows = db.prepare(`
    SELECT t.identifier
    FROM cinema_titles t
    LEFT JOIN cinema_title_media m ON m.identifier = t.identifier
    WHERE t.deleted_at IS NULL AND t.hidden = 0 AND m.identifier IS NULL
    ORDER BY t.downloads DESC
    LIMIT ?
  `).all(Math.max(1, limit)) as Array<{ identifier: string }>;
  return rows.map((r) => r.identifier);
}

export function countPendingProbes(db: SqliteDb): number {
  const r = db.prepare(`
    SELECT COUNT(*) AS n
    FROM cinema_titles t
    LEFT JOIN cinema_title_media m ON m.identifier = t.identifier
    WHERE t.deleted_at IS NULL AND t.hidden = 0 AND m.identifier IS NULL
  `).get() as { n: number };
  return r?.n ?? 0;
}
