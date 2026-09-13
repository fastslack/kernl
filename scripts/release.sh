#!/usr/bin/env bash
#
# Cut a Kernl release.
#
# The process used to live only in shell history and in the shape of the commit
# graph: bump the version on dev, merge dev into stable, tag the merge, push.
# Miss a step and the failure is not local — `.github/workflows/release.yml`
# refuses to build when the tag and services/kernel/package.json disagree, and
# install.sh resolves download URLs from the tag while every packager derives
# them from package.json. A drift there produces a green build, a published
# release, and a 404 for anyone installing it.
#
# So this does the whole sequence, in order, with the checks that catch the
# mistakes that are expensive to find later.
#
# Usage:
#   scripts/release.sh 0.2.3            prepare locally, stop before pushing
#   scripts/release.sh 0.2.3 --push     …and push, which starts the CI build
#   scripts/release.sh --cask 0.2.3     after CI: point the Homebrew cask at
#                                       the DMGs that were actually published
#
# Preparing is deliberately separate from pushing. Pushing the tag publishes a
# release to everyone; everything before it is a local commit you can undo with
# `scripts/release.sh --undo 0.2.3`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PKG="services/kernel/package.json"
LOCK="services/kernel/package-lock.json"
# Manifests that carry a version but are not the source of truth. They are not
# published anywhere and nothing reads them at runtime — but they sat at 0.1.0
# while the kernel reached 0.2.6, which makes a checkout look like three
# projects at three ages, and sends anyone debugging a version mismatch to the
# wrong file. Bumped here so "the version" stays one number.
EXTRA_MANIFESTS=(
  "services/dashboard/package.json"
  "services/dashboard/package-lock.json"
  "apps/desktop/package.json"
)
CASK="packaging/homebrew/kernl.rb"
REPO_SLUG="fastslack/kernl"
DEV_BRANCH="dev"
STABLE_BRANCH="stable"

die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }

current_version() { node -p "require('./$PKG').version"; }

# Rewrites just the top-level "version" of a JSON file. `npm version` would do
# package.json and the lock together, but it also rewrites the whole lockfile
# from the registry, which turns a one-line release into an unreviewable diff.
set_json_version() {
  local file="$1" version="$2"
  node - "$file" "$version" <<'NODE'
const fs = require("node:fs");
const [file, version] = process.argv.slice(2);
const raw = fs.readFileSync(file, "utf8");
const data = JSON.parse(raw);
data.version = version;
// npm keeps a second copy for the root package; a lockfile that disagrees with
// its own package.json makes `npm ci` refuse to run.
if (data.packages && data.packages[""]) data.packages[""].version = version;
// Preserve the trailing newline the file already had.
fs.writeFileSync(file, JSON.stringify(data, null, 2) + (raw.endsWith("\n") ? "\n" : ""));
NODE
}

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

# ── Mode: --cask ─────────────────────────────────────────────────────────────
# Runs AFTER the CI build. The cask pins the sha256 of each DMG, and those only
# exist once the artifacts are published — which is why it is a second commit
# rather than part of the release commit.
cask_mode() {
  local version="$1"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must look like 1.2.3, got '$version'"
  command -v curl >/dev/null || die "curl is required"
  command -v shasum >/dev/null || command -v sha256sum >/dev/null || die "need shasum or sha256sum"

  local base="https://github.com/$REPO_SLUG/releases/download/v$version"
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  local -A sums
  for arch in arm64 x64; do
    local file="Kernl-$version-$arch.dmg"
    step "Fetching $file"
    curl -fsSL --retry 3 -o "$tmp/$file" "$base/$file" \
      || die "could not download $file — is the release published and were the DMGs attached?"
    if command -v sha256sum >/dev/null; then
      sums[$arch]="$(sha256sum "$tmp/$file" | cut -d' ' -f1)"
    else
      sums[$arch]="$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)"
    fi
    ok "$arch  ${sums[$arch]}"
  done

  step "Updating $CASK"
  # Anchored to the cask's own keys so this cannot wander into another string.
  sed -i.bak \
    -e "s|^  version \".*\"|  version \"$version\"|" \
    -e "s|^  sha256 arm:   \".*\"|  sha256 arm:   \"${sums[arm64]}\"|" \
    -e "s|^         intel: \".*\"|         intel: \"${sums[x64]}\"|" \
    "$CASK"
  rm -f "$CASK.bak"
  grep -E '^  version|sha256 arm|intel:' "$CASK"

  git add "$CASK"
  git commit -q -m "Point the cask at $version"
  ok "committed — push $DEV_BRANCH when you are ready"
}

# ── Mode: --undo ─────────────────────────────────────────────────────────────
# Only safe while nothing has been pushed; that is exactly the window this is
# for, so it refuses once the tag exists on the remote.
undo_mode() {
  local version="$1" tag="v$1"
  if git ls-remote --exit-code --tags origin "$tag" >/dev/null 2>&1; then
    die "$tag is already on the remote — undoing it would rewrite published history"
  fi
  step "Removing local $tag and the release commits"
  git tag -d "$tag" 2>/dev/null || warn "no local tag $tag"
  git checkout -q "$STABLE_BRANCH"
  git reset --hard -q "origin/$STABLE_BRANCH"
  git checkout -q "$DEV_BRANCH"
  git reset --hard -q "origin/$DEV_BRANCH"
  ok "back to the pushed state of $DEV_BRANCH and $STABLE_BRANCH"
}

# ── Main ─────────────────────────────────────────────────────────────────────
[[ $# -ge 1 ]] || usage
case "${1:-}" in
  --cask) [[ $# -eq 2 ]] || usage; cask_mode "$2"; exit 0 ;;
  --undo) [[ $# -eq 2 ]] || usage; undo_mode "$2"; exit 0 ;;
  -h|--help) usage ;;
esac

VERSION="$1"; shift
PUSH=0
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;   # for a re-run after tests already passed
    *) die "unknown option: $arg" ;;
  esac
done

TAG="v$VERSION"

step "Checks"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
  || die "version must look like 1.2.3 or 1.2.3-rc.1, got '$VERSION'"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "$DEV_BRANCH" ]] || die "run this from $DEV_BRANCH (currently on $BRANCH)"

[[ -z "$(git status --porcelain)" ]] \
  || die "working tree is dirty — commit or stash first, so the release commit contains only the version bump"

git show-ref --verify --quiet "refs/heads/$STABLE_BRANCH" \
  || die "no local $STABLE_BRANCH branch — create it from origin/$STABLE_BRANCH first"

CURRENT="$(current_version)"
[[ "$CURRENT" != "$VERSION" ]] || die "$PKG is already $VERSION"
# Sort check rather than a numeric compare so 0.2.10 > 0.2.9 holds.
[[ "$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -1)" == "$VERSION" ]] \
  || die "$VERSION is older than the current $CURRENT"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists locally"
if git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists on the remote"
fi
ok "on $DEV_BRANCH, clean, $CURRENT → $VERSION, $TAG is free"

if [[ "$SKIP_TESTS" -eq 0 ]]; then
  step "Type-check and tests"
  # CI's version-check catches a version that drifted; nothing there catches a
  # release that does not run. Ten minutes here beats a published bad build.
  ( cd services/kernel && npx tsc --noEmit ) || die "type-check failed"
  ( cd services/kernel && bun test ) || die "tests failed"
  ok "green"
fi

step "Bumping to $VERSION"
set_json_version "$PKG" "$VERSION"
[[ -f "$LOCK" ]] && set_json_version "$LOCK" "$VERSION"
git add "$PKG" ${LOCK:+"$LOCK"}
for m in "${EXTRA_MANIFESTS[@]}"; do
  [[ -f "$m" ]] || continue
  set_json_version "$m" "$VERSION"
  git add "$m"
done
git commit -q -m "Release $VERSION"
ok "$(git log --oneline -1)"

step "Merging $DEV_BRANCH into $STABLE_BRANCH"
git checkout -q "$STABLE_BRANCH"
# --no-ff so the release is always a merge commit, which is what the tag points
# at in every previous release and what makes `git log stable` read as a list
# of releases rather than of individual changes.
git merge --no-ff -q "$DEV_BRANCH" -m "Merge branch '$DEV_BRANCH' into $STABLE_BRANCH"
git tag -a "$TAG" -m "Kernl $VERSION"
ok "tagged $TAG at $(git rev-parse --short HEAD)"
git checkout -q "$DEV_BRANCH"

if [[ -f CHANGELOG.md ]] && grep -q '^## \[Unreleased\]' CHANGELOG.md; then
  warn "CHANGELOG.md still has an [Unreleased] section — it has not been rolled into a version since 0.2.0-rc.1"
fi

if [[ "$PUSH" -eq 1 ]]; then
  step "Pushing"
  git push origin "$DEV_BRANCH"
  git push origin "$STABLE_BRANCH"
  git push origin "$TAG"
  ok "pushed — the release workflow builds from $TAG"
  echo
  echo "  Watch:  https://github.com/$REPO_SLUG/actions"
  echo "  Then:   scripts/release.sh --cask $VERSION"
else
  step "Ready, nothing pushed"
  cat <<EOF
  Everything is local. To publish:

      git push origin $DEV_BRANCH && git push origin $STABLE_BRANCH && git push origin $TAG

  That tag starts the build in .github/workflows/release.yml, which attaches
  the rpm/deb/dmg/msi artifacts to the GitHub release. Once it finishes:

      scripts/release.sh --cask $VERSION

  To throw all of this away while it is still local:

      scripts/release.sh --undo $VERSION
EOF
fi
