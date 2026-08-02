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
(
  for _ in $(seq 1 30); do
    if curl -sf "http://localhost:${DASHBOARD_PORT:-3086}/api/manifest" >/dev/null 2>&1; then
      open "http://localhost:${DASHBOARD_PORT:-3086}"
      break
    fi
    sleep 1
  done
) &

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
  <key>LSMinimumSystemVersion</key>  <string>11.0</string>
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
cp -a "$SRC_TREE/node_modules" "$APP_BUNDLE/Contents/Resources/"
cp -a "$SRC_TREE/dashboard"    "$APP_BUNDLE/Contents/Resources/"
cp -a "$SRC_TREE/assets"       "$APP_BUNDLE/Contents/Resources/"
cp    "$SRC_TREE/package.json" "$APP_BUNDLE/Contents/Resources/"
cp    "$REPO_ROOT/packaging/rpm/files/env.example" "$APP_BUNDLE/Contents/Resources/env.example"

# Icon — generate from the SVG favicon when iconutil is available
# (macOS host); else placeholder. CI overrides this with the proper .icns.
if command -v iconutil &>/dev/null && [ -f "$REPO_ROOT/services/dashboard/static/favicon.svg" ]; then
  ICONSET="$STAGE_DIR/kernl.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512 1024; do
    convert -background none -density "$((size * 4))" -resize "${size}x${size}" \
      "$REPO_ROOT/services/dashboard/static/favicon.svg" "$ICONSET/icon_${size}x${size}.png" 2>/dev/null || true
  done
  iconutil -c icns "$ICONSET" -o "$APP_BUNDLE/Contents/Resources/kernl.icns" 2>/dev/null || true
elif [ -f "$REPO_ROOT/services/dashboard/static/favicon.svg" ] && command -v convert &>/dev/null; then
  # Fallback: render a 512x512 PNG and cp as .icns (macOS will warn but display)
  convert -background none -density 1024 -resize 512x512 \
    "$REPO_ROOT/services/dashboard/static/favicon.svg" "$APP_BUNDLE/Contents/Resources/kernl.icns" 2>/dev/null || \
    touch "$APP_BUNDLE/Contents/Resources/kernl.icns"
else
  touch "$APP_BUNDLE/Contents/Resources/kernl.icns"
fi

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
