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

REM Background task: poll the manifest endpoint, open the browser when ready.
if "%DASHBOARD_PORT%"=="" set DASHBOARD_PORT=3086
start "" /b cmd /c "for /l %%i in (1,1,30) do (curl.exe -sf http://localhost:%DASHBOARD_PORT%/api/manifest >nul 2>&1 && (start "" http://localhost:%DASHBOARD_PORT% & exit) & timeout /t 1 /nobreak >nul)"

REM Foreground: run the kernel. Console window stays open so the user
REM can see logs / Ctrl-C to stop.
"%APP_DIR%bun.exe" "%APP_DIR%mcp-server.js" %*
