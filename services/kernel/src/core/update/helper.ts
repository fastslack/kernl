/**
 * The script that finishes an update, for each platform that can update itself.
 *
 * The kernel lives inside the directory it has to replace, so it cannot do this
 * itself: it stages the new copy, writes one of these, spawns it detached and
 * exits. From that point nothing supervises the helper, which is why it is
 * deliberately dumb and readable — somebody may find it in a temp directory
 * wondering what replaced their application.
 *
 * Four properties matter more than any of the platform differences:
 *
 *   · It waits for the process to exit, and gives up rather than waiting
 *     forever. Swapping a directory out from under a live process is the one
 *     unrecoverable mistake.
 *   · It keeps the old copy until the new one is in place, and puts it back if
 *     the swap fails. An update that fails is recoverable; one that leaves no
 *     application behind is not.
 *   · It checks the move that parks the old copy. Unchecked, a failure there
 *     (no permission, a file still open) let the NEXT move drop the new tree
 *     INSIDE the old install — `move` into an existing directory moves into
 *     it — report success, and delete a backup that was never made.
 *   · Every path is quoted. "C:\\Program Files\\Kernl" and "/Applications/My
 *     Apps/Kernl.app" are both ordinary.
 *
 * It also has to relaunch something that is actually executable. That used to
 * be the install ROOT on every platform: correct for `open` on a macOS bundle,
 * and on the others a directory — so Windows opened Explorer and Linux tried
 * to execute a folder. The command now comes from `relaunchCommandFor`.
 */

import type { InstallKind } from "./platform.js";

export interface HelperArgs {
  /** The kernel's PID. The helper waits for it to disappear. */
  pid: number;
  /** Where the verified new copy is sitting. */
  staged: string;
  /** What it replaces. */
  target: string;
  /** Where the old copy is parked while the swap happens. */
  backup: string;
  /** Command + arguments that start Kernl again. Empty to start nothing. */
  relaunch: string[];
  /** For an installer-driven upgrade: the package to hand to the OS. */
  installer?: string;
}

/** How long to wait for the kernel to exit, in seconds. */
const WAIT_SECONDS = 60;

export function helperFilename(kind: InstallKind): string {
  return kind === "windows-dir" || kind === "windows-msi"
    ? "kernl-update.cmd"
    : "kernl-update.sh";
}

/** `a b c` → `"a" "b" "c"`, so a space in any of them is not a bug. */
function quoted(parts: string[]): string {
  return parts.map((p) => `"${p}"`).join(" ");
}

/**
 * POSIX helper — macOS and portable Linux.
 *
 * The differences between the two are the tail: macOS has to strip the
 * quarantine attribute a downloaded archive carries, or Gatekeeper refuses the
 * relaunch and the update reports success while leaving an app that will not
 * open. Linux has no such attribute and no `open`.
 */
function posixHelper(a: HelperArgs, mac: boolean): string {
  const unquarantine = mac
    ? `  # A downloaded bundle is quarantined; without this Gatekeeper refuses the
  # relaunch and the user is left with an app that will not open.
  xattr -dr com.apple.quarantine "${a.target}" 2>/dev/null || true\n`
    : "";
  const launch = a.relaunch.length
    ? mac
      ? quoted(a.relaunch)
      : `${quoted(a.relaunch)} >/dev/null 2>&1 &`
    : ": # nothing to relaunch";

  return `#!/bin/sh
# Written by Kernl to finish an update. Safe to delete.
set -eu

# Wait for the kernel to exit — we are about to replace the directory it is
# running from. Bounded: if it never dies, do nothing rather than swap a
# directory out from under a live process.
i=0
while kill -0 ${a.pid} 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt ${WAIT_SECONDS} ] && exit 1
  sleep 1
done

# Keep the old copy until the new one is in place. If parking it fails there is
# nothing safe left to do: the install is still intact, so stop here rather
# than move the new tree on top of it.
rm -rf "${a.backup}"
if ! mv "${a.target}" "${a.backup}"; then
  exit 1
fi

if mv "${a.staged}" "${a.target}"; then
${unquarantine}  rm -rf "${a.backup}"
else
  # Put it back. An update that fails is recoverable; one that leaves nothing
  # behind is not.
  mv "${a.backup}" "${a.target}"
fi

${launch}
`;
}

/**
 * Windows helper, for a directory that was unzipped.
 *
 * `tasklist` is the portable way to ask whether a PID is still alive without
 * PowerShell. The sleep is `ping`, NOT `timeout`: this script is spawned with
 * its stdio ignored, and `timeout` refuses to run at all when stdin is
 * redirected — "ERROR: Input redirection is not supported". The loop then
 * spent its sixty tries in a few milliseconds and exited without swapping
 * anything, so the kernel had already quit, nothing was updated, and nothing
 * came back up. `ping -n 2 127.0.0.1` waits a second on every Windows install
 * and does not care what stdin is.
 */
function windowsHelper(a: HelperArgs): string {
  const launch = a.relaunch.length
    ? `start "" ${quoted(a.relaunch)}`
    : `REM nothing to relaunch`;

  return `@echo off
REM Written by Kernl to finish an update. Safe to delete.
setlocal

REM Wait for the kernel to exit before replacing its directory. Bounded, so a
REM process that never dies leaves the install untouched instead of hanging.
set /a tries=0
:wait
tasklist /FI "PID eq ${a.pid}" 2>nul | find "${a.pid}" >nul
if errorlevel 1 goto swap
set /a tries+=1
if %tries% GEQ ${WAIT_SECONDS} exit /b 1
ping -n 2 127.0.0.1 >nul
goto wait

:swap
REM Keep the old copy until the new one is in place.
if exist "${a.backup}" rmdir /s /q "${a.backup}"
move "${a.target}" "${a.backup}" >nul
if errorlevel 1 (
  REM Parking the old copy failed — most often no permission to write here.
  REM The install is still intact and MOVE into an existing directory would
  REM nest the new tree inside it, so stop while everything still works.
  exit /b 1
)

move "${a.staged}" "${a.target}" >nul
if errorlevel 1 (
  REM Put it back. An update that fails is recoverable; one that leaves
  REM nothing behind is not.
  move "${a.backup}" "${a.target}" >nul
) else (
  rmdir /s /q "${a.backup}"
)

${launch}
`;
}

/**
 * Windows helper, for an MSI install.
 *
 * Nothing is swapped here, and that is the point. An MSI owns its files, its
 * registry entry, its uninstaller and its elevation prompt; replacing the
 * directory underneath it leaves Add/Remove Programs advertising a version
 * that is no longer on disk and a repair or uninstall operating on a tree it
 * never wrote. `product.wxs` already carries a MajorUpgrade with a stable
 * UpgradeCode, so handing the new MSI to msiexec is a supported in-place
 * upgrade — the user sees the installer's own progress bar and one UAC prompt.
 *
 * `/qb` rather than `/quiet`: a perMachine install needs elevation, and a
 * silent install that dies at an invisible UAC prompt looks exactly like an
 * update that did nothing.
 */
function windowsInstallerHelper(a: HelperArgs): string {
  const launch = a.relaunch.length
    ? `start "" ${quoted(a.relaunch)}`
    : `REM nothing to relaunch`;

  return `@echo off
REM Written by Kernl to finish an update. Safe to delete.
setlocal

REM Wait for the kernel to exit: msiexec cannot replace files that are open.
set /a tries=0
:wait
tasklist /FI "PID eq ${a.pid}" 2>nul | find "${a.pid}" >nul
if errorlevel 1 goto upgrade
set /a tries+=1
if %tries% GEQ ${WAIT_SECONDS} exit /b 1
ping -n 2 127.0.0.1 >nul
goto wait

:upgrade
REM The installer does the work: same UpgradeCode, higher version, so this is
REM an upgrade rather than a second copy. It keeps the registry, the Start
REM Menu shortcut and the uninstaller in step, which a directory swap cannot.
msiexec /i "${a.installer ?? ""}" /qb /norestart
if errorlevel 1 (
  REM Leave the working install alone. The old version is still installed and
  REM still starts, which is the recoverable outcome.
  exit /b 1
)

${launch}
`;
}

export function helperFor(kind: InstallKind, args: HelperArgs): string {
  if (kind === "windows-msi") return windowsInstallerHelper(args);
  if (kind === "windows-dir") return windowsHelper(args);
  return posixHelper(args, kind === "macos-app");
}
