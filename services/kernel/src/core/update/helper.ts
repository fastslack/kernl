/**
 * The script that finishes an update, for each platform that can swap itself.
 *
 * The kernel lives inside the directory it has to replace, so it cannot do this
 * itself: it stages the new copy, writes one of these, spawns it detached and
 * exits. From that point nothing supervises the helper, which is why it is
 * deliberately dumb and readable — somebody may find it in a temp directory
 * wondering what replaced their application.
 *
 * Three properties matter more than any of the platform differences:
 *
 *   · It waits for the process to exit, and gives up rather than waiting
 *     forever. Swapping a directory out from under a live process is the one
 *     unrecoverable mistake.
 *   · It keeps the old copy until the new one is in place, and puts it back if
 *     the swap fails. An update that fails is recoverable; one that leaves no
 *     application behind is not.
 *   · Every path is quoted. "C:\\Program Files\\Kernl" and "/Applications/My
 *     Apps/Kernl.app" are both ordinary.
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
  /** What to start when it is done. */
  relaunch: string;
}

/** How long to wait for the kernel to exit, in seconds. */
const WAIT_SECONDS = 60;

export function helperFilename(kind: InstallKind): string {
  return kind === "windows-dir" ? "kernl-update.cmd" : "kernl-update.sh";
}

/**
 * POSIX helper — macOS and portable Linux.
 *
 * The only real difference between the two is the tail: macOS has to strip the
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
  const launch = mac ? `open "${a.relaunch}"` : `"${a.relaunch}" >/dev/null 2>&1 &`;

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

# Keep the old copy until the new one is in place.
rm -rf "${a.backup}"
mv "${a.target}" "${a.backup}"

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
 * Windows helper.
 *
 * Same shape, different vocabulary. `tasklist` is the portable way to ask
 * whether a PID is still alive without PowerShell, and `timeout /t 1` is the
 * sleep that exists on every install. `move` on a directory is atomic enough
 * for this within one volume, which a staged copy in the same temp root is.
 */
function windowsHelper(a: HelperArgs): string {
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
timeout /t 1 /nobreak >nul
goto wait

:swap
REM Keep the old copy until the new one is in place.
if exist "${a.backup}" rmdir /s /q "${a.backup}"
move "${a.target}" "${a.backup}" >nul
move "${a.staged}" "${a.target}" >nul
if errorlevel 1 (
  REM Put it back. An update that fails is recoverable; one that leaves
  REM nothing behind is not.
  move "${a.backup}" "${a.target}" >nul
) else (
  rmdir /s /q "${a.backup}"
)

start "" "${a.relaunch}"
`;
}

export function helperFor(kind: InstallKind, args: HelperArgs): string {
  if (kind === "windows-dir") return windowsHelper(args);
  return posixHelper(args, kind === "macos-app");
}
