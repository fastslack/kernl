/**
 * Which release artefact this machine needs, and whether it may replace itself.
 *
 * Pure: takes a platform, an architecture and a path, and returns names and a
 * verdict. No filesystem, no process — so the decisions that differ per
 * operating system can be tested on whichever one happens to be running the
 * suite, which for three target platforms and one CI box is the only way any
 * of them gets tested at all.
 *
 * What purity cannot answer — is there a packaged entry point in this
 * directory, what does the registry say, are we in a container — comes in as
 * options that install.ts fills in. The check stays here, the syscall stays
 * out.
 */

export type InstallKind =
  | "macos-app"
  | "windows-msi"
  | "windows-dir"
  | "linux-package"
  | "linux-portable"
  | "docker"
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
 *
 * A package install is not here: which package it needs depends on whether
 * dpkg or rpm owns it, see `packageAssetSpec`.
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
      // linux-package picks its package by format, and docker/unknown are
      // refused before anything gets downloaded.
      return null;
  }
}

export type PackageFormat = "rpm" | "deb";

/**
 * The .rpm or .deb that upgrades a package install.
 *
 * The release number after the version (`-1`) is the packager's, not ours, so
 * it is matched rather than assumed: install.sh broke on exactly that when it
 * built `kernl-0.2.0.rpm` for a release that published `kernl-0.2.0-1.x86_64.rpm`.
 * Only x86_64 is published.
 */
export function packageAssetSpec(version: string, format: PackageFormat, arch: string): AssetSpec | null {
  if (arch !== "x64") return null;
  const v = escapeForRegex(version);
  return format === "rpm"
    ? {
        expected: `kernl-${version}-1.x86_64.rpm`,
        pattern: new RegExp(`^kernl-${v}-\\d+\\.x86_64\\.rpm$`, "i"),
      }
    : {
        expected: `kernl_${version}-1_amd64.deb`,
        pattern: new RegExp(`^kernl_${v}-\\d+_amd64\\.deb$`, "i"),
      };
}

/** Path segments, with Windows separators folded in so one check covers both. */
function segments(path: string): string[] {
  return path.replace(/\\+/g, "/").split("/").filter(Boolean);
}

/** Rebuild a path from segments, keeping a Windows drive letter. */
function joinSegments(parts: string[]): string {
  return /^[a-zA-Z]:$/.test(parts[0] ?? "") ? parts.join("\\") : `/${parts.join("/")}`;
}

/** Is this path inside a Program Files root? Then an installer put it there. */
function underProgramFiles(parts: string[]): boolean {
  return parts.some((p) => /^program files( \(x86\))?$/i.test(p));
}

/** Same directory on Windows: case and trailing separators do not count. */
function sameWindowsDir(a: string, b: string): boolean {
  return segments(a).join("/").toLowerCase() === segments(b).join("/").toLowerCase();
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
 * entry point sits in this directory. A source checkout runs from `src/…`
 * with no such marker, and must never be swapped — replacing a developer's
 * working copy with a release tarball would be the worst possible reading of
 * "update". A container is its own answer: the image is rebuilt, not patched.
 */
export function installKind(
  modulePath: string,
  platform: string,
  opts: {
    packaged?: boolean;
    /** Any Kernl marker in the registry (HKLM or HKCU) — see install.ts. */
    installerRegistered?: boolean;
    /** INSTALLDIR as the MSI recorded it under HKLM, when it did. */
    msiInstallDir?: string | null;
    container?: boolean;
  } = {},
): InstallKind {
  if (opts.container) return "docker";

  const parts = segments(modulePath);
  const inBin = parts[parts.length - 1] === "bin";
  const looksPackaged = inBin || opts.packaged === true;

  if (platform === "darwin") {
    return parts.some((p) => p.endsWith(".app")) ? "macos-app" : "unknown";
  }

  if (platform === "win32") {
    if (!looksPackaged) return "unknown";
    const root = inBin ? parts.slice(0, -1) : parts;
    // The machine-wide mark names the directory the MSI installed into, which
    // answers the question exactly: this copy is the MSI's, or it is not.
    if (opts.msiInstallDir) {
      if (sameWindowsDir(joinSegments(root), opts.msiInstallDir)) return "windows-msi";
    } else if (opts.installerRegistered === true) {
      // An older MSI only wrote a per-user mark, with no directory in it.
      // INSTALLDIR is user-overridable, so trust the mark wherever this is.
      return "windows-msi";
    }
    // Under Program Files an installer put it there, whatever the registry
    // said to THIS account. The per-user mark only ever existed for the user
    // who ran the installer, so reading "no mark" as "unzipped copy" sent
    // every other account on the machine down the swap path: 300 MB to %TEMP%,
    // a `move` Program Files refuses, and a kernel that had already exited.
    return underProgramFiles(parts) ? "windows-msi" : "windows-dir";
  }

  if (platform === "linux") {
    // `/opt` has to be the ROOT of the path, not a directory that happens to
    // be called that inside a home folder. A copy under `/opt/kernl` belongs
    // to dpkg or rpm.
    if (parts[0] === "opt" && parts[1] === "kernl") return "linux-package";
    return looksPackaged ? "linux-portable" : "unknown";
  }

  return "unknown";
}

/**
 * The .app a module running inside it belongs to.
 *
 * The packaged server sits in `Kernl.app/Contents/Resources/`. This used to go
 * two levels up and then insist the result end in `.app/Contents` — two
 * levels up from Resources IS `Kernl.app`, so the check never matched and
 * every macOS update was refused with "could not work out which directory to
 * replace". Looking for the `.app` segment followed by `Contents` survives any
 * depth under the bundle.
 */
export function macBundleFromModuleDir(moduleDir: string): string | null {
  const parts = segments(moduleDir);
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i]!.endsWith(".app") && parts[i + 1] === "Contents") {
      return `/${parts.slice(0, i + 1).join("/")}`;
    }
  }
  return null;
}

/**
 * Why a macOS bundle cannot be replaced from inside, or null when it can.
 *
 * Each of these fails AFTER the app has quit if nobody checks first: a
 * translocated app runs from a randomised read-only mount, a disk image is
 * read-only, and a standard account cannot rename items in /Applications.
 */
export function macUpdateBlocker(
  bundle: string,
  access: { parentWritable: boolean; bundleWritable: boolean },
): { reason: string; useInstead: string } | null {
  if (bundle.includes("/AppTranslocation/")) {
    return {
      reason:
        "macOS is running Kernl from a temporary read-only copy, because it was opened " +
        "straight from Downloads. There is nothing there an update could replace.",
      useInstead: "Move Kernl.app into /Applications, open it from there, then update.",
    };
  }
  if (bundle.startsWith("/Volumes/")) {
    return {
      reason: "Kernl is running from its disk image, which is read-only.",
      useInstead: "Drag Kernl.app into /Applications, open it from there, then update.",
    };
  }
  if (!access.parentWritable || !access.bundleWritable) {
    const parent = `/${segments(bundle).slice(0, -1).join("/")}`;
    return {
      reason: `This account cannot replace apps in ${parent}, so the update would fail after Kernl had already closed.`,
      useInstead:
        "Update from an administrator account, or re-run install.sh, which asks for the password.",
    };
  }
  return null;
}

/**
 * The directory a swap (or an msiexec upgrade) applies to, given where the
 * running module lives.
 *
 * macOS has `macBundleFromModuleDir` — the bundle is `Contents/`'s parent, not
 * `bin/`'s. Everywhere else the root is `bin/`'s parent when the layout has a
 * `bin/`, and the module directory itself when it is flat, which is every
 * Windows install. Returns null when the layout is not one we can place, which
 * the caller must treat as "refuse", never as "guess".
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
  return joinSegments(root);
}

/** Can `kind` be replaced by swapping a directory? */
export function isSwappable(kind: InstallKind): boolean {
  return kind === "macos-app" || kind === "windows-dir" || kind === "linux-portable";
}

/**
 * Where to stage the download so the swap can actually happen: beside the
 * thing being replaced.
 *
 * `move` on Windows cannot move a DIRECTORY to a different volume, and the
 * system temp directory is on C: while a portable copy is as likely to live on
 * D: or a USB stick. On POSIX the same choice turns a cross-device copy of a
 * few hundred megabytes into a rename.
 *
 * Null when there is nothing to swap (an installer hands a file to the OS, so
 * any readable location will do) — the caller falls back to the temp dir, and
 * also falls back when this directory cannot be written.
 */
export function stagingParentFor(target: string, kind: InstallKind): string | null {
  if (!isSwappable(kind)) return null;
  const parts = segments(target);
  if (parts.length < 2) return null;
  return joinSegments(parts.slice(0, -1));
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
 * to execute a directory.
 *
 * Windows has `start.bat`, the documented entry point that sets up
 * %LOCALAPPDATA% first. The Linux tarball ships `kernl`, a launcher that moves
 * into ~/.local/share/kernl before starting; a tarball from before it existed
 * has only the bundled runtime to run, which is what `launcher: false` gives.
 */
export function relaunchCommandFor(
  root: string,
  kind: InstallKind,
  opts: { launcher?: boolean } = {},
): string[] | null {
  switch (kind) {
    case "macos-app":
      return ["open", root];
    case "windows-dir":
      return [`${root}\\start.bat`];
    case "linux-portable":
      return opts.launcher
        ? [`${root}/kernl`]
        : [`${root}/bin/bun`, `${root}/bin/mcp-server.js`];
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

/**
 * The command that installs a downloaded package, and the one to print when it
 * cannot be run from here.
 *
 * `pkexec` is the desktop's own administrator prompt — polkit's equivalent of
 * UAC — so a package upgrade stays inside the app without a terminal. When
 * there is no pkexec, `argv` is null and `manual` is the exact command, naming
 * the file already downloaded and verified. This used to suggest
 * `apt upgrade kernl`, which does nothing: no repository publishes Kernl, and
 * install.sh installs the downloaded file directly.
 */
export function packageInstallPlan(
  format: PackageFormat,
  file: string,
  opts: { isRoot: boolean; find: (tool: string) => string | null },
): { argv: string[] | null; manual: string } {
  const pick = (...names: string[]): { name: string; path: string } | null => {
    for (const name of names) {
      const path = opts.find(name);
      if (path) return { name, path };
    }
    return null;
  };

  let cmd: { name: string; path: string; args: string[] };
  if (format === "rpm") {
    const dnf = pick("dnf", "yum");
    const zypper = pick("zypper");
    cmd = dnf
      ? { ...dnf, args: ["install", "-y", file] }
      : zypper
        ? { ...zypper, args: ["--non-interactive", "install", "--allow-unsigned-rpm", file] }
        : { name: "rpm", path: opts.find("rpm") ?? "rpm", args: ["-Uvh", file] };
  } else {
    const apt = pick("apt-get");
    cmd = apt
      ? { ...apt, args: ["install", "-y", file] }
      : { name: "dpkg", path: opts.find("dpkg") ?? "dpkg", args: ["-i", file] };
  }

  const word = (s: string) => (/[\s'"$`\\]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s);
  const manual = `sudo ${[cmd.name, ...cmd.args].map(word).join(" ")}`;
  const argv = [cmd.path, ...cmd.args];

  if (opts.isRoot) return { argv, manual };
  const pkexec = opts.find("pkexec");
  return { argv: pkexec ? [pkexec, ...argv] : null, manual };
}

export type RestartMethod =
  | { kind: "systemd-user"; unit: string }
  | { kind: "systemd-system"; unit: string }
  | { kind: "relaunch" };

/**
 * How a package install that was just upgraded gets back up.
 *
 * Under systemd a detached helper does not survive: the unit's cgroup is
 * killed with its main process, helper included. So a unit is restarted by
 * systemd itself, and only a kernel somebody started by hand is relaunched by
 * a helper. `INVOCATION_ID` is set for every process systemd starts; the
 * cgroup path says which manager and which unit.
 */
export function restartMethodFor(
  env: Record<string, string | undefined>,
  cgroup: string,
): RestartMethod {
  if (!env.INVOCATION_ID) return { kind: "relaunch" };
  const lines = cgroup.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => l.startsWith("0::")) ?? lines[lines.length - 1] ?? "";
  const path = line.replace(/^[^:]*:[^:]*:/, "");
  const unit = segments(path).reverse().find((s) => s.endsWith(".service"));
  if (!unit) return { kind: "relaunch" };
  return /\/user@\d+\.service\//.test(path)
    ? { kind: "systemd-user", unit }
    : { kind: "systemd-system", unit };
}

/** Running inside a container? Then the image is the thing to update. */
export function isContainer(probe: {
  dockerenv: boolean;
  env: Record<string, string | undefined>;
  cgroup: string;
}): boolean {
  if (probe.dockerenv) return true;
  // Podman and systemd-nspawn set `container` for PID 1's environment.
  if (probe.env.container) return true;
  return /docker|containerd|kubepods|libpod/.test(probe.cgroup);
}

/** What to tell someone running the Docker stack, instead of a button. */
export const DOCKER_UPDATE_HINT =
  "git pull && docker compose -f docker-compose.yml build kernel dashboard " +
  "&& docker compose -f docker-compose.yml up -d kernel dashboard";

/**
 * Every process below `root`, from (pid, parent) pairs.
 *
 * Children the kernel started — whisper, ffmpeg, a bun child for an agent —
 * outlive a plain `process.exit` and keep files in the install directory
 * open, which on Windows makes the helper's `move` fail.
 */
export function descendantsOf(
  root: number,
  pairs: { pid: number; ppid: number }[],
  exclude: number[] = [],
): number[] {
  const skip = new Set(exclude);
  const byParent = new Map<number, number[]>();
  for (const { pid, ppid } of pairs) {
    const list = byParent.get(ppid) ?? [];
    list.push(pid);
    byParent.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [...(byParent.get(root) ?? [])];
  while (queue.length) {
    const pid = queue.shift()!;
    if (skip.has(pid) || pid === root || out.includes(pid)) continue;
    out.push(pid);
    queue.push(...(byParent.get(pid) ?? []));
  }
  return out;
}

/** The parent PID from a `/proc/<pid>/stat` line, whose comm may hold spaces. */
export function parentFromProcStat(stat: string): number | null {
  const end = stat.lastIndexOf(")");
  if (end < 0) return null;
  const fields = stat.slice(end + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? ppid : null;
}
