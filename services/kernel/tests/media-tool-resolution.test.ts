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

import { describe, it, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBundledTool } from "../src/core/media-tools.js";

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

/**
 * The resolver has to find the shipped binary from wherever the calling module
 * ended up, which is NOT where the packagers assumed.
 *
 * `media-tools.ts` is compiled into every bundle that imports it, and cinema —
 * the only caller that transcribes anything — is an extension: its copy lands
 * in `assets/extensions/leisure/cinema/backend/entry.js`, five directories
 * below the payload root. Anchoring on the module's own file therefore looked
 * for `…/cinema/backend/whisper/whisper-cli`, found nothing, and fell back to
 * the bare name on PATH. Every native package shipped a whisper.cpp that was
 * never once invoked; Docker hid it because it sets WHISPERCPP_BIN, which wins
 * before the lookup happens.
 *
 * The layouts below are transcribed from the built artifacts — the macOS one
 * from `Kernl-0.2.3-arm64-macos.tar.gz` as published.
 */
const TMP_ROOTS: string[] = [];
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

/** Build a throwaway tree; `files` are paths relative to the root. */
function layout(files: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "kernl-layout-"));
  TMP_ROOTS.push(root);
  for (const rel of files) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "");
  }
  return root;
}

const CINEMA = "assets/extensions/leisure/cinema/backend";

describe("bundled binary lookup", () => {
  it("finds whisper from the cinema bundle inside a macOS .app", () => {
    // Contents/Resources/{bun,mcp-server.js,whisper/,ffmpeg/,assets/}
    const root = layout([
      "Contents/Resources/bun",
      "Contents/Resources/whisper/whisper-cli",
      `Contents/Resources/${CINEMA}/entry.js`,
    ]);
    const res = path.join(root, "Contents/Resources");

    expect(findBundledTool("whisper", "whisper-cli", [path.join(res, CINEMA)])).toBe(
      path.join(res, "whisper", "whisper-cli"),
    );
  });

  it("finds ffmpeg and ffprobe in their own directory", () => {
    // They ship as one bundle beside whisper's, not mixed into it: separate
    // upstreams, separate licences, separate release cadence.
    const root = layout([
      "Contents/Resources/bun",
      "Contents/Resources/ffmpeg/ffmpeg",
      "Contents/Resources/ffmpeg/ffprobe",
      "Contents/Resources/whisper/whisper-cli",
      `Contents/Resources/${CINEMA}/entry.js`,
    ]);
    const res = path.join(root, "Contents/Resources");
    const from = [path.join(res, CINEMA)];

    expect(findBundledTool("ffmpeg", "ffmpeg", from)).toBe(path.join(res, "ffmpeg", "ffmpeg"));
    expect(findBundledTool("ffmpeg", "ffprobe", from)).toBe(path.join(res, "ffmpeg", "ffprobe"));
  });

  it("finds it from the cinema bundle in a deb/rpm install", () => {
    // /opt/kernl/bin/whisper beside the runtime, assets one level up.
    const root = layout([
      "opt/kernl/bin/bun",
      "opt/kernl/bin/whisper/whisper-cli",
      `opt/kernl/${CINEMA}/entry.js`,
    ]);
    const prefix = path.join(root, "opt/kernl");

    expect(findBundledTool("whisper", "whisper-cli", [path.join(prefix, CINEMA)])).toBe(
      path.join(prefix, "bin", "whisper", "whisper-cli"),
    );
  });

  it("finds it from the zip root on Windows", () => {
    const root = layout([
      "bun.exe",
      "whisper/whisper-cli.exe",
      "ffmpeg/ffmpeg.exe",
      `${CINEMA}/entry.js`,
    ]);
    const from = [path.join(root, CINEMA)];

    expect(findBundledTool("whisper", "whisper-cli.exe", from)).toBe(
      path.join(root, "whisper", "whisper-cli.exe"),
    );
    expect(findBundledTool("ffmpeg", "ffmpeg.exe", from)).toBe(
      path.join(root, "ffmpeg", "ffmpeg.exe"),
    );
  });

  it("still finds it beside the kernel entry point", () => {
    // The layout the old anchor assumed. It has to keep working: doctor and
    // the /info routes are compiled into mcp-server.js, not into an extension.
    const root = layout(["bin/mcp-server.js", "bin/whisper/whisper-cli"]);

    expect(findBundledTool("whisper", "whisper-cli", [path.join(root, "bin")])).toBe(
      path.join(root, "bin", "whisper", "whisper-cli"),
    );
  });

  it("returns null when nothing was shipped, so PATH still wins", () => {
    // The linux packages deliberately ship no ffmpeg — the distro provides it.
    const root = layout([`${CINEMA}/entry.js`]);
    const from = [path.join(root, CINEMA)];

    expect(findBundledTool("whisper", "whisper-cli", from)).toBeNull();
    expect(findBundledTool("ffmpeg", "ffmpeg", from)).toBeNull();
  });

  it("does not escape the payload looking for a match", () => {
    // A `whisper/whisper-cli` far above the tree — someone's home directory,
    // /tmp, / — is not ours and must not be adopted. The walk is bounded to
    // the depth an extension bundle actually sits at.
    const root = layout([
      "whisper/whisper-cli",
      `deep/er/still/deeper/and/again/${CINEMA}/entry.js`,
    ]);

    expect(
      findBundledTool("whisper", "whisper-cli", [
        path.join(root, "deep/er/still/deeper/and/again", CINEMA),
      ]),
    ).toBeNull();
  });
});
