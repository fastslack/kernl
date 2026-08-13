#!/bin/bash
# Build a portable Windows .zip for Kernl (x86_64).
#
# Usage:  PLATFORM=win-x64 packaging/windows/build-zip.sh
#
# Output: ./Kernl-<version>-windows-x64.zip
#
# This produces a "portable" install — user extracts the zip anywhere
# (USB, Desktop, Program Files), double-clicks `start.bat`, and the
# kernel runs. No registry edits, no admin install. Per-user data goes
# to %LOCALAPPDATA%\Kernl.
#
# For a proper .msi (with Start Menu entry, uninstaller, etc.) we use
# wixl from the same staged tree — see .github/workflows/release.yml.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=../stage-payload.sh
PLATFORM="win-x64" source "$SCRIPT_DIR/../stage-payload.sh"

ZIP_OUT="$REPO_ROOT/packaging/out/${NAME}-${VERSION}-windows-x64.zip"
mkdir -p "$REPO_ROOT/packaging/out"
PKG_DIR="$STAGE_DIR/${NAME}-${VERSION}-windows-x64"

mkdir -p "$PKG_DIR"

# Layout — flat enough for users who just unzip and explore. The bun.exe
# at the root makes "rename and run" trivial; start.bat is the official
# entry point because it sets up the per-user data dir first.
cp "$SRC_TREE/bin/bun.exe"       "$PKG_DIR/bun.exe"
cp "$SRC_TREE/bin/mcp-server.js" "$PKG_DIR/mcp-server.js"
[ -d "$SRC_TREE/bin/static" ]     && cp -a "$SRC_TREE/bin/static"     "$PKG_DIR/"
[ -d "$SRC_TREE/bin/extensions" ] && cp -a "$SRC_TREE/bin/extensions" "$PKG_DIR/"
# whisper.cpp + its DLLs, flat, beside mcp-server.js — see the note in
# macos/build-app.sh. Windows makes this one easy: the default DLL search
# order already starts with the executable's own directory.
[ -d "$SRC_TREE/bin/whisper" ]    && cp -a "$SRC_TREE/bin/whisper"    "$PKG_DIR/"
cp -a "$SRC_TREE/node_modules" "$PKG_DIR/"
cp -a "$SRC_TREE/dashboard"    "$PKG_DIR/"
cp -a "$SRC_TREE/assets"       "$PKG_DIR/"
cp    "$SRC_TREE/package.json" "$PKG_DIR/"
cp    "$REPO_ROOT/packaging/rpm/files/env.example" "$PKG_DIR/env.example"

# start.bat — shared with the MSI installer.
cp "$SCRIPT_DIR/start.bat" "$PKG_DIR/start.bat"
sed -i 's/$/\r/' "$PKG_DIR/start.bat"  # CRLF for Windows

# ── README inside the zip — what the user sees on first extract ────
cat > "$PKG_DIR/README.txt" <<EOF
Kernl ${VERSION} — Windows x86_64 portable

Quick start:
  1. Extract this folder anywhere (Desktop, Documents, USB, …).
  2. Double-click start.bat.
  3. Wait a few seconds — your default browser opens at
     http://localhost:3086

Where your data lives:
  - Database, embeddings cache, installed extensions:
    %LOCALAPPDATA%\\Kernl\\data
  - Per-user config (port, encryption key, LLM API keys):
    %APPDATA%\\Kernl\\.env

Stopping the kernel:
  - Close the start.bat console window, OR
  - Ctrl-C in that window.

Optional features (graph analytics, ML trading):
  - Install Neo4j Desktop from https://neo4j.com/download/
  - In the dashboard, go to /extensions, filter "Database",
    activate "Neo4j" with your Bolt URI + credentials.

Updates:
  - Replace this folder with the new version. Your data and config
    stay in %LOCALAPPDATA% / %APPDATA% — they're not touched.

Troubleshooting:
  - "Windows protected your PC" SmartScreen warning:
    click "More info" → "Run anyway". The kernel is unsigned in v0.x.
    Signed releases coming once we have an EV certificate.
  - Port 3086 already in use:
    edit %APPDATA%\\Kernl\\.env and set DASHBOARD_PORT=3088
    (or any free port).
EOF
unix2dos "$PKG_DIR/README.txt" 2>/dev/null || sed -i 's/$/\r/' "$PKG_DIR/README.txt"

# ── Zip it ──────────────────────────────────────────────────────────
# zip updates an existing archive in place rather than replacing it, so a
# stale $ZIP_OUT would keep files from previous builds (e.g. the Linux
# sharp binaries from a linux-x64 run). Start from a clean archive.
rm -f "$ZIP_OUT"
# GitHub's windows-latest runner has no `zip` — the Git-bash environment this
# script runs under ships neither. 7-Zip is preinstalled there, so prefer zip
# when present (Linux/macOS hosts, local builds) and fall back to 7z.
if command -v zip >/dev/null 2>&1; then
  ( cd "$STAGE_DIR" && zip -qr "$ZIP_OUT" "$(basename "$PKG_DIR")" )
elif command -v 7z >/dev/null 2>&1; then
  ( cd "$STAGE_DIR" && 7z a -tzip -bso0 -bsp0 "$ZIP_OUT" "$(basename "$PKG_DIR")" >/dev/null )
else
  echo "ERROR: need either 'zip' or '7z' on PATH to build the portable archive." >&2
  exit 1
fi

# Cleanup.
rm -rf "$STAGE_DIR"

echo ""
echo "✓ Windows portable built: $ZIP_OUT"
echo "  size:                   $(du -sh "$ZIP_OUT" | cut -f1)"
echo ""
echo "User instructions:"
echo "  1. Extract the zip anywhere"
echo "  2. Double-click start.bat"
echo "  3. Browser opens to http://localhost:3086"
echo ""
echo "For a proper signed .msi installer, run from CI on a Windows runner."
