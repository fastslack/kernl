/**
 * The script that finishes an update, for each platform that can update itself.
 *
 * The kernel lives inside the directory it has to replace, so it cannot do this
 * itself: it stages the new copy, writes one of these, spawns it detached and
 * exits. From that point nothing supervises the helper, which is why it is
 * deliberately dumb and readable — somebody may find it in a temp directory
 * wondering what replaced their application.
 *
 * The properties that matter more than any of the platform differences:
 *
 *   · It waits for the process to exit, and gives up rather than waiting
 *     forever. Swapping a directory out from under a live process is the one
 *     unrecoverable mistake.
 *   · It keeps the old copy until the new one has answered, and puts it back
 *     if the swap fails or the new version never comes up. An update that
 *     fails is recoverable; one that leaves no application behind is not.
 *   · It checks the move that parks the old copy. Unchecked, a failure there
 *     let the NEXT move drop the new tree INSIDE the old install — `move` into
 *     an existing directory moves into it.
 *   · Every way out starts Kernl again. A failed helper used to just exit, and
 *     since the kernel had already quit the app simply disappeared.
 *   · Every way out writes what happened to `resultFile`, as a code the next
 *     kernel turns into a sentence for the UI. Codes rather than prose because
 *     cmd.exe cannot be trusted with punctuation.
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
  /** Command + arguments that start Kernl again. Empty to start nothing. */
  relaunch: string[];
  /** For an installer-driven upgrade: the package to hand to the OS. */
  installer?: string;
  /** Where to write `{"version","result","code"}` for the next boot to read. */
  resultFile?: string;
  /** The version being installed, recorded in the result. */
  version?: string;
  /** Polled after the relaunch; without one the new kernel confirms on boot. */
  healthUrl?: string;
  /** The staging directory, removed at the end where the platform allows. */
  stagingDir?: string;
}

/** How long to wait for the kernel to exit, in seconds. */
const WAIT_SECONDS = 60;

/**
 * How long the new version gets to answer before it is rolled back, in
 * seconds. A first boot seeds agents, runs migrations and loads an embedding
 * model — the Windows smoke test allows five minutes for the same reason.
 */
const HEALTH_SECONDS = 300;

export function helperFilename(kind: InstallKind): string {
  return kind === "windows-dir" || kind === "windows-msi"
    ? "kernl-update.cmd"
    : "kernl-update.sh";
}

/** `a b c` → `"a" "b" "c"`, so a space in any of them is not a bug. */
function quoted(parts: string[]): string {
  return parts.map((p) => `"${p}"`).join(" ");
}

// ── POSIX ──────────────────────────────────────────────────────────────────

function posixPreamble(a: HelperArgs): string {
  return `#!/bin/sh
# Written by Kernl to finish an update${a.version ? ` to ${a.version}` : ""}. Safe to delete.
set -u

RESULT="${a.resultFile ?? ""}"
result() {
  [ -n "$RESULT" ] || return 0
  printf '{"version":"%s","result":"%s","code":"%s","at":%s}\\n' \\
    "${a.version ?? ""}" "$1" "$2" "$(date +%s)" > "$RESULT" 2>/dev/null || true
}

# Wait for the kernel to exit — we are about to replace what it is running
# from. Bounded: if it never dies, do nothing rather than swap a directory
# out from under a live process.
i=0
while kill -0 ${a.pid} 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt ${WAIT_SECONDS} ]; then
    result failed kernel-did-not-exit
    exit 1
  fi
  sleep 1
done
`;
}

/** 0 when the new kernel answered, 1 when it never did, 2 when nothing can ask. */
function posixHealthFunction(a: HelperArgs): string {
  if (!a.healthUrl) return `healthy() {\n  return 2\n}\n`;
  return `healthy() {
  n=0
  while [ "$n" -lt ${HEALTH_SECONDS} ]; do
    if command -v curl >/dev/null 2>&1; then
      curl -fs -o /dev/null --max-time 3 "${a.healthUrl}" && return 0
    elif command -v wget >/dev/null 2>&1; then
      wget -q -O /dev/null -T 3 "${a.healthUrl}" && return 0
    else
      return 2
    fi
    n=$((n + 5))
    sleep 5
  done
  return 1
}
`;
}

/**
 * POSIX helper — macOS and portable Linux.
 *
 * The differences between the two are the tail: macOS has to strip the
 * quarantine attribute a downloaded archive carries, or Gatekeeper refuses the
 * relaunch. Linux has no such attribute and no `open`.
 */
function posixHelper(a: HelperArgs, mac: boolean): string {
  const unquarantine = mac
    ? `# A downloaded bundle is quarantined; without this Gatekeeper refuses the
# relaunch and the user is left with an app that will not open.
xattr -dr com.apple.quarantine "${a.target}" 2>/dev/null || true\n`
    : "";
  const launch = a.relaunch.length
    ? mac
      ? quoted(a.relaunch)
      : `nohup ${quoted(a.relaunch)} >/dev/null 2>&1 &`
    : ": # nothing to relaunch";
  const cleanup = a.stagingDir ? `rm -rf "${a.stagingDir}"\n` : "";

  return `${posixPreamble(a)}
relaunch() {
  ${launch}
}

${posixHealthFunction(a)}
# Keep the old copy until the new one is in place. If parking it fails there is
# nothing safe left to do: the install is still intact, so start it again and
# stop here rather than put the new tree on top of it.
rm -rf "${a.backup}"
if ! mv "${a.target}" "${a.backup}"; then
  result failed move-aside
  relaunch
  exit 1
fi

if ! mv "${a.staged}" "${a.target}"; then
  # Put it back. An update that fails is recoverable; one that leaves nothing
  # behind is not.
  mv "${a.backup}" "${a.target}"
  result failed move-in
  relaunch
  exit 1
fi

${unquarantine}relaunch

healthy
case $? in
  0)
    rm -rf "${a.backup}"
    result ok ok
    ;;
  2)
    # Nothing to ask with. The new kernel confirms the update when it boots,
    # and removes the previous copy then.
    result pending no-health-probe
    ;;
  *)
    # The new version never answered. Stop whatever of it is still running,
    # put the previous copy back and start that instead.
    pkill -f "${a.target}/" 2>/dev/null || true
    sleep 2
    rm -rf "${a.target}.failed"
    if mv "${a.target}" "${a.target}.failed" && mv "${a.backup}" "${a.target}"; then
      result rolled-back new-version-did-not-start
      relaunch
    else
      result failed rollback-failed
    fi
    ;;
esac

${cleanup}`;
}

/**
 * POSIX helper for a package that was already upgraded by dpkg or rpm.
 *
 * Nothing to swap — the package manager replaced the files — only a kernel to
 * start again once the old one has gone. Used when nobody supervises the
 * kernel; a systemd unit is restarted by systemd instead (see
 * `restartMethodFor`).
 */
function posixRestartHelper(a: HelperArgs): string {
  const launch = a.relaunch.length
    ? `nohup ${quoted(a.relaunch)} >/dev/null 2>&1 &`
    : ": # nothing to relaunch";
  const cleanup = a.stagingDir ? `rm -rf "${a.stagingDir}"\n` : "";
  return `${posixPreamble(a)}
${posixHealthFunction(a)}
${launch}

healthy
case $? in
  0) result ok ok ;;
  2) result pending no-health-probe ;;
  *) result failed new-version-did-not-start ;;
esac

${cleanup}`;
}

// ── Windows ────────────────────────────────────────────────────────────────

/**
 * Everything Windows below is called by full path from System32.
 *
 * Git for Windows, MSYS and Cygwin put GNU `find` and `tar` on PATH, often
 * ahead of System32. GNU find does not filter stdin for a string, so the wait
 * loop ended immediately and the swap was attempted with the kernel still
 * alive.
 *
 * The sleep is `ping`, NOT `timeout`: this script is spawned with its stdio
 * ignored, and `timeout` refuses to run at all when stdin is redirected.
 */
function windowsPreamble(a: HelperArgs, next: string): string {
  return `@echo off
REM Written by Kernl to finish an update${a.version ? ` to ${a.version}` : ""}. Safe to delete.
setlocal EnableExtensions
set "SYS=%SystemRoot%\\System32"
set "RESULT=${a.resultFile ?? ""}"

REM Wait for the kernel to exit first. Bounded, so a process that never dies
REM leaves the install untouched instead of hanging.
set /a tries=0
:wait
"%SYS%\\tasklist.exe" /FI "PID eq ${a.pid}" 2>nul | "%SYS%\\find.exe" "${a.pid}" >nul
if errorlevel 1 goto ${next}
set /a tries+=1
if %tries% GEQ ${WAIT_SECONDS} goto wait_gave_up
"%SYS%\\ping.exe" -n 2 127.0.0.1 >nul
goto wait

:wait_gave_up
call :result failed kernel-did-not-exit
exit /b 1
`;
}

/** Subroutines shared by both Windows helpers. */
function windowsSubroutines(a: HelperArgs): string {
  const launch = a.relaunch.length
    ? `start "" ${quoted(a.relaunch)}`
    : `REM nothing to relaunch`;
  const health = a.healthUrl
    ? `if not exist "%SYS%\\curl.exe" exit /b 2
set /a htries=0
:hloop
"%SYS%\\curl.exe" -fs -o nul --max-time 3 "${a.healthUrl}" >nul 2>&1
if not errorlevel 1 exit /b 0
set /a htries+=1
if %htries% GEQ ${Math.ceil(HEALTH_SECONDS / 5)} exit /b 1
"%SYS%\\ping.exe" -n 6 127.0.0.1 >nul
goto hloop`
    : `exit /b 2`;

  // Plain ASCII in everything cmd.exe reads: the file is written as UTF-8 and
  // cmd parses it in the console's code page.
  return `
REM ---- subroutines ----------------------------------------------------------

:relaunch
${launch}
exit /b 0

:wait_healthy
REM 0 = the new kernel answered, 1 = it never did, 2 = nothing to ask with.
${health}

:result
if "%RESULT%"=="" exit /b 0
>"%RESULT%" echo {"version":"${a.version ?? ""}","result":"%~1","code":"%~2"}
exit /b 0
`;
}

/**
 * Windows helper, for a directory that was unzipped.
 *
 * A file stays locked for a moment after the process that held it exits — an
 * antivirus scan of a freshly written tree, a child process still closing — so
 * each move is retried for about half a minute before it counts as a failure.
 */
function windowsHelper(a: HelperArgs): string {
  return `${windowsPreamble(a, "swap")}
:swap
REM Keep the old copy until the new one has answered.
if exist "${a.backup}" rmdir /s /q "${a.backup}"
set /a mtries=0
:park
move "${a.target}" "${a.backup}" >nul 2>&1
if errorlevel 1 goto park_retry
goto parked

:park_retry
set /a mtries+=1
if %mtries% GEQ 10 goto park_failed
"%SYS%\\ping.exe" -n 4 127.0.0.1 >nul
goto park

:park_failed
REM Parking the old copy failed. The install is still intact and MOVE into an
REM existing directory would nest the new tree inside it, so start the working
REM copy again and stop while everything still works.
call :result failed move-aside
call :relaunch
exit /b 1

:parked
set /a mtries=0
:movein
move "${a.staged}" "${a.target}" >nul 2>&1
if errorlevel 1 goto movein_retry
goto started

:movein_retry
set /a mtries+=1
if %mtries% GEQ 10 goto movein_failed
"%SYS%\\ping.exe" -n 4 127.0.0.1 >nul
goto movein

:movein_failed
REM Put it back. An update that fails is recoverable; one that leaves nothing
REM behind is not.
move "${a.backup}" "${a.target}" >nul 2>&1
call :result failed move-in
call :relaunch
exit /b 1

:started
call :relaunch
call :wait_healthy
if errorlevel 2 goto unconfirmed
if errorlevel 1 goto rollback
rmdir /s /q "${a.backup}"
call :result ok ok
exit /b 0

:unconfirmed
REM No curl.exe to ask with. The new kernel confirms the update when it boots.
call :result pending no-health-probe
exit /b 0

:rollback
REM The new version never answered. Stop whatever of it still runs from this
REM folder, put the previous copy back and start that instead.
powershell -NoProfile -NonInteractive -Command "Get-Process | Where-Object { $_.Path -like '${a.target}\\*' } | Stop-Process -Force" >nul 2>&1
"%SYS%\\ping.exe" -n 4 127.0.0.1 >nul
if exist "${a.target}.failed" rmdir /s /q "${a.target}.failed"
move "${a.target}" "${a.target}.failed" >nul 2>&1
if errorlevel 1 goto rollback_failed
move "${a.backup}" "${a.target}" >nul 2>&1
if errorlevel 1 goto rollback_failed
call :result rolled-back new-version-did-not-start
call :relaunch
exit /b 1

:rollback_failed
call :result failed rollback-failed
exit /b 1
${windowsSubroutines(a)}`;
}

/**
 * Windows helper, for an MSI install.
 *
 * Nothing is swapped here, and that is the point. An MSI owns its files, its
 * registry entry, its uninstaller and its elevation prompt; replacing the
 * directory underneath it leaves Add/Remove Programs advertising a version
 * that is no longer on disk. `product.wxs` carries a MajorUpgrade with a
 * stable UpgradeCode, so handing the new MSI to msiexec is a supported
 * in-place upgrade — one UAC prompt and the installer's own progress bar.
 *
 * `/qb` rather than `/quiet`: a perMachine install needs elevation, and a
 * silent install that dies at an invisible UAC prompt looks exactly like an
 * update that did nothing. There is no rollback to do: when msiexec fails the
 * previous version is still installed, and it is started again.
 */
function windowsInstallerHelper(a: HelperArgs): string {
  return `${windowsPreamble(a, "upgrade")}
:upgrade
REM The installer does the work: same UpgradeCode, higher version, so this is
REM an upgrade rather than a second copy.
"%SYS%\\msiexec.exe" /i "${a.installer ?? ""}" /qb /norestart
set "rc=%errorlevel%"
REM 3010 is success with a reboot pending: the files are in place.
if "%rc%"=="0" goto installed
if "%rc%"=="3010" goto installed
if "%rc%"=="1602" goto cancelled
REM Any other code leaves the previous version installed; start it again.
call :result failed msiexec-%rc%
call :relaunch
exit /b 1

:cancelled
REM 1602: the UAC prompt was declined. Nothing changed.
call :result failed uac-declined
call :relaunch
exit /b 1

:installed
call :relaunch
call :wait_healthy
if errorlevel 2 goto unconfirmed
if errorlevel 1 goto not_started
call :result ok ok
exit /b 0

:unconfirmed
call :result pending no-health-probe
exit /b 0

:not_started
call :result failed new-version-did-not-start
exit /b 1
${windowsSubroutines(a)}`;
}

/**
 * Windows helper that only restarts: wait for the kernel to exit, start it
 * again through start.bat, wait for it to answer. Nothing is moved or
 * installed — it exists so an extension update can take effect without the
 * user closing a console window and finding the shortcut.
 */
function windowsRestartHelper(a: HelperArgs): string {
  return `${windowsPreamble(a, "go")}
:go
call :relaunch
call :wait_healthy
if errorlevel 2 exit /b 0
if errorlevel 1 exit /b 1
exit /b 0
${windowsSubroutines(a)}`;
}

/** The restart-only helper for this platform; no files are replaced. */
export function restartHelperFor(windows: boolean, args: HelperArgs): string {
  return windows ? windowsRestartHelper(args) : posixRestartHelper(args);
}

export function helperFor(kind: InstallKind, args: HelperArgs): string {
  if (kind === "windows-msi") return windowsInstallerHelper(args);
  if (kind === "windows-dir") return windowsHelper(args);
  if (kind === "linux-package") return posixRestartHelper(args);
  return posixHelper(args, kind === "macos-app");
}
