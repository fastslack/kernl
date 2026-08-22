/**
 * Where the extract bar gets its denominator.
 *
 * `probeUpstreamDuration` runs ffprobe against the upstream with a hard 5s
 * cap so a slow CDN cannot stall the start of a run. On 2026-08-18 the
 * archive.org node serving "Battle of the Worlds" was answering with a 16-18s
 * TTFB at 146 KB/s: the probe timed out every time, `totalSec` came back
 * undefined, and the extract emit fell through its `frac: p.frac ?? 0` to a
 * bar pinned at exactly 0% for the nine and a half minutes the pull took. The
 * run was healthy the whole time — it finished 914 cues — but nothing on
 * screen said so.
 *
 * The duration was never actually unknown: archive.org's metadata carries
 * `length: "5020.04"` for that file and the player already has it in hand
 * from /import-archive/files. So the probe is now the fallback, not the
 * source of truth.
 */

import { describe, it, expect } from "bun:test";
import { resolveExtractDuration } from "../assets/extensions/leisure/cinema/_module/transcribe.js";
import { parseTranscribeRequest } from "../assets/extensions/leisure/cinema/_module/media-routes.js";

// A URL nothing can probe: whatever ffprobe does with it, it fails fast and
// the resolver has only the supplied value to go on.
const UNPROBEABLE = "nonsense://not-a-real-host/x.mp4";

describe("extract-phase duration", () => {
  it("takes the duration the caller already has", async () => {
    expect(await resolveExtractDuration(UNPROBEABLE, 5020.04)).toBe(5020.04);
  });

  it("returns null when there is nothing to go on", async () => {
    expect(await resolveExtractDuration(UNPROBEABLE)).toBeNull();
  });

  it("does not accept a duration that cannot be one", async () => {
    // archive.org leaves `length` off some files and writes "0.00" on others;
    // both must fall through to the probe rather than becoming a denominator
    // that makes every frac Infinity or NaN.
    expect(await resolveExtractDuration(UNPROBEABLE, 0)).toBeNull();
    expect(await resolveExtractDuration(UNPROBEABLE, NaN)).toBeNull();
    expect(await resolveExtractDuration(UNPROBEABLE, -1)).toBeNull();
  });
});

describe("the duration the request carries", () => {
  const REQ = "/api/cinema/media/transcribe?url=https%3A%2F%2Farchive.org%2Fdownload%2Fx%2Fx.mp4&engine=whispercpp&model=base&lang=en";

  function ok(u: string) {
    const p = parseTranscribeRequest(u);
    if (!p.ok) throw new Error(p.error);
    return p;
  }

  it("passes the player's duration through to the run", () => {
    expect(ok(`${REQ}&dur=5020.04`).durationSec).toBe(5020.04);
  });

  it("leaves it unset when the caller sends nothing", () => {
    expect(ok(REQ).durationSec).toBeUndefined();
  });

  it("drops a duration that is not a usable number", () => {
    expect(ok(`${REQ}&dur=`).durationSec).toBeUndefined();
    expect(ok(`${REQ}&dur=0`).durationSec).toBeUndefined();
    expect(ok(`${REQ}&dur=abc`).durationSec).toBeUndefined();
  });

  it("keeps the duration out of the cache key", () => {
    // The VTT is the same file whether or not we knew how long the source
    // was. Folding `dur` in would split the cache and re-run whisper.
    expect(ok(`${REQ}&dur=5020.04`).cacheKey).toBe(ok(REQ).cacheKey);
  });
});
