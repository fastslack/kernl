#!/bin/bash
# Build a self-contained .deb for Kernl (Debian/Ubuntu/Mint amd64).
#
# Usage (from repo root):  packaging/deb/build-deb.sh
#
# Output: ./kernl_<version>-1_amd64.deb
#
# This script does NOT require dpkg-deb / fpm to be installed — the .deb
# format is just an `ar` archive of three members:
#   debian-binary           (constant text "2.0\n")
#   control.tar.zst         (control + postinst + postrm)
#   data.tar.zst            (the payload tree, mirroring the install layout)
# We assemble those three with `ar`, `tar`, and `zstd` so this script runs
# on Fedora/Arch/Alpine just as well as Debian.
#
# The control file's Installed-Size and md5sums are computed from the same
# staged tree the RPM consumes, so the two packages stay byte-identical
# at the application layer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Files reused from the RPM packaging (wrapper, service, desktop, env, icon).
RPM_FILES_DIR="$SCRIPT_DIR/../rpm/files"

# Stage the shared payload — sets NAME, VERSION, STAGE_DIR, SRC_TREE.
# shellcheck source=../stage-payload.sh
source "$SCRIPT_DIR/../stage-payload.sh"

PKG_REVISION="${PKG_REVISION:-1}"

# Debian encodes a prerelease with '~', not '-'. The distinction is not
# cosmetic: '~' sorts BEFORE the empty string, so 0.2.0~rc.1 < 0.2.0, while
# 0.2.0-rc.1 would sort AFTER it — apt would treat the release candidate as
# newer than the final release and refuse to upgrade off it. Only the first
# '-' is the prerelease separator; the trailing -$PKG_REVISION stays.
DEB_VERSION="${VERSION/-/\~}"
DEB_NAME="${NAME}_${DEB_VERSION}-${PKG_REVISION}_amd64.deb"
DEB_OUT="$REPO_ROOT/packaging/out/$DEB_NAME"
mkdir -p "$REPO_ROOT/packaging/out"

# ── 1) Mirror the install layout under $SRC_TREE/data/ ────────────
# A .deb's data.tar contains files at their final filesystem paths
# (`./usr/bin/kernl`, etc.). Build that mirror by copying from the
# already-staged tree.
DATA_ROOT="$STAGE_DIR/data"
rm -rf "$DATA_ROOT"
mkdir -p \
  "$DATA_ROOT/opt/kernl" \
  "$DATA_ROOT/usr/bin" \
  "$DATA_ROOT/usr/lib/systemd/user" \
  "$DATA_ROOT/usr/share/applications" \
  "$DATA_ROOT/usr/share/icons/hicolor/256x256/apps" \
  "$DATA_ROOT/etc/kernl"

# Application tree under /opt/kernl.
cp -a "$SRC_TREE/bin"            "$DATA_ROOT/opt/kernl/"
cp -a "$SRC_TREE/node_modules"   "$DATA_ROOT/opt/kernl/"
cp -a "$SRC_TREE/dashboard"      "$DATA_ROOT/opt/kernl/"
cp -a "$SRC_TREE/assets"         "$DATA_ROOT/opt/kernl/"
cp    "$SRC_TREE/package.json"   "$DATA_ROOT/opt/kernl/"

# Wrapper, systemd unit, desktop entry, env template, icon.
install -m 0755 "$RPM_FILES_DIR/kernl.sh"      "$DATA_ROOT/usr/bin/kernl"
install -m 0644 "$RPM_FILES_DIR/kernl.service" "$DATA_ROOT/usr/lib/systemd/user/kernl.service"
install -m 0644 "$RPM_FILES_DIR/kernl.desktop" "$DATA_ROOT/usr/share/applications/kernl.desktop"
install -m 0644 "$RPM_FILES_DIR/env.example"       "$DATA_ROOT/etc/kernl/env.example"

# Icon — same fallback chain as the RPM build.
if [ -f "$RPM_FILES_DIR/kernl.png" ]; then
  install -m 0644 "$RPM_FILES_DIR/kernl.png" \
    "$DATA_ROOT/usr/share/icons/hicolor/256x256/apps/kernl.png"
elif [ -f "$REPO_ROOT/services/dashboard/static/favicon.svg" ] && command -v convert &>/dev/null; then
  convert -background none -density 384 -resize 256x256 \
    "$REPO_ROOT/services/dashboard/static/favicon.svg" \
    "$DATA_ROOT/usr/share/icons/hicolor/256x256/apps/kernl.png"
elif [ -f "$REPO_ROOT/services/dashboard/static/favicon.png" ]; then
  install -m 0644 "$REPO_ROOT/services/dashboard/static/favicon.png" \
    "$DATA_ROOT/usr/share/icons/hicolor/256x256/apps/kernl.png"
else
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' \
    > "$DATA_ROOT/usr/share/icons/hicolor/256x256/apps/kernl.png"
fi

# ── 2) Build control.tar (control + maintainer scripts + md5sums) ──
CONTROL_ROOT="$STAGE_DIR/control"
rm -rf "$CONTROL_ROOT"
mkdir -p "$CONTROL_ROOT"

# Installed-Size in KB — what dpkg expects.
SIZE_KB="$(du -sk "$DATA_ROOT" | cut -f1)"
# The control file's Version must match the filename's, tilde and all, or dpkg
# installs a package whose recorded version disagrees with what apt resolved.
sed -e "s/__VERSION__/${DEB_VERSION}-${PKG_REVISION}/g" \
    -e "s/__SIZE_KB__/${SIZE_KB}/g" \
    "$SCRIPT_DIR/control.template" > "$CONTROL_ROOT/control"

# Maintainer scripts (post-install / post-remove hooks).
install -m 0755 "$SCRIPT_DIR/postinst" "$CONTROL_ROOT/postinst"
install -m 0755 "$SCRIPT_DIR/postrm"   "$CONTROL_ROOT/postrm"

# md5sums file — list of "<md5>  <relative-path>" for every file in data/.
# dpkg uses this to detect locally-modified config files on upgrade.
( cd "$DATA_ROOT" && find . -type f -exec md5sum {} + | sed 's|  \./|  |' ) \
  > "$CONTROL_ROOT/md5sums"

# Mark the env template as a conffile so dpkg preserves user edits.
echo "/etc/kernl/env.example" > "$CONTROL_ROOT/conffiles"

# ── 3) Tarball the two trees ───────────────────────────────────────
TAR_DATA="$STAGE_DIR/data.tar.zst"
TAR_CONTROL="$STAGE_DIR/control.tar.zst"
DEB_BINARY="$STAGE_DIR/debian-binary"

# data.tar.zst — payload at filesystem paths.
( cd "$DATA_ROOT" && tar --owner=0 --group=0 -cf - . | zstd -19 -q -o "$TAR_DATA" )

# control.tar.zst — control metadata.
( cd "$CONTROL_ROOT" && tar --owner=0 --group=0 -cf - . | zstd -19 -q -o "$TAR_CONTROL" )

# debian-binary — must be exactly "2.0\n".
printf '2.0\n' > "$DEB_BINARY"

# ── 4) Assemble the .deb (an `ar` archive in MEMBER ORDER) ────────
# Order matters: dpkg-deb refuses .deb files with members in any other order.
rm -f "$DEB_OUT"
( cd "$STAGE_DIR" && ar rcD "$DEB_OUT" debian-binary control.tar.zst data.tar.zst )

# Cleanup staging.
rm -rf "$STAGE_DIR"

echo ""
echo "✓ DEB built: $DEB_OUT"
echo "  size:      $(du -sh "$DEB_OUT" | cut -f1)"
echo ""
echo "Install:    sudo apt install \"$DEB_OUT\""
echo "            (or: sudo dpkg -i \"$DEB_OUT\" && sudo apt --fix-broken install)"
echo ""
echo "Verify:     dpkg-deb -I \"$DEB_OUT\"        # show metadata"
echo "            dpkg-deb -c \"$DEB_OUT\" | head # list payload"
