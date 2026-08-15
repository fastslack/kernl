/**
 * External media binaries — detection and honest error messages.
 *
 * Cinema, TV and Torrents all shell out to the same three programs. whisper.cpp
 * we build and ship ourselves (see .github/workflows/whisper-binaries.yml);
 * ffmpeg and ffprobe we do not, so outside Docker — which apt-installs them —
 * they are whatever the user happens to have on PATH. On macOS that PATH is
 * narrower than it looks: a .app launched from Finder gets launchd's
 * `/usr/bin:/bin:/usr/sbin:/sbin` and never sees Homebrew, which is why the
 * wrapper in packaging/macos/build-app.sh appends the two brew prefixes.
 *
 * Before this module the failure mode was a spawn ENOENT surfacing as
 * `Error: spawn ffmpeg ENOENT` in a toast — technically accurate and useless.
 * Everything here exists to turn that into a sentence that says which program
 * is missing and the exact command that installs it on the machine reading it.
 *
 * Availability is probed by running the binary, not by looking at PATH: a
 * `ffmpeg` that exists but is a broken symlink or the wrong architecture (an
 * x64 Homebrew install under an arm64 runtime) passes a PATH check and fails
 * at spawn, which is precisely the case worth catching.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Whether we are inside a container. `/.dockerenv` is written by the Docker
 * runtime itself, so it needs no cooperation from the image or the compose
 * file — there is no KERNEL_IN_DOCKER variable to forget to set.
 */
const IN_CONTAINER = existsSync("/.dockerenv");

export type MediaTool = "ffmpeg" | "ffprobe" | "whisper-cli";

interface ToolSpec {
  /** Environment variable that overrides the binary name/path. */
  envVar: string;
  /** Default binary name, looked up on PATH. */
  defaultBin: string;
  /** Argument that makes it print a version and exit 0. */
  versionArg: string;
  /** What stops working without it, in one clause. */
  usedFor: string;
  /** Package name per platform installer. */
  packages: { brew: string; apt: string; winget: string };
}

const SPECS: Record<MediaTool, ToolSpec> = {
  ffmpeg: {
    envVar: "FFMPEG_BIN",
    defaultBin: "ffmpeg",
    versionArg: "-version",
    usedFor: "transcoding playback and extracting audio for subtitles",
    packages: { brew: "ffmpeg", apt: "ffmpeg", winget: "Gyan.FFmpeg" },
  },
  ffprobe: {
    envVar: "FFPROBE_BIN",
    defaultBin: "ffprobe",
    versionArg: "-version",
    usedFor: "reading the real duration of a remote file",
    // Ships inside the ffmpeg package everywhere — naming it separately would
    // send someone hunting for a package that does not exist.
    packages: { brew: "ffmpeg", apt: "ffmpeg", winget: "Gyan.FFmpeg" },
  },
  "whisper-cli": {
    envVar: "WHISPERCPP_BIN",
    defaultBin: "whisper-cli",
    versionArg: "--help",
    usedFor: "generating subtitles offline with whisper.cpp",
    packages: { brew: "whisper-cpp", apt: "whisper.cpp", winget: "" },
  },
};

/**
 * Directory each shipped bundle lives in, relative to whichever tree carries
 * it. Two bundles, not one: separate upstreams, separate licences (ours is
 * MIT-ish, ffmpeg's is GPL) and separate release cadences, so they are built
 * and tagged independently.
 *
 * whisper's is flat on purpose: it is built with GGML_BACKEND_DL, which
 * dlopens each GPU backend, and dlopen looks beside the executable rather than
 * down LD_LIBRARY_PATH; separating the libraries into a lib/ makes it abort
 * with `GGML_ASSERT(device) failed`.
 *
 * `ffmpeg` is null on Linux at runtime as well as at build time — the packages
 * do not ship one there because every distro does (see stage-payload.sh) — and
 * a missing directory simply resolves to null and falls through to PATH.
 */
const BUNDLE_DIR: Record<MediaTool, string> = {
  ffmpeg: "ffmpeg",
  ffprobe: "ffmpeg",
  "whisper-cli": "whisper",
};

/**
 * How far above an origin the payload root can be.
 *
 * `assets/extensions/<a>/<b>/<c>/backend` is the deepest an extension bundle
 * can sit — seed-builtin walks three levels below `assets/extensions` — which
 * is six. Seven leaves one to spare and still stops well short of a user's
 * home directory, which is the point: a stray `whisper/whisper-cli` in $HOME
 * or / is not ours to adopt.
 */
const MAX_CLIMB = 7;

/**
 * Locate a binary we shipped ourselves, starting from `origins` and walking up.
 *
 * The native packagers end up with two shapes, not one: deb and rpm copy `bin/`
 * wholesale to /opt/kernl/bin so the tools sit at `<root>/bin/whisper`, while
 * the macOS packager flattens into Contents/Resources and the Windows one into
 * the zip root, putting them at `<root>/whisper`. Both are probed at every
 * level, which is cheaper than a per-platform table and does not go stale when
 * a packager moves something.
 *
 * Anchoring on this module's own file — what this used to do — is wrong for the
 * caller that matters. `media-tools.ts` is compiled into every bundle that
 * imports it, and the only code that transcribes anything is cinema, an
 * extension: its copy lands in `assets/extensions/leisure/cinema/backend/`,
 * five directories below the payload root, and the lookup landed on
 * `…/cinema/backend/whisper/whisper-cli`. So every native package shipped a
 * whisper.cpp that was never once invoked, and fell back to the bare name on
 * PATH — which nobody has, because we shipped it for them. Docker was immune
 * and hid it: it sets WHISPERCPP_BIN, and the override is checked first.
 *
 * Exported for the tests, which drive it with the layouts of the actual built
 * artifacts rather than the ones the packagers were believed to produce.
 *
 * Returns null when there is no bundle — running from source, or a package
 * built before the whisper asset existed. Both fall back to PATH.
 */
export function findBundledTool(
  bundle: string,
  exe: string,
  origins: string[] = searchOrigins(),
): string | null {
  for (const origin of origins) {
    let dir = path.resolve(origin);
    for (let climbed = 0; climbed <= MAX_CLIMB; climbed++) {
      for (const base of [dir, path.join(dir, "bin")]) {
        const candidate = path.join(base, bundle, exe);
        if (existsSync(candidate)) return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * Where to start looking.
 *
 * `process.execPath` first, and it is the one that actually does the work: it
 * is the bun we vendored, and every packager puts it in the payload root
 * (Contents/Resources/bun, /opt/kernl/bin/bun, <zip>/bun.exe) — so the tools
 * are one directory away, no climbing. This module's own location comes second
 * as the general case, for a build layout nobody has thought of yet.
 */
function searchOrigins(): string[] {
  const out: string[] = [];
  try {
    out.push(path.dirname(process.execPath));
  } catch {
    /* execPath is always set in practice; not worth failing over if it is not */
  }
  try {
    out.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* no import.meta in some bundling modes */
  }
  return out;
}

/** Memoized so a per-spawn call does not restat the tree every time. */
const bundledCache = new Map<MediaTool, string | null>();

function bundledToolPath(tool: MediaTool): string | null {
  const hit = bundledCache.get(tool);
  if (hit !== undefined) return hit;
  const exe = process.platform === "win32" ? `${tool}.exe` : tool;
  let found: string | null;
  try {
    found = findBundledTool(BUNDLE_DIR[tool], exe);
  } catch {
    found = null;
  }
  bundledCache.set(tool, found);
  return found;
}

/**
 * Resolved binary for a tool.
 *
 * Order matters: an explicit env override wins, then whatever we shipped,
 * then PATH. The override staying on top is what lets someone who built their
 * own whisper — with CUDA, say, which we deliberately do not ship — point at
 * it without unpacking ours.
 */
export function mediaToolBin(tool: MediaTool): string {
  const spec = SPECS[tool];
  const override = process.env[spec.envVar]?.trim();
  if (override) return override;
  return bundledToolPath(tool) ?? spec.defaultBin;
}

/**
 * The install command for the host this is running on.
 *
 * Docker gets its own line: inside the container the answer is never "run brew",
 * it is "your image is missing a package it should have had", which is a bug
 * report rather than a user action.
 */
export function installHint(tool: MediaTool): string {
  const spec = SPECS[tool];
  if (IN_CONTAINER) {
    return `The container image should already carry ${spec.packages.apt} — please report this.`;
  }
  switch (process.platform) {
    case "darwin":
      return `Install it with:  brew install ${spec.packages.brew}`;
    case "win32":
      return spec.packages.winget
        ? `Install it with:  winget install ${spec.packages.winget}`
        : `Install ${spec.defaultBin} and put it on your PATH, or set ${spec.envVar} to its full path.`;
    default:
      return `Install it with:  sudo apt install ${spec.packages.apt}   (or your distro's equivalent)`;
  }
}

export interface MediaToolStatus {
  tool: MediaTool;
  /** Binary actually looked for, after the env override. */
  bin: string;
  available: boolean;
  /** First line of its version output, when available. */
  version?: string;
  /** Why it is unavailable, when it is not. */
  reason?: string;
  /** What breaks without it. */
  usedFor: string;
  /** How to install it on this host. */
  hint: string;
}

// Probing spawns a process, and the /media/*/info endpoints are polled by the
// player while it is open. Cached for a minute: long enough that polling is
// free, short enough that installing ffmpeg mid-session is noticed without a
// restart.
const CACHE_TTL_MS = 60_000;
const cache = new Map<MediaTool, { at: number; status: MediaToolStatus }>();

/** Probe one tool. Never throws. */
export async function probeMediaTool(
  tool: MediaTool,
  opts: { fresh?: boolean } = {},
): Promise<MediaToolStatus> {
  const now = Date.now();
  if (!opts.fresh) {
    const hit = cache.get(tool);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.status;
  }

  const spec = SPECS[tool];
  const bin = mediaToolBin(tool);
  const base = { tool, bin, usedFor: spec.usedFor, hint: installHint(tool) };

  let status: MediaToolStatus;
  try {
    const { stdout, stderr } = await execFileAsync(bin, [spec.versionArg], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    // whisper.cpp prints its usage banner to stderr and exits 0; ffmpeg prints
    // its version to stdout. Take whichever produced something.
    const firstLine = (stdout || stderr).split("\n")[0]?.trim();
    status = { ...base, available: true, version: firstLine || undefined };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    // A non-zero exit still proves the binary exists and runs. whisper-cli
    // returns 1 for `--help` on some builds, and treating that as "missing"
    // would tell users to install something they already have.
    if (e.code !== "ENOENT" && (e.stdout || e.stderr)) {
      const firstLine = (e.stdout || e.stderr || "").split("\n")[0]?.trim();
      status = { ...base, available: true, version: firstLine || undefined };
    } else {
      status = {
        ...base,
        available: false,
        reason: e.code === "ENOENT" ? `${bin} is not on PATH` : String(e.message ?? e),
      };
    }
  }

  cache.set(tool, { at: now, status });
  return status;
}

/** Probe every tool at once. Used by the doctor and the /info endpoints. */
export async function probeMediaTools(
  opts: { fresh?: boolean } = {},
): Promise<MediaToolStatus[]> {
  return Promise.all(
    (Object.keys(SPECS) as MediaTool[]).map((t) => probeMediaTool(t, opts)),
  );
}

/**
 * Turn a spawn failure into something a user can act on.
 *
 * Pass the original error so a genuine crash (permission denied, bad
 * architecture) keeps its cause instead of being reported as "not installed".
 */
export function mediaToolError(tool: MediaTool, cause?: unknown): Error {
  const spec = SPECS[tool];
  const bin = mediaToolBin(tool);
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;

  if (cause && code !== "ENOENT") {
    return new Error(
      `${bin} failed to start: ${(cause as Error).message}. ` +
        `Kernl needs it for ${spec.usedFor}. ${installHint(tool)}`,
    );
  }
  return new Error(
    `${bin} is not installed. Kernl needs it for ${spec.usedFor}. ` +
      `${installHint(tool)}` +
      (process.env[spec.envVar]
        ? ` (${spec.envVar} is set to "${process.env[spec.envVar]}" — check that path.)`
        : ` Already installed somewhere else? Set ${spec.envVar} to its full path.`),
  );
}

/** Clear the probe cache. Tests, and the doctor's --fresh path. */
export function resetMediaToolCache(): void {
  cache.clear();
  bundledCache.clear();
}
