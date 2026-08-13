/**
 * Reading what an archive.org item actually contains.
 *
 * The fixtures below are trimmed from live responses, so the field shapes are
 * the real ones: every value arrives as a string, `length` is decimal seconds
 * on files but "1:17:26" on `metadata.runtime`, and an item can carry a
 * torrent and six files without holding a single frame of video.
 */

import { describe, it, expect } from "bun:test";
import {
  parseMediaFacts,
  parseRuntime,
  type ArchiveMetadataResponse,
} from "../assets/extensions/leisure/cinema/_module/archive-files.js";

/** Trimmed from https://archive.org/metadata/sex_madness. */
const REAL_FEATURE: ArchiveMetadataResponse = {
  metadata: {},
  files: [
    { name: "sex_madness.mp4", source: "derivative", format: "h.264", size: "324928028",
      length: "3117.52", height: "480", width: "640" },
    { name: "sex_madness.mpeg", source: "original", format: "MPEG2", size: "900000000",
      length: "3117.52", height: "480", width: "640" },
    { name: "sex_madness.ogv", source: "derivative", format: "Ogg Video", size: "100000000",
      length: "3117.52", height: "360", width: "480" },
    { name: "sex_madness.asr.srt", source: "derivative", format: "SubRip", size: "40000" },
    { name: "sex_madness_archive.torrent", source: "metadata", format: "Archive BitTorrent" },
    { name: "__ia_thumb.jpg", source: "original", format: "Item Tile", size: "9000" },
  ],
};

/**
 * Trimmed from https://archive.org/metadata/HisNewJobCharlesChaplin-1915.
 *
 * The case that motivates the whole probe: high in `feature_films` by
 * downloads, carries a torrent, holds no video whatsoever.
 */
const NO_MEDIA: ArchiveMetadataResponse = {
  metadata: { runtime: "20:33" },
  files: [
    { name: "x_archive.torrent", source: "metadata", format: "Archive BitTorrent" },
    { name: "x_files.xml", source: "original", format: "Metadata" },
    { name: "x_meta.sqlite", source: "original", format: "Metadata" },
    { name: "__ia_thumb.jpg", source: "original", format: "Item Tile", size: "9000" },
  ],
};

describe("parseRuntime", () => {
  it("reads the two shapes archive.org actually writes", () => {
    expect(parseRuntime("1:17:26")).toBe(4646);
    expect(parseRuntime("20:33")).toBe(1233);
  });

  it("accepts bare seconds", () => {
    expect(parseRuntime("3117")).toBe(3117);
    expect(parseRuntime("3117.52")).toBe(3118);
  });

  it("refuses to guess at anything else", () => {
    expect(parseRuntime("about an hour")).toBe(0);
    expect(parseRuntime("1:2:3:4")).toBe(0);
    expect(parseRuntime(undefined)).toBe(0);
    expect(parseRuntime("")).toBe(0);
  });
});

describe("parseMediaFacts", () => {
  it("reads duration, resolution and subtitles off a real feature", () => {
    const f = parseMediaFacts(REAL_FEATURE);
    expect(f.duration_sec).toBe(3118);
    expect(f.width).toBe(640);
    expect(f.height).toBe(480);
    expect(f.has_video).toBe(true);
    expect(f.has_streamable).toBe(true);
    expect(f.has_subtitles).toBe(true);
    expect(f.best_format).toBe("h.264");
  });

  it("counts only the video files", () => {
    // mp4 + mpeg + ogv, not the srt, torrent or thumbnail.
    expect(parseMediaFacts(REAL_FEATURE).video_count).toBe(3);
  });

  it("sums the bytes of everything in the item", () => {
    expect(parseMediaFacts(REAL_FEATURE).total_bytes).toBe(324928028 + 900000000 + 100000000 + 40000 + 9000);
  });

  it("sees that a torrent-carrying item holds no video", () => {
    // The catalogue's has_torrent flag says this is playable. It is not.
    const f = parseMediaFacts(NO_MEDIA);
    expect(f.has_video).toBe(false);
    expect(f.has_streamable).toBe(false);
    expect(f.video_count).toBe(0);
  });

  it("still reports the stated runtime when there are no files to measure", () => {
    expect(parseMediaFacts(NO_MEDIA).duration_sec).toBe(1233);
  });

  it("prefers a streamable format over a bigger unplayable original", () => {
    const f = parseMediaFacts({
      files: [
        { name: "a.rm", format: "Real Media", length: "3000", width: "1920", height: "1080" },
        { name: "a.mp4", format: "h.264", length: "3000", width: "640", height: "480" },
      ],
    });
    expect(f.best_format).toBe("h.264");
    expect(f.height).toBe(480);
  });

  it("describes the feature, not the four-second sample beside it", () => {
    const f = parseMediaFacts({
      files: [
        { name: "sample.mp4", format: "h.264", length: "4", width: "1920", height: "1080" },
        { name: "feature.mp4", format: "h.264", length: "5400", width: "640", height: "480" },
      ],
    });
    expect(f.duration_sec).toBe(5400);
    expect(f.height).toBe(480);
  });

  it("takes the duration from the longest video even when a shorter one streams", () => {
    // A truncated derivative must not shorten the item's real length.
    const f = parseMediaFacts({
      files: [
        { name: "clip.mp4", format: "h.264", length: "600" },
        { name: "full.mpeg", format: "MPEG2", length: "5400" },
      ],
    });
    expect(f.duration_sec).toBe(5400);
    expect(f.has_streamable).toBe(true);
  });

  it("recognises an unplayable-but-real video", () => {
    const f = parseMediaFacts({
      files: [{ name: "old.rm", format: "Real Media", length: "3000" }],
    });
    expect(f.has_video).toBe(true);
    expect(f.has_streamable).toBe(false);
  });

  it("finds a .srt even when the format string does not say so", () => {
    const f = parseMediaFacts({
      files: [
        { name: "movie.mp4", format: "h.264", length: "3000" },
        { name: "movie.srt", format: "Unknown" },
      ],
    });
    expect(f.has_subtitles).toBe(true);
  });

  it("survives an empty or malformed item", () => {
    expect(parseMediaFacts({}).has_video).toBe(false);
    expect(parseMediaFacts({ files: [] }).duration_sec).toBe(0);
    expect(parseMediaFacts({ files: [{ name: "x" }] }).has_video).toBe(false);
  });
});
