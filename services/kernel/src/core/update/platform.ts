/**
 * Which release artefact this machine needs, and whether it may replace itself.
 *
 * Pure: takes a platform, an architecture and a path, and returns names and a
 * verdict. No filesystem, no process — so the decisions that differ per
 * operating system can be tested on whichever one happens to be running the
 * suite, which for three target platforms and one CI box is the only way any
 * of them gets tested at all.
 *
 * The one thing purity cannot answer is "is this directory a packaged
 * install?", because on Windows the answer is a file on disk rather than a
 * shape in the path. That comes in as `opts.packaged`, which the caller reads
 * with `existsSync` — the check stays here, the syscall stays out.
 */

export type InstallKind =
  | "macos-app"
  | "windows-msi"
  | "windows-dir"
  | "linux-package"
  | "linux-portable"
  | "unknown";

/** What an install of `kind` is replaced with, and how it is recognised. */
export interface AssetSpec {
  /**
   * The name we expect the release to publish. Used in messages only: the
   * real name comes from the release API, because a name built by hand is a
   * name that can drift from the one that got uploaded — which is exactly
   * what happened (`Kernl-…-windows-x64.zip` against a published
   * `kernl-…-windows-x64.zip`, and a checksum lookup that compared the two
   * as strings).
   */
  expected: string;
  /** Matches the published asset, case-insensitively and anchored. */
  pattern: RegExp;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The artefact that replaces an install of this kind.
 *
 * Keyed on the install kind rather than on the platform, because Windows has
 * two answers and they are not interchangeable. A directory that was unzipped
 * is replaced by the zip; an MSI install is upgraded by the MSI, which owns
 * its registry entry, its uninstaller and its elevation. Swapping the
 * directory under an MSI leaves Add/Remove Programs advertising a version
 * that is no longer on disk.
 *
 * Case is deliberate in `expected` and irrelevant in `pattern`: the release
 * publishes macOS artefacts as `Kernl-*` (APP_NAME) and linux/windows ones as
 * `kernl-*` ($NAME in stage-payload.sh), and both spellings are intentional.
 * Matching is what keeps this code from having to care which is which.
 */
export function assetSpecFor(
  version: string,
  kind: InstallKind,
  arch: string,
): AssetSpec | null {
  const cpu = arch === "arm64" ? "arm64" : "x64";
  const v = escapeForRegex(version);

  switch (kind) {
    case "macos-app":
      return {
        expected: `Kernl-${version}-${cpu}-macos.tar.gz`,
        pattern: new RegExp(`^kernl-${v}-${cpu}-macos\\.tar\\.gz$`, "i"),
      };
    case "windows-msi":
      return {
        expected: `kernl-${version}-windows-${cpu}.msi`,
        pattern: new RegExp(`^kernl-${v}-windows-${cpu}\\.msi$`, "i"),
      };
    case "windows-dir":
      return {
        expected: `kernl-${version}-windows-${cpu}.zip`,
        pattern: new RegExp(`^kernl-${v}-windows-${cpu}\\.zip$`, "i"),
      };
    case "linux-portable":
      return {
        expected: `Kernl-${version}-${cpu}-linux.tar.gz`,
        pattern: new RegExp(`^kernl-${v}-${cpu}-linux\\.tar\\.gz$`, "i"),
      };
    default:
      // linux-package updates through dpkg/rpm, and `unknown` is refused
      // before anything gets downloaded.
      return null;
  }
}

/** Path segments, with Windows separators folded in so one check covers both. */
function segments(path: string): string[] {
  return path.replace(/\\+/g, "/").split("/").filter(Boolean);
}

/**
 * Is this path inside a Program Files root? Then an installer put it there.
 *
 * Used to tell an MSI install from an unzipped one. Not airtight — somebody
 * can unzip into Program Files by hand — but wrong in the safe direction: it
 * routes to msiexec, which refuses cleanly when there is no product to
 * upgrade, whereas the opposite mistake tries to `move` a directory the
 * current process has no permission to touch.
 */
function underProgramFiles(parts: string[]): boolean {
  return parts.some((p) => /^program files( \(x86\))?$/i.test(p));
}

/**
 * How this instance was installed, from the path its own code is running from.
 *
 * Two shapes count as packaged, and the difference is not cosmetic:
 *
 *   · `<root>/bin/` — what stage-payload.sh produces and what the macOS .app
 *     and the Linux tarball ship.
 *   · `<root>/` flat — what Windows ships. `build-zip.sh` and `build-msi.sh`
 *     both copy `bin/mcp-server.js` to the package ROOT, so a Windows install
 *     runs from `C:\Program Files\Kernl`, whose last segment is "Kernl". The
 *     `bin/` rule alone therefore called every Windows install "unknown" and
 *     the updater refused before it downloaded anything — on the one platform
 *     where there is no package manager to fall back to.
 *
 * The flat shape cannot be recognised from the path (a random directory looks
 * identical), so the caller passes `opts.packaged`: true when the packaged
 * entry point sits in this directory. A source checkout and a container both
 * run from `src/…` with no such marker, and must never be swapped — there is
 * no packaged tree there to replace, and replacing a developer's working copy
 * with a release tarball would be the worst possible reading of "update".
 */
export function installKind(
  modulePath: string,
  platform: string,
  opts: { packaged?: boolean } = {},
): InstallKind {
  const parts = segments(modulePath);
  const inBin = parts[parts.length - 1] === "bin";
  const looksPackaged = inBin || opts.packaged === true;

  if (platform === "darwin") {
    return parts.some((p) => p.endsWith(".app")) ? "macos-app" : "unknown";
  }

  if (platform === "win32") {
    if (!looksPackaged) return "unknown";
    return underProgramFiles(parts) ? "windows-msi" : "windows-dir";
  }

  if (platform === "linux") {
    // `/opt` has to be the ROOT of the path, not a directory that happens to
    // be called that inside a home folder. A copy under `/opt/kernl` belongs
    // to dpkg or rpm, and replacing files a package manager believes it owns
    // leaves a machine whose next `apt upgrade` quietly reverts the update.
    if (parts[0] === "opt" && parts[1] === "kernl") return "linux-package";
    return looksPackaged ? "linux-portable" : "unknown";
  }

  return "unknown";
}

/**
 * The directory a swap (or an msiexec upgrade) applies to, given where the
 * running module lives.
 *
 * macOS keeps its own resolver in `apply.ts` — the bundle is `Contents/`'s
 * parent, not `bin/`'s. Everywhere else the root is `bin/`'s parent when the
 * layout has a `bin/`, and the module directory itself when it is flat, which
 * is every Windows install. Returns null when the layout is not one we can
 * place, which the caller must treat as "refuse", never as "guess".
 */
export function installRootFrom(moduleDir: string, kind: InstallKind): string | null {
  if (kind !== "windows-dir" && kind !== "windows-msi" && kind !== "linux-portable") {
    return null;
  }
  const parts = segments(moduleDir);
  const flat = parts[parts.length - 1] !== "bin";

  // A flat layout is only meaningful on Windows; on Linux the packaged tree
  // always has `bin/`, so a flat path there is something else entirely.
  if (flat && kind === "linux-portable") return null;

  const root = flat ? parts : parts.slice(0, -1);
  if (root.length === 0) return null;
  // Preserve the Windows drive letter; rebuild a POSIX path otherwise.
  return /^[a-zA-Z]:$/.test(root[0] ?? "") ? root.join("\\") : `/${root.join("/")}`;
}

/** Can `kind` be replaced by swapping a directory? */
export function isSwappable(kind: InstallKind): boolean {
  return kind === "macos-app" || kind === "windows-dir" || kind === "linux-portable";
}

/** Is `kind` upgraded by handing the installer back to the operating system? */
export function usesInstaller(kind: InstallKind): boolean {
  return kind === "windows-msi";
}

/**
 * The command that starts Kernl again once the swap is done.
 *
 * This was the install root itself, for every platform. On macOS `open` on a
 * bundle is right; everywhere else it named a DIRECTORY, so Windows ran
 * `start "" "C:\Program Files\Kernl"` — which opens Explorer — and Linux tried
 * to execute a directory. An update that reports success and never comes back
 * up is worse than one that refuses.
 *
 * Windows has `start.bat`, which is the documented entry point, what the Start
 * Menu shortcut targets, and the thing that sets up %LOCALAPPDATA% before
 * launching. The Linux tarball has no launcher at all — `packaging/rpm/files/
 * kernl.sh` hardcodes /opt/kernl and ships only in the packages — so the
 * portable relaunch is the bundled runtime against the bundled kernel.
 */
export function relaunchCommandFor(root: string, kind: InstallKind): string[] | null {
  switch (kind) {
    case "macos-app":
      return ["open", root];
    case "windows-dir":
      return [`${root}\\start.bat`];
    case "linux-portable":
      return [`${root}/bin/bun`, `${root}/bin/mcp-server.js`];
    case "windows-msi":
      // An upgrade keeps INSTALLDIR, so the entry point the Start Menu
      // shortcut targets is still the right one. msiexec does not relaunch
      // what it replaced, and an update that ends with nothing running reads
      // as an update that failed.
      return [`${root}\\start.bat`];
    default:
      return null;
  }
}
