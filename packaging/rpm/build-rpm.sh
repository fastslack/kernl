#!/bin/bash
# Build a self-contained RPM for Kernl (Fedora/RHEL/CentOS x86_64).
#
# Usage (from repo root):  packaging/rpm/build-rpm.sh
#
# Outputs:  ~/rpmbuild/RPMS/x86_64/kernl-<version>-1.fc*.x86_64.rpm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SPEC_FILE="$SCRIPT_DIR/kernl.spec"
FILES_DIR="$SCRIPT_DIR/files"

# Stage the shared payload — sets NAME, VERSION, STAGE_DIR, SRC_TREE.
# shellcheck source=../stage-payload.sh
source "$SCRIPT_DIR/../stage-payload.sh"

# Per-format glue files into the staged tree.
cp "$FILES_DIR/kernl.sh"       "$SRC_TREE/packaging/kernl.sh"
cp "$FILES_DIR/kernl.service"  "$SRC_TREE/packaging/kernl.service"
cp "$FILES_DIR/kernl.desktop"  "$SRC_TREE/packaging/kernl.desktop"
cp "$FILES_DIR/env.example"        "$SRC_TREE/packaging/env.example"

# Icon (256×256 PNG) — render from the SVG favicon if ImageMagick is around;
# fall back to a tiny valid PNG so rpmbuild doesn't choke on the missing file.
if [ -f "$FILES_DIR/kernl.png" ]; then
  cp "$FILES_DIR/kernl.png" "$SRC_TREE/packaging/kernl.png"
elif [ -f "dashboard/static/favicon.svg" ] && command -v convert &>/dev/null; then
  convert -background none -density 384 -resize 256x256 \
    dashboard/static/favicon.svg "$SRC_TREE/packaging/kernl.png"
elif [ -f "dashboard/static/favicon.png" ]; then
  cp "dashboard/static/favicon.png" "$SRC_TREE/packaging/kernl.png"
else
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > "$SRC_TREE/packaging/kernl.png"
fi

# ── Tarball + rpmbuild ─────────────────────────────────────────────
RPMBUILD_HOME="${RPMBUILD_HOME:-$HOME/rpmbuild}"
mkdir -p "$RPMBUILD_HOME"/{SOURCES,SPECS,BUILD,RPMS,SRPMS}
TARBALL="$RPMBUILD_HOME/SOURCES/${NAME}-${VERSION}.tar.gz"
tar --owner=0 --group=0 -czf "$TARBALL" -C "$STAGE_DIR" "${NAME}-${VERSION}"
echo "▶ source tarball: $TARBALL ($(du -sh "$TARBALL" | cut -f1))"

cp "$SPEC_FILE" "$RPMBUILD_HOME/SPECS/${NAME}.spec"
echo "▶ rpmbuild -bb"
rpmbuild --define "_topdir $RPMBUILD_HOME" -bb "$RPMBUILD_HOME/SPECS/${NAME}.spec"

RPM_OUT="$(find "$RPMBUILD_HOME/RPMS" -name "${NAME}-${VERSION}-*.rpm" -newer "$TARBALL" | head -1)"
rm -rf "$STAGE_DIR"

echo ""
echo "✓ RPM built: $RPM_OUT"
echo "  size:      $(du -sh "$RPM_OUT" | cut -f1)"
echo ""
echo "Install:    sudo dnf install \"$RPM_OUT\""
