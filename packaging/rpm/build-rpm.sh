#!/bin/bash
# Build a self-contained RPM for Kernl (Fedora/RHEL/CentOS x86_64).
#
# Usage (from repo root):  packaging/rpm/build-rpm.sh
#
# Outputs:  ~/rpmbuild/RPMS/x86_64/kernl-<version>-1.x86_64.rpm
#           (no %{?dist} suffix — install.sh resolves this exact name)

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

# Icon: a committed 256×256 PNG, not something rendered at build time.
#
# This used to try ImageMagick against `dashboard/static/favicon.svg` — a path
# that does not exist, the file lives under services/ — and fall back to a
# 1×1 transparent pixel so rpmbuild would not choke. It never choked, and every
# package ever built shipped that pixel as its application icon. A silent
# fallback for a missing asset is how you ship a blank icon and never find out.
ICON_SRC="$REPO_ROOT/packaging/icons/kernl.png"
if [ ! -f "$ICON_SRC" ]; then
  echo "ERROR: missing $ICON_SRC — the application icon is not optional." >&2
  exit 1
fi
cp "$ICON_SRC" "$SRC_TREE/packaging/kernl.png"

# RPM forbids '-' in Version, so a prerelease like 0.2.0-rc.1 cannot go there:
# rpmbuild aborts with "Illegal char '-'". The convention is to keep the base
# version and encode the prerelease in Release with a leading 0, which also
# makes it sort BEFORE the eventual final build:
#
#   0.2.0-rc.1  →  Version: 0.2.0   Release: 0.rc.1
#   0.2.0       →  Version: 0.2.0   Release: 1
#
# Anything after the first '-' is the prerelease; remaining '-' become '_',
# which Release does allow.
RPM_VERSION="${VERSION%%-*}"
if [ "$RPM_VERSION" != "$VERSION" ]; then
  RPM_RELEASE="0.${VERSION#*-}"
  RPM_RELEASE="${RPM_RELEASE//-/_}"
else
  RPM_RELEASE="1"
fi

# ── Tarball ────────────────────────────────────────────────────────
# The spec's %prep resolves both the source and the unpacked directory as
# %{name}-%{version}, so on a prerelease build the staged tree has to be
# renamed to the RPM's idea of the version (0.2.0), not npm's (0.2.0-rc.1).
RPMBUILD_HOME="${RPMBUILD_HOME:-$HOME/rpmbuild}"
mkdir -p "$RPMBUILD_HOME"/{SOURCES,SPECS,BUILD,RPMS,SRPMS}
if [ "$RPM_VERSION" != "$VERSION" ]; then
  mv "$STAGE_DIR/${NAME}-${VERSION}" "$STAGE_DIR/${NAME}-${RPM_VERSION}"
fi
TARBALL="$RPMBUILD_HOME/SOURCES/${NAME}-${RPM_VERSION}.tar.gz"
tar --owner=0 --group=0 -czf "$TARBALL" -C "$STAGE_DIR" "${NAME}-${RPM_VERSION}"
echo "▶ source tarball: $TARBALL ($(du -sh "$TARBALL" | cut -f1))"

# The spec carries a placeholder Version — stamp it from the staged VERSION
# (which comes from services/kernel/package.json) so a v0.2.0 tag cannot
# silently produce a 0.1.0 RPM that install.sh will then fail to find.
sed -e "s/^Version:.*/Version:        ${RPM_VERSION}/" \
    -e "s/^Release:.*/Release:        ${RPM_RELEASE}%{?dist}/" \
    "$SPEC_FILE" > "$RPMBUILD_HOME/SPECS/${NAME}.spec"

echo "▶ rpmbuild -bb"
# dist is forced empty on purpose: install.sh resolves the asset by exact
# filename (kernl-<version>-1.x86_64.rpm), so a builder-dependent .fc41/.el9
# suffix would make the published asset unreachable.
rpmbuild --define "_topdir $RPMBUILD_HOME" --define "dist %{nil}" \
         -bb "$RPMBUILD_HOME/SPECS/${NAME}.spec"

RPM_OUT="$(find "$RPMBUILD_HOME/RPMS" -name "${NAME}-${RPM_VERSION}-${RPM_RELEASE}*.rpm" -newer "$TARBALL" | head -1)"
rm -rf "$STAGE_DIR"

echo ""
echo "✓ RPM built: $RPM_OUT"
echo "  size:      $(du -sh "$RPM_OUT" | cut -f1)"
echo ""
echo "Install:    sudo dnf install \"$RPM_OUT\""
