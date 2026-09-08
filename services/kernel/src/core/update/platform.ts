/**
 * Which release artefact this machine needs, and whether it may replace itself.
 *
 * Pure: takes a platform, an architecture and a path, and returns a name and a
 * verdict. No filesystem, no process — so the decisions that differ per
 * operating system can be tested on whichever one happens to be running the
 * suite, which for three target platforms and one CI box is the only way any
 * of them gets tested at all.
 */

export type InstallKind =
  | "macos-app"
  | "windows-dir"
  | "linux-package"
  | "linux-portable"
  | "unknown";

/**
 * The asset the release publishes for this machine, or null when it publishes
 * none.
 *
 * Windows takes the ZIP rather than the MSI on purpose: the installer is for a
 * person doing a fresh install, while replacing a directory in place wants the
 * plain archive — the same shape the macOS path already uses.
 *
 * The Linux tarball is new. The pipeline shipped only .deb and .rpm, which is
 * why in-app update on Linux could never work no matter what this code did:
 * there was nothing self-contained to download. A portable tarball is what
 * gives a non-package install something to swap in.
 */
export function assetFor(version: string, platform: string, arch: string): string | null {
  const cpu = arch === "arm64" ? "arm64" : "x64";
  switch (platform) {
    case "darwin":
      return `Kernl-${version}-${cpu}-macos.tar.gz`;
    case "win32":
      return `Kernl-${version}-windows-${cpu}.zip`;
    case "linux":
      return `Kernl-${version}-${cpu}-linux.tar.gz`;
    default:
      return null;
  }
}

/** Path segments, with Windows separators folded in so one check covers both. */
function segments(path: string): string[] {
  return path.replace(/\\+/g, "/").split("/").filter(Boolean);
}

/**
 * How this instance was installed, from the path its own code is running from.
 *
 * The distinction that matters is Linux: a copy under `/opt/kernl` belongs to
 * dpkg or rpm, and replacing files a package manager believes it owns leaves a
 * machine whose next `apt upgrade` quietly reverts the update. That is worse
 * than refusing, so it is refused — but only for that case. A tarball unpacked
 * into a home directory has no such owner and is as swappable as anything else,
 * and the previous code refused those too, for a reason that did not apply.
 *
 * Matched on whole path SEGMENTS, never on substrings: `/home/me/opt/kernl`
 * and `/opt/kernl-dev` both contain the text and neither is a package install.
 */
export function installKind(modulePath: string, platform: string): InstallKind {
  const parts = segments(modulePath);

  if (platform === "darwin") {
    return parts.some((p) => p.endsWith(".app")) ? "macos-app" : "unknown";
  }

  // A staged install puts the bundled server in `bin/` with the root one level
  // above it (see packaging/stage-payload.sh). Requiring that shape is what
  // separates a real install from a source checkout or a container — both of
  // which run from `src/…` and must never be swapped: there is no packaged
  // tree there to replace, and replacing a developer's working copy with a
  // release tarball would be the worst possible reading of "update".
  const looksPackaged = parts[parts.length - 1] === "bin";

  if (platform === "win32") return looksPackaged ? "windows-dir" : "unknown";

  if (platform === "linux") {
    // `/opt` has to be the ROOT of the path, not a directory that happens to
    // be called that inside a home folder.
    if (parts[0] === "opt" && parts[1] === "kernl") return "linux-package";
    return looksPackaged ? "linux-portable" : "unknown";
  }

  return "unknown";
}

/**
 * The directory a swap replaces, given where the running module lives.
 *
 * macOS keeps its own resolver in `apply.ts` — the bundle is `Contents/`'s
 * parent, not `bin/`'s. Everywhere else the staged layout is `<root>/bin/`, so
 * the root is one level up. Returns null when the layout is not one we can
 * place, which the caller must treat as "refuse", never as "guess".
 */
export function installRootFrom(moduleDir: string, kind: InstallKind): string | null {
  if (kind !== "windows-dir" && kind !== "linux-portable") return null;
  const parts = segments(moduleDir);
  if (parts[parts.length - 1] !== "bin") return null;
  const root = parts.slice(0, -1);
  if (root.length === 0) return null;
  // Preserve the Windows drive letter; rebuild a POSIX path otherwise.
  return /^[a-zA-Z]:$/.test(root[0] ?? "") ? root.join("\\") : `/${root.join("/")}`;
}

/** Can `kind` be replaced by swapping a directory? */
export function isSwappable(kind: InstallKind): boolean {
  return kind === "macos-app" || kind === "windows-dir" || kind === "linux-portable";
}
