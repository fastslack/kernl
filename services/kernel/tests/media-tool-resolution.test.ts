/**
 * Media binaries must be resolved, never named.
 *
 * `mediaToolBin()` is the only thing that knows about the whisper.cpp we ship
 * inside the package: the native builds drop it in `bin/whisper/` beside the
 * bundled entry point, because whisper.cpp is built with GGML_BACKEND_DL and
 * dlopen looks next to the executable rather than down LD_LIBRARY_PATH.
 * Spawning the bare name `whisper-cli` skips that and searches PATH instead —
 * which works in the Docker image (its apt package puts one there) and fails
 * on every macOS, Windows and Linux-binary install, where the user never
 * installed whisper.cpp separately because we shipped it for them.
 *
 * The failure is invisible from the outside: `/media/transcribe/info` probes
 * through `mediaToolBin()` and reports "available", then the run itself
 * spawns a different name and dies with ENOENT. So this guards the call
 * sites, not the resolver — the resolver was always right.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Directories whose spawns reach for ffmpeg / ffprobe / whisper-cli. */
const SCANNED = [
  path.join(HERE, "..", "assets", "extensions", "leisure", "cinema", "_module"),
];

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(dir, f));
}

describe("media tool resolution", () => {
  it("never spawns a media binary by bare name", () => {
    // spawn("ffmpeg", …) / spawn('whisper-cli', …) — a string literal where
    // the resolved path belongs.
    const bareSpawn = /spawn\(\s*["'](ffmpeg|ffprobe|whisper-cli)["']/;
    const offenders: string[] = [];

    for (const dir of SCANNED) {
      for (const file of tsFilesIn(dir)) {
        const src = readFileSync(file, "utf8");
        src.split("\n").forEach((line, i) => {
          if (bareSpawn.test(line)) offenders.push(`${path.basename(file)}:${i + 1}`);
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never resolves a media binary from the environment alone", () => {
    // `process.env.WHISPERCPP_BIN ?? "whisper-cli"` looks like it honours the
    // override — and it does — but it drops the bundled binary on the floor.
    // The override still works: mediaToolBin() checks it first.
    const envOnly = /process\.env\.(FFMPEG_BIN|FFPROBE_BIN|WHISPERCPP_BIN)\s*\?\?/;
    const offenders: string[] = [];

    for (const dir of SCANNED) {
      for (const file of tsFilesIn(dir)) {
        const src = readFileSync(file, "utf8");
        src.split("\n").forEach((line, i) => {
          if (envOnly.test(line)) offenders.push(`${path.basename(file)}:${i + 1}`);
        });
      }
    }

    expect(offenders).toEqual([]);
  });
});
