#!/bin/bash
# Build a Windows MSI installer for Kernl using WiX 3.x.
#
# Runs ON Windows (in CI via windows-latest runner), or on Linux/Mac with
# wixl from the msitools project (sudo dnf install msitools).
#
# This script orchestrates 3 steps:
#   1. heat.exe — scans the staged tree and emits a `harvested.wxs`
#      fragment listing every file as a Component.
#   2. candle.exe — compiles product.wxs + harvested.wxs into .wixobj.
#   3. light.exe — links the .wixobj objects into the final .msi,
#      embedding the cab archive of all files.
#
# Output: ./Kernl-<version>-windows-x64.msi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=../stage-payload.sh
PLATFORM="win-x64" source "$SCRIPT_DIR/../stage-payload.sh"

MSI_OUT="$REPO_ROOT/packaging/out/${NAME}-${VERSION}-windows-x64.msi"
mkdir -p "$REPO_ROOT/packaging/out"
PKG_DIR="$STAGE_DIR/install"

# ── 1) Lay out the install tree exactly how it'll appear on disk ──
mkdir -p "$PKG_DIR"
cp "$SRC_TREE/bin/bun.exe"       "$PKG_DIR/bun.exe"
cp "$SRC_TREE/bin/mcp-server.js" "$PKG_DIR/mcp-server.js"
[ -d "$SRC_TREE/bin/static" ]     && cp -a "$SRC_TREE/bin/static"     "$PKG_DIR/"
[ -d "$SRC_TREE/bin/extensions" ] && cp -a "$SRC_TREE/bin/extensions" "$PKG_DIR/"
cp -a "$SRC_TREE/node_modules" "$PKG_DIR/"
cp -a "$SRC_TREE/dashboard"    "$PKG_DIR/"
cp -a "$SRC_TREE/assets"       "$PKG_DIR/"
cp    "$SRC_TREE/package.json" "$PKG_DIR/"
cp    "$REPO_ROOT/packaging/rpm/files/env.example" "$PKG_DIR/env.example"

# Copy start.bat — same one the portable .zip ships.
cp "$REPO_ROOT/packaging/windows/start.bat" "$PKG_DIR/start.bat" 2>/dev/null || true

# ── 2) Run WiX 3.x — must be on the PATH (CI installs via choco) ──
if ! command -v candle.exe &>/dev/null || ! command -v light.exe &>/dev/null; then
  echo "ERROR: WiX 3.x (candle.exe / light.exe) not found on PATH." >&2
  echo "       This script runs on Windows runners only." >&2
  echo "       Install: choco install wixtoolset" >&2
  exit 1
fi

HEAT="${HEAT:-heat.exe}"
CANDLE="${CANDLE:-candle.exe}"
LIGHT="${LIGHT:-light.exe}"
HARVESTED="$STAGE_DIR/harvested.wxs"

# heat scans the install dir and emits a .wxs fragment with every file
# listed as a Component+File. -gg auto-generates GUIDs deterministically;
# -srd suppresses the root directory; -dr targets it at INSTALLDIR.
echo "▶ heat: harvesting $PKG_DIR"
"$HEAT" dir "$PKG_DIR" \
  -nologo -gg -sfrag -srd -sreg -scom \
  -dr INSTALLDIR \
  -cg ApplicationFiles \
  -var var.SourceDir \
  -out "$HARVESTED"

# MSI has no way to express a prerelease. Product/@Version must be numeric
# x.x.x.x with each field ≤ 65534, so a tag like 0.2.0-rc.1 aborts candle with:
#
#     error CNDL0108 : The Product/@Version attribute's value, '0.2.0-rc.1',
#     is not a valid version.
#
# Windows Installer only compares the first three fields for upgrade decisions
# anyway, so the prerelease suffix is dropped here and survives only in the
# artifact's filename ($MSI_OUT keeps the full version). The consequence is
# that 0.2.0-rc.1 and 0.2.0 look identical to the upgrade logic — acceptable,
# because a prerelease is meant to be replaced by its final build.
MSI_VERSION="${VERSION%%-*}"
[ "$MSI_VERSION" != "$VERSION" ] && \
  echo "▶ MSI ProductVersion: $MSI_VERSION (prerelease suffix dropped from $VERSION)"

# Compile static product.wxs + harvested fragment.
echo "▶ candle: compiling .wxs → .wixobj"
"$CANDLE" -nologo -arch x64 \
  -dVersion="$MSI_VERSION" \
  -dSourceDir="$PKG_DIR" \
  -out "$STAGE_DIR/" \
  "$REPO_ROOT/packaging/windows/product.wxs" \
  "$HARVESTED"

# Link into the final MSI. -ext WixUIExtension is needed because product.wxs
# references the WixUI_InstallDir dialog set.
echo "▶ light: linking → .msi"
"$LIGHT" -nologo \
  -ext WixUIExtension \
  -out "$MSI_OUT" \
  "$STAGE_DIR/product.wixobj" \
  "$STAGE_DIR/harvested.wixobj"

# Cleanup.
rm -rf "$STAGE_DIR"

echo ""
echo "✓ MSI built: $MSI_OUT"
echo "  size:      $(du -sh "$MSI_OUT" | cut -f1)"
echo ""
echo "Install:    msiexec /i $(basename "$MSI_OUT")        (silent: /qn)"
echo "Uninstall:  msiexec /x $(basename "$MSI_OUT")"
