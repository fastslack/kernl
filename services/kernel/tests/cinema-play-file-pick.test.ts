/**
 * Which file of an archive.org item the player should open.
 *
 * The rule that used to decide this — first `.mp4`, biggest first — has a
 * failure mode that looks nothing like a file-picking bug from the outside.
 * An item routinely carries several .mp4s and only some hold h264; the
 * biggest is the uploader's original, which on old films is very often
 * MPEG-4 Part 2. No browser decodes that, so the player fell back to a live
 * transcode of a 200 MB source pulled over seek-heavy HTTPS — which cannot
 * keep up, and shows as a converting spinner that never finishes. The h264
 * derivative was sitting in the same list the whole time.
 *
 * The fixture is the real payload for `AboutBan1935` ("About Bananas", 1935),
 * with the codecs verified by ffprobe rather than taken from the labels:
 * `512Kb MPEG4` is h264 despite its name, `HiRes MPEG4` genuinely is not.
 */

import { describe, it, expect } from "bun:test";

// ── The logic under test, mirrored from Page.svelte ──────────────────────
// The player is a Svelte component the kernel's test runner cannot mount, so
// the decision function is duplicated here. Keep the two in step: if this
// starts disagreeing with the component, the component is what ships.

const TRANSCODABLE = ["mpg", "mpeg", "m2v", "avi", "wmv", "flv", "rm", "rmvb", "asf", "vob"];

const BROWSER_FORMAT_RANK: Array<{ test: RegExp; rank: number }> = [
  { test: /^h\.?\s*264/i, rank: 0 },
  { test: /^512kb\s+mpeg4$/i, rank: 1 },
  { test: /^webm/i, rank: 2 },
  { test: /^ogg\s+video$/i, rank: 3 },
];
const OPAQUE_FORMAT =
  /^(hi\s*res\s+mpeg4|mpeg\s*-?\s*[12]|cinepack|cinepak|windows\s+media|quicktime|divx|xvid|asf|matroska|3gp)/i;

interface PlayFile { name: string; size: number; format: string; length: string; kind: string }

function formatRank(format: string): number {
  const f = (format ?? "").trim();
  for (const { test, rank } of BROWSER_FORMAT_RANK) if (test.test(f)) return rank;
  if (OPAQUE_FORMAT.test(f)) return 90;
  return 50;
}

function needsTranscodeFor(file: PlayFile | undefined): boolean {
  if (!file) return false;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (TRANSCODABLE.includes(ext)) return true;
  return OPAQUE_FORMAT.test((file.format ?? "").trim());
}

function pickDefaultPlayIdx(files: PlayFile[]): number {
  const videos = files.map((f, idx) => ({ f, idx })).filter((e) => e.f.kind === "video");
  if (videos.length > 0) {
    const best = videos.slice().sort((a, b) => {
      const ra = formatRank(a.f.format);
      const rb = formatRank(b.f.format);
      if (ra !== rb) return ra - rb;
      return (b.f.size ?? 0) - (a.f.size ?? 0);
    })[0];
    if (best && formatRank(best.f.format) < 90) return best.idx;
  }
  const order = ["mp4", "webm", "mov", "m4v", "mkv", "ogv", "mpg", "mpeg", "avi", "m2v", "mp3", "flac", "ogg", "opus"];
  for (const ext of order) {
    const idx = files.findIndex((f) => f.name.toLowerCase().endsWith("." + ext));
    if (idx >= 0) return idx;
  }
  return 0;
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function v(name: string, size: number, format: string): PlayFile {
  return { name, size, format, length: "664", kind: "video" };
}

/** Real payload, already sorted the way the player sorts it: biggest first. */
const ABOUT_BANANAS: PlayFile[] = [
  v("AboutBan1935.mpeg", 306617225, "MPEG2"),
  v("AboutBan1935_edit.mp4", 210901733, "HiRes MPEG4"),
  v("AboutBan1935.mp4", 68512128, "h.264"),
  v("AboutBan1935.ogv", 46417991, "Ogg Video"),
  v("AboutBan1935_512kb.mp4", 45499819, "512Kb MPEG4"),
  v("AboutBan1935.avi", 38496262, "Cinepack"),
];

describe("picking the file to play", () => {
  it("takes the h264 derivative over the bigger original", () => {
    const idx = pickDefaultPlayIdx(ABOUT_BANANAS);
    expect(ABOUT_BANANAS[idx]!.name).toBe("AboutBan1935.mp4");
  });

  it("does not send the chosen file to the transcoder", () => {
    const chosen = ABOUT_BANANAS[pickDefaultPlayIdx(ABOUT_BANANAS)];
    expect(needsTranscodeFor(chosen)).toBe(false);
  });

  it("knows the file it used to pick needs transcoding", () => {
    const old = ABOUT_BANANAS.find((f) => f.name === "AboutBan1935_edit.mp4")!;
    expect(needsTranscodeFor(old)).toBe(true);
  });

  it("trusts the codec, not the label, for 512Kb MPEG4", () => {
    // Named MPEG4, verified h264. A loose /mpeg4/ rule would reject it and
    // leave items whose only decodable file is this one unplayable.
    const small = ABOUT_BANANAS.find((f) => f.name === "AboutBan1935_512kb.mp4")!;
    expect(needsTranscodeFor(small)).toBe(false);
    expect(formatRank(small.format)).toBeLessThan(90);
  });

  it("prefers the larger h264 when an item ships two", () => {
    const both = [
      v("x_512kb.mp4", 45_000_000, "512Kb MPEG4"),
      v("x.mp4", 68_000_000, "h.264"),
    ];
    expect(both[pickDefaultPlayIdx(both)]!.name).toBe("x.mp4");
  });

  it("falls back to the old order when every file is opaque", () => {
    const opaque = [
      v("only.mpeg", 300_000_000, "MPEG2"),
      v("only.avi", 38_000_000, "Cinepack"),
    ];
    const chosen = opaque[pickDefaultPlayIdx(opaque)]!;
    // Nothing decodable — pick something and let the transcoder handle it,
    // rather than refusing to play at all.
    expect(needsTranscodeFor(chosen)).toBe(true);
    expect(["only.mpeg", "only.avi"]).toContain(chosen.name);
  });

  it("still picks something when the format field is empty", () => {
    // Older items, and anything the metadata API is vague about.
    const unknown = [v("a.mkv", 10, ""), v("b.mp4", 20, "")];
    expect(unknown[pickDefaultPlayIdx(unknown)]!.name).toBe("b.mp4");
  });
});

// ── Shipped subtitle files ───────────────────────────────────────────────

const MIN_SUB_BYTES = 32;

function hasSubtitleContent(f: { size: number }): boolean {
  return (f.size ?? 0) >= MIN_SUB_BYTES;
}

function detectShippedSubs(files: Array<{ name: string; size: number }>): string[] {
  return files
    .filter((f) => /\.(srt|vtt|ass|ssa|sub)$/i.test(f.name))
    .filter(hasSubtitleContent)
    .map((f) => f.name);
}

/** The OTHER finder — the reactive track URL uses this one. */
function findSrtFile(files: Array<{ name: string; size: number }>): string | null {
  return files.find((f) => /\.srt$/i.test(f.name) && hasSubtitleContent(f))?.name ?? null;
}

describe("shipped subtitles", () => {
  it("ignores the zero-byte subtitle archive.org lists anyway", () => {
    // Real entry: About Bananas ships `AboutBan1935.asr.srt` at size 0, its
    // speech-recognition pass having produced nothing. Offering it made the
    // player fetch an empty file and report a failure over a film that was
    // playing fine.
    const files = [{ name: "AboutBan1935.asr.srt", size: 0 }];
    expect(detectShippedSubs(files)).toEqual([]);
  });

  it("keeps a subtitle that actually has cues in it", () => {
    const files = [{ name: "movie.en.srt", size: 48_000 }];
    expect(detectShippedSubs(files)).toEqual(["movie.en.srt"]);
  });

  it("rejects a stub too small to hold one cue", () => {
    // A single well-formed SRT cue runs about 40 bytes; below the floor the
    // file is a placeholder, and parsing it just fails later and louder.
    expect(detectShippedSubs([{ name: "x.srt", size: 12 }])).toEqual([]);
  });
});

describe("both subtitle finders agree", () => {
  // Fixing only `detectShippedSubs` left `findSrtFile` still handing the same
  // empty file to the reactive track URL, so the error came back unchanged
  // through a different call site. Whatever one rejects, the other must too.
  const EMPTY = [{ name: "AboutBan1935.asr.srt", size: 0 }];
  const REAL = [{ name: "movie.srt", size: 48_000 }];

  it("both reject the empty one", () => {
    expect(detectShippedSubs(EMPTY)).toEqual([]);
    expect(findSrtFile(EMPTY)).toBeNull();
  });

  it("both accept the real one", () => {
    expect(detectShippedSubs(REAL)).toEqual(["movie.srt"]);
    expect(findSrtFile(REAL)).toBe("movie.srt");
  });
});
