@echo off
REM Kernl launcher — runs the kernel from this folder, anchors per-user
REM state under %LOCALAPPDATA%, opens the dashboard once it's responsive.
setlocal enabledelayedexpansion

set APP_DIR=%~dp0
set DATA_DIR=%LOCALAPPDATA%\Kernl
set CONFIG_DIR=%APPDATA%\Kernl

if not exist "%DATA_DIR%\data" mkdir "%DATA_DIR%\data"
if not exist "%DATA_DIR%\logs" mkdir "%DATA_DIR%\logs"
if not exist "%CONFIG_DIR%"    mkdir "%CONFIG_DIR%"

REM First-run: copy the env template into the user's config dir.
if not exist "%CONFIG_DIR%\.env" (
  if exist "%APP_DIR%env.example" (
    copy "%APP_DIR%env.example" "%CONFIG_DIR%\.env" >nul
    echo kernl: created default config at %CONFIG_DIR%\.env
  )
)

REM Source the .env — convert "KEY=value" lines into `set` statements.
if exist "%CONFIG_DIR%\.env" (
  for /f "usebackq tokens=1,* delims==" %%a in ("%CONFIG_DIR%\.env") do (
    set "line=%%a"
    if not "!line:~0,1!"=="#" (
      if not "%%a"=="" set "%%a=%%b"
    )
  )
)

cd /d "%DATA_DIR%"

if "%DASHBOARD_PORT%"=="" set DASHBOARD_PORT=3086

REM `start.bat token` — print the API token and exit.
REM
REM The launcher hands the token to the browser it opens, but that is one
REM browser on one machine. A second browser, an InPrivate window or a phone on
REM the LAN all land on the login form, and "read a dotfile under
REM %LOCALAPPDATA%" assumes the user knows the file is there. Checked before
REM anything is launched, so it never starts a kernel.
if /i "%1"=="token" goto SHOW_TOKEN

REM This script re-invokes itself with --open-when-ready as the browser-opening
REM background task. Same file, so there is nothing extra to package; the flag
REM is checked here, after the config above has been sourced, so the child sees
REM the same DATA_DIR and DASHBOARD_PORT as the parent.
if "%1"=="--open-when-ready" goto OPEN_WHEN_READY

start "" /b cmd /c ""%~f0" --open-when-ready"

REM Keep a record of the boot.
REM
REM logs\ has always been created here and never written to. The kernel logs to
REM stdout, and when this runs from a shortcut the console closes with the
REM process — so a launcher that failed to start left nothing behind, and the
REM only way to see a boot was to already know you could run this from a
REM terminal. One rotation deep: the log that matters is this boot or the one
REM before it, and an unbounded file under %LOCALAPPDATA% is its own bug.
set "LOG_FILE=%DATA_DIR%\logs\kernl.log"
if exist "%LOG_FILE%" move /y "%LOG_FILE%" "%LOG_FILE%.1" >nul 2>&1

REM Foreground: run the kernel. Console window stays open so the user
REM can see logs / Ctrl-C to stop.
REM
REM cmd has no tee, so the output goes through PowerShell's Tee-Object to stay
REM visible in the console AND land in the file. The cost is the exit code:
REM after a pipe, ERRORLEVEL belongs to the last stage, so this reports the
REM tee's status rather than the kernel's. Nothing consumes that status today —
REM the console simply closes — and losing it is the cheaper half of the trade
REM against having no log at all. Redirect instead of piping if that changes,
REM and accept a console that shows nothing.
"%APP_DIR%bun.exe" "%APP_DIR%mcp-server.js" %* 2>&1 | powershell -NoProfile -NonInteractive -Command "$input | Tee-Object -FilePath '%LOG_FILE%'"
exit /b %ERRORLEVEL%

:OPEN_WHEN_READY
REM Wait for the kernel, then open the dashboard.
REM
REM Probe /api/health, not /api/manifest. Everything under /api/ needs the
REM Bearer token except the three paths in AUTH_EXEMPT_PATHS (health, metrics,
REM auth/verify), and this script does not pass KERNEL_ALLOW_UNAUTH — so the
REM kernel mints a token and answers 401. `curl -sf` treats a 401 as failure,
REM so the loop below ran its full 30 seconds and exited WITHOUT opening
REM anything: no browser, no token hand-off, and the user was left to find
REM localhost:3086 themselves and face a login form for a secret they had
REM never been shown. The endpoint has to be one that answers before auth.
for /l %%i in (1,1,30) do (
  curl.exe -sf http://localhost:%DASHBOARD_PORT%/api/health >nul 2>&1 && goto OPEN_NOW
  timeout /t 1 /nobreak >nul
)
exit /b

:OPEN_NOW
REM On first run the kernel generates its own API token, so opening the plain
REM dashboard URL would dead-end on a login form asking for a secret the user
REM has never seen. Read it only NOW — the kernel writes the file during boot,
REM which is after this script started — and hand it over in the URL fragment.
REM The fragment is never sent to the server, so it stays out of access logs;
REM the login page consumes it and strips it from the URL.
set "TOK=%KERNEL_AUTH_TOKEN%"
if "%TOK%"=="" (
  if exist "%DATA_DIR%\data\.kernel-auth-token" set /p TOK=<"%DATA_DIR%\data\.kernel-auth-token"
)
if "%TOK%"=="" (
  start "" "http://localhost:%DASHBOARD_PORT%"
) else (
  start "" "http://localhost:%DASHBOARD_PORT%/login#token=!TOK!"
)
exit /b

:SHOW_TOKEN
if not "!KERNEL_AUTH_TOKEN!"=="" (
  echo !KERNEL_AUTH_TOKEN!
  exit /b 0
)
if exist "%DATA_DIR%\data\.kernel-auth-token" (
  type "%DATA_DIR%\data\.kernel-auth-token"
  exit /b 0
)
echo kernl: no token yet - it is generated on the first boot. 1>&2
echo kernl: run start.bat once, then re-run this. 1>&2
exit /b 1
