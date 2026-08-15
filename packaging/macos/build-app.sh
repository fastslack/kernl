#!/bin/bash
# Build a macOS .app bundle + a portable .tar.gz for Kernl.
#
# Usage:
#   PLATFORM=darwin-arm64 packaging/macos/build-app.sh   # Apple Silicon
#   PLATFORM=darwin-x64   packaging/macos/build-app.sh   # Intel
#
# Output:
#   ./Kernl-<version>-<arch>.app/             ready-to-install bundle
#   ./Kernl-<version>-<arch>-macos.tar.gz     compressed for distribution
#
# This script runs from any host with the staged native modules — the bun
# binary and node_modules are downloaded for the target arch by stage-payload.
# Code signing + notarization happen in CI on a real macOS runner; the
# tarball produced here is the input to that signing pipeline.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default to the user's likely arch if PLATFORM unset; CI sets it explicitly.
PLATFORM="${PLATFORM:-darwin-arm64}"
case "$PLATFORM" in
  darwin-arm64) ARCH="arm64" ;;
  darwin-x64)   ARCH="x64" ;;
  *) echo "ERROR: PLATFORM must be darwin-arm64 or darwin-x64" >&2; exit 1 ;;
esac

# Stage shared payload — sets NAME, VERSION, STAGE_DIR, SRC_TREE, BUN_EXE.
# shellcheck source=../stage-payload.sh
PLATFORM="$PLATFORM" source "$SCRIPT_DIR/../stage-payload.sh"

APP_NAME="Kernl"
APP_BUNDLE="$REPO_ROOT/packaging/out/${APP_NAME}-${VERSION}-${ARCH}.app"
mkdir -p "$REPO_ROOT/packaging/out"
TARBALL="$REPO_ROOT/packaging/out/${APP_NAME}-${VERSION}-${ARCH}-macos.tar.gz"

# ── Build the .app bundle structure ──────────────────────────────────
# Per Apple's bundle spec:
#   .app/Contents/Info.plist                 metadata
#   .app/Contents/MacOS/<exe>                main entry (must match Info.plist)
#   .app/Contents/Resources/                 everything else
rm -rf "$APP_BUNDLE"
mkdir -p \
  "$APP_BUNDLE/Contents/MacOS" \
  "$APP_BUNDLE/Contents/Resources"

# Wrapper shell script — the .app's executable. It cd's to per-user data,
# sources the user's .env if present, then exec's the bundled bun against
# the bundled JS. After launch, opens the dashboard in the default browser.
cat > "$APP_BUNDLE/Contents/MacOS/kernl" <<'WRAPPER'
#!/bin/bash
# Kernl launcher for macOS — invoked when the user double-clicks the
# .app bundle. Resolves resources relative to its own location so the .app
# is fully relocatable (you can rename it, move it out of /Applications,
# whatever).
set -e

APP_DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
DATA_DIR="${KERNEL_DATA_DIR:-$HOME/Library/Application Support/Kernl}"
CONFIG_DIR="$HOME/Library/Application Support/Kernl/config"

# Put Homebrew on PATH before anything spawns a child process.
#
# A .app launched from Finder does not get the user's shell PATH — launchd
# hands it `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Homebrew installs
# to /opt/homebrew/bin on Apple Silicon and /usr/local/bin on Intel, so
# `brew install ffmpeg` produced a binary this app could not see, and subtitle
# generation died on `spawn ffmpeg ENOENT` for people who had ffmpeg sitting
# right there. Running the same bundle from a terminal worked, which is the
# tell — and the reason this went unnoticed for as long as it did.
#
# Appended, not prepended: /usr/bin still wins, so this cannot shadow a system
# tool with whatever a tap happens to have installed. Both paths are added on
# both architectures — an Intel binary under Rosetta reads /usr/local, and a
# machine can carry both prefixes.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

mkdir -p "$DATA_DIR"/{data,logs} "$CONFIG_DIR"

# First-run config seed.
if [ ! -f "$CONFIG_DIR/.env" ] && [ -f "$APP_DIR/env.example" ]; then
  cp "$APP_DIR/env.example" "$CONFIG_DIR/.env"
fi

if [ -f "$CONFIG_DIR/.env" ]; then
  set -o allexport
  # shellcheck disable=SC1091
  . "$CONFIG_DIR/.env"
  set +o allexport
fi

# Anchor SQLite + workspaces under the per-user data dir.
cd "$DATA_DIR"

# Open the dashboard once the kernel is up (background; doesn't block the
# kernel process which becomes the .app's foreground task).
#
# First run has no token the user could possibly know: the kernel generates one
# at boot and persists it next to the DB. Hand it over in the URL *fragment* —
# never sent to the server, so it stays out of logs — and the login page signs
# in with it and wipes it from the URL. Without this the first thing a new user
# sees is a login form asking for a secret nobody showed them.
(
  for _ in $(seq 1 30); do
    if curl -sf "http://localhost:${DASHBOARD_PORT:-3086}/api/manifest" >/dev/null 2>&1; then
      URL="http://localhost:${DASHBOARD_PORT:-3086}"
      TOKEN="${KERNEL_AUTH_TOKEN:-}"
      if [ -z "$TOKEN" ] && [ -f "$DATA_DIR/data/.kernel-auth-token" ]; then
        TOKEN="$(cat "$DATA_DIR/data/.kernel-auth-token")"
      fi
      if [ -n "$TOKEN" ]; then
        open "$URL/login#token=$TOKEN"
      else
        open "$URL"
      fi
      break
    fi
    sleep 1
  done
) &

# Keep a record of the boot.
#
# The wrapper has always created logs/ and nothing has ever written to it. The
# kernel logs to stdout, and stdout from a Finder launch goes nowhere — so a
# .app that failed to start left no trace at all, and the only way to see a
# boot was to know you could run this script from a terminal. That is a bad
# trade for a desktop app: the people most likely to hit a startup problem are
# the least likely to know that.
#
# tee rather than a plain redirect, so running this from a terminal still
# prints to the terminal. One rotation deep: the interesting log is almost
# always the current boot or the one before it, and an unbounded file in a
# user's Application Support directory is its own bug.
#
# 0600 because boot output can carry environment detail. The dashboard token
# is deliberately not in here — it travels in a URL fragment, which is exactly
# why that was chosen (see above) — but a log nobody expected to exist is the
# wrong place to be relaxed about permissions.
LOG_FILE="$DATA_DIR/logs/kernl.log"
[ -f "$LOG_FILE" ] && mv -f "$LOG_FILE" "$LOG_FILE.1"
: > "$LOG_FILE"
chmod 0600 "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

exec "$APP_DIR/bun" "$APP_DIR/mcp-server.js" "$@"
WRAPPER
chmod 0755 "$APP_BUNDLE/Contents/MacOS/kernl"

# Info.plist — minimum keys macOS needs to recognise the bundle.
cat > "$APP_BUNDLE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>            <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>     <string>Kernl</string>
  <key>CFBundleIdentifier</key>      <string>com.matware.kernl</string>
  <key>CFBundleVersion</key>         <string>${VERSION}</string>
  <key>CFBundleShortVersionString</key> <string>${VERSION}</string>
  <key>CFBundleExecutable</key>      <string>kernl</string>
  <key>CFBundleIconFile</key>        <string>kernl.icns</string>
  <key>CFBundlePackageType</key>     <string>APPL</string>
  <!-- 13.0, not 11.0. The vendored Bun is built against a 13.0 deployment
       target, so the app has never been able to launch on 11 or 12 whatever
       this key claimed; the bundled whisper-cli and ffmpeg are built to the
       same floor. A plist that under-states the requirement does not make an
       old Mac work, it just moves the failure from Finder ("requires macOS
       13") to a dyld error nobody can read. -->
  <key>LSMinimumSystemVersion</key>  <string>13.0</string>
  <key>LSUIElement</key>             <false/>
  <key>NSHighResolutionCapable</key> <true/>
  <key>NSHumanReadableCopyright</key> <string>© 2026 Matware. Licensed under Apache-2.0.</string>
</dict>
</plist>
EOF

# Pack the runtime tree under Contents/Resources/ so the wrapper can reach
# everything via $APP_DIR. Using `cp -a` preserves the executable bit on bun.
cp "$SRC_TREE/bin/$BUN_EXE"      "$APP_BUNDLE/Contents/Resources/bun"
cp "$SRC_TREE/bin/mcp-server.js" "$APP_BUNDLE/Contents/Resources/"
[ -d "$SRC_TREE/bin/static" ]     && cp -a "$SRC_TREE/bin/static"     "$APP_BUNDLE/Contents/Resources/"
[ -d "$SRC_TREE/bin/extensions" ] && cp -a "$SRC_TREE/bin/extensions" "$APP_BUNDLE/Contents/Resources/"
# whisper.cpp + its dylibs, as ONE flat directory beside mcp-server.js.
# media-tools.ts resolves it relative to the bundled entry point, which is
# what makes the same code work here, in /opt/kernl/bin on Linux, and at the
# zip root on Windows. Do not split the dylibs out into a lib/ folder: the GPU
# backends are dlopen-ed and the loader looks beside the executable.
[ -d "$SRC_TREE/bin/whisper" ]    && cp -a "$SRC_TREE/bin/whisper"    "$APP_BUNDLE/Contents/Resources/"
# ffmpeg + ffprobe, same idea, their own directory. Every subtitle engine
# extracts its audio with ffmpeg, so without this the .app cannot produce a
# subtitle at all — which is precisely what it did until now, since macOS also
# hides Homebrew from a Finder-launched app.
[ -d "$SRC_TREE/bin/ffmpeg" ]     && cp -a "$SRC_TREE/bin/ffmpeg"     "$APP_BUNDLE/Contents/Resources/"
cp -a "$SRC_TREE/node_modules" "$APP_BUNDLE/Contents/Resources/"
cp -a "$SRC_TREE/dashboard"    "$APP_BUNDLE/Contents/Resources/"
cp -a "$SRC_TREE/assets"       "$APP_BUNDLE/Contents/Resources/"
cp    "$SRC_TREE/package.json" "$APP_BUNDLE/Contents/Resources/"
cp    "$REPO_ROOT/packaging/rpm/files/env.example" "$APP_BUNDLE/Contents/Resources/env.example"

# Icon: a committed .icns, not one rendered here.
#
# The previous version needed iconutil AND ImageMagick, and quietly ran
# `touch kernl.icns` when either was missing. The macOS runners have neither,
# so every .app ever built carried an empty file where its icon should be —
# Info.plist pointed at kernl.icns and Finder found nothing. Nothing failed,
# which is exactly why nobody noticed.
ICNS_SRC="$REPO_ROOT/packaging/icons/kernl.icns"
if [ ! -f "$ICNS_SRC" ]; then
  echo "ERROR: missing $ICNS_SRC — the application icon is not optional." >&2
  exit 1
fi
cp "$ICNS_SRC" "$APP_BUNDLE/Contents/Resources/kernl.icns"

# ── Tarball for distribution ─────────────────────────────────────────
# cd into the directory that actually holds the bundle — it lives in
# packaging/out/, not at the repo root, so tar'ing basename from $REPO_ROOT
# fails with "Cannot stat". Deriving the directory from $APP_BUNDLE keeps the
# two in step if the output location ever moves.
( cd "$(dirname "$APP_BUNDLE")" && tar czf "$TARBALL" "$(basename "$APP_BUNDLE")" )

# Cleanup staging.
rm -rf "$STAGE_DIR"

echo ""
echo "✓ macOS bundle built: $APP_BUNDLE"
echo "  size:               $(du -sh "$APP_BUNDLE" | cut -f1)"
echo "✓ Distribution tar:   $TARBALL"
echo "  size:               $(du -sh "$TARBALL" | cut -f1)"
echo ""
echo "User instructions (no signing yet):"
echo "  tar xzf $(basename "$TARBALL")"
echo "  cp -r $(basename "$APP_BUNDLE") /Applications/"
echo "  # First launch: right-click → Open (bypass Gatekeeper warning)"
echo "  # Subsequent launches: just double-click"
echo ""
echo "For signed/notarized .app + .dmg, run from CI on a macOS runner —"
echo "see .github/workflows/release.yml."
