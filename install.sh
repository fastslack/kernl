#!/bin/sh
# Install or update Kernl.
#
#   curl -fsSL https://raw.githubusercontent.com/fastslack/kernl/stable/install.sh | sh
#
# The same command does both, on purpose. An update path that differs from the
# install path is a second thing to document, a second thing to get wrong, and
# the reason people end up running a build from last week without knowing it.
# Re-run this and you are on the newest release; that is the whole contract.
#
# It reads the latest published GitHub release and picks the asset matching
# this machine. Package managers do the actual installing on Linux, because
# fighting dpkg or rpm over a file they own is how you get a half-installed
# system. macOS gets its .app replaced in place.
#
# POSIX sh, no bash-isms: this runs on whatever /bin/sh a fresh machine has.

set -eu

REPO="${KERNL_REPO:-fastslack/kernl}"
API="https://api.github.com/repos/$REPO/releases/latest"

say()  { printf '  %s\n' "$*"; }
die()  { printf '\nkernl: %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "this needs $1, which is not installed."
}

need curl

printf '\nKernl installer\n\n'

# ── Which release? ─────────────────────────────────────────────────────────
# No jq: a one-line install that requires installing something else first is
# not a one-line install. The tag is a plain string in the JSON.
say "Looking up the latest release…"
JSON="$(curl -fsSL "$API" 2>/dev/null || true)"
[ -n "$JSON" ] || die "could not reach GitHub. Are you online?"

TAG="$(printf '%s' "$JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$TAG" ] || die "no published release found for $REPO yet."
VERSION="${TAG#v}"
say "Latest is $TAG"

# Already on it? Say so and stop — re-running should be safe and boring.
if command -v kernl >/dev/null 2>&1; then
  CURRENT="$(kernl --version 2>/dev/null | tr -d 'v' | head -1 || true)"
  if [ -n "$CURRENT" ] && [ "$CURRENT" = "$VERSION" ]; then
    printf '\nAlready on %s. Nothing to do.\n\n' "$VERSION"
    exit 0
  fi
  [ -n "$CURRENT" ] && say "You have $CURRENT"
fi

# ── Which asset? ───────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

# Pick the asset by matching what the release actually published, rather than
# rebuilding its filename from a template.
#
# The template version broke on the very first real release: packages carry a
# package-release number the version string does not know about, so
# `kernl-0.2.0.rpm` was really `kernl-0.2.0-1.x86_64.rpm` and the download
# 404'd. Anything that reconstructs a name has to be kept in step with the
# packagers forever; matching a suffix does not.
pick_asset() {
  printf '%s' "$JSON" \
    | tr ',' '\n' \
    | sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | grep -i -- "$1" \
    | head -1
}

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64|amd64) : ;;
      *) die "no Linux build for $ARCH yet — only x86_64." ;;
    esac
    # Prefer the packaging the machine already understands, so updates and
    # removal go through the tool that owns /opt/kernl.
    if command -v dpkg >/dev/null 2>&1; then
      URL="$(pick_asset '_amd64\.deb$')"; KIND="deb"
    elif command -v rpm >/dev/null 2>&1; then
      URL="$(pick_asset '\.x86_64\.rpm$')"; KIND="rpm"
    else
      die "no dpkg or rpm found. Grab a package from https://github.com/$REPO/releases/latest"
    fi
    ;;
  Darwin)
    case "$ARCH" in
      arm64)  URL="$(pick_asset 'arm64-macos\.tar\.gz$')" ;;
      x86_64) URL="$(pick_asset 'x64-macos\.tar\.gz$')" ;;
      *) die "no macOS build for $ARCH." ;;
    esac
    KIND="macos"
    ;;
  *)
    die "Windows is not installable from a shell script — download the .msi from
    https://github.com/$REPO/releases/latest"
    ;;
esac

[ -n "${URL:-}" ] || die "release $TAG has no build for this platform.
    See https://github.com/$REPO/releases/tag/$TAG"
ASSET="${URL##*/}"
TMP="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '$TMP'" EXIT INT TERM

say "Downloading $ASSET"
curl -fsSL -o "$TMP/$ASSET" "$URL" \
  || die "could not download $ASSET.
    The release may not carry a build for this platform:
    https://github.com/$REPO/releases/tag/$TAG"

# ── Install ────────────────────────────────────────────────────────────────
# sudo only when not already root, so this works in a container too.
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

case "$KIND" in
  deb)
    say "Installing (you may be asked for your password)…"
    $SUDO dpkg -i "$TMP/$ASSET" >/dev/null 2>&1 \
      || $SUDO apt-get install -y -f >/dev/null 2>&1 \
      || die "dpkg failed. Try: sudo dpkg -i $TMP/$ASSET"
    ;;
  rpm)
    say "Installing (you may be asked for your password)…"
    # `install` upgrades an existing package in both dnf and rpm.
    $SUDO rpm -Uvh "$TMP/$ASSET" >/dev/null 2>&1 \
      || die "rpm failed. Try: sudo rpm -Uvh $TMP/$ASSET"
    ;;
  macos)
    say "Installing to /Applications…"
    tar xzf "$TMP/$ASSET" -C "$TMP" || die "could not unpack $ASSET"
    APP="$(find "$TMP" -maxdepth 2 -name '*.app' -print -quit)"
    [ -n "$APP" ] || die "no .app inside $ASSET"
    # Replace rather than merge: leftovers from an older layout inside a
    # bundle are their own class of bug, and the user's data lives in
    # ~/Library/Application Support/Kernl, not in here.
    $SUDO rm -rf "/Applications/$(basename "$APP")"
    $SUDO cp -a "$APP" /Applications/ || die "could not copy into /Applications"
    ;;
esac

printf '\nKernl %s installed.\n' "$VERSION"
case "$KIND" in
  macos)
    printf 'Open it from /Applications.\n'
    # Say this BEFORE they double-click and get told the developer cannot be
    # verified — a security warning nobody warned you about reads as "this is
    # malware", and the reflex is to delete it. Checked rather than assumed, so
    # the notice disappears by itself the day the release is signed.
    if ! codesign --verify --deep --strict /Applications/Kernl.app >/dev/null 2>&1; then
      printf '\n'
      printf 'Note: this build is not signed by Apple, so the first launch is blocked.\n'
      printf 'To allow it: System Settings → Privacy & Security → scroll down →\n'
      printf '"Open Anyway". You only do this once.\n'
    fi
    printf '\n'
    ;;
  *) printf 'Start it with:  kernl\n\n' ;;
esac
