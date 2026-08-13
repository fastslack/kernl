#!/bin/bash
# Kernl Restore — restore a backup archive produced by scripts/backup.sh.
#
#   Docker:  bash restore.sh <backup.zip> --docker /path/to/kernl-repo [--yes]
#   Native:  bash restore.sh <backup.zip> --native /path/to/data-dir   [--yes]
#
# This is a thin wrapper: every archive carries its own `restore.sh`, and that
# embedded copy is the single implementation. Restoring with the script that
# shipped alongside the data also avoids the classic failure where a newer tool
# quietly mishandles an older archive.
#
# What it deliberately does NOT do: clone the repo, install dependencies, build
# the dashboard or start services. The previous version did all of that, and its
# restore step copied the database into the repo's own ./data — which the Docker
# deployment never reads. It printed a green "restore complete" while restoring
# nothing. Getting the app running is the quick start's job; this moves data,
# and tells you where it went.

set -euo pipefail

ZIP="${1:-}"
MODE="${2:-}"
TARGET="${3:-}"
ASSUME_YES="${4:-}"

die() { echo "ERROR: $*" >&2; exit 1; }

usage() {
  cat >&2 <<'USAGE'
Usage:
  restore.sh <backup.zip> --docker <kernl-repo-dir> [--yes]
  restore.sh <backup.zip> --native <data-dir>       [--yes]

  --docker   the docker-compose.yml stack; restores into the kernel container's
             /app/data volume, stopping the kernel first.
  --native   a package or source install; <data-dir> is the directory that
             holds kernel.db (e.g. ~/.local/share/kernl/data).
  --yes      skip the confirmation prompt (for cron / automation).
USAGE
  exit 1
}

[ -n "$ZIP" ] || usage
[ -f "$ZIP" ] || die "backup file not found: $ZIP"
case "$MODE" in
  --docker|--native) ;;
  *) usage ;;
esac
[ -n "$TARGET" ] || usage
command -v unzip >/dev/null 2>&1 || die "unzip not found."

ZIP="$(cd "$(dirname "$ZIP")" && pwd)/$(basename "$ZIP")"

WORK="$(mktemp -d)"
# Directory cleanup without `rm -r`: delete the files, then the empty dirs.
cleanup() {
  [ -d "$WORK" ] || return 0
  find "$WORK" -type f -delete 2>/dev/null || true
  find "$WORK" -depth -type d -empty -delete 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "=== Kernl Restore ==="
echo "Archive: $ZIP"
echo ""

unzip -q "$ZIP" -d "$WORK" || die "could not extract $ZIP"

EMBEDDED="$(find "$WORK" -name restore.sh -type f | head -1)"
if [ -z "$EMBEDDED" ]; then
  # An archive from before the embedded restore existed. Don't guess where its
  # payload belongs — point at it so the data is still recoverable by hand.
  DB="$(find "$WORK" -name kernel.db -type f | head -1)"
  [ -n "$DB" ] && die "this archive predates the embedded restore script. Its database is at:
  $DB
Stop the kernel, copy that file into place, and delete any kernel.db-wal /
kernel.db-shm sitting beside it."
  die "this archive has no database and no restore script — there is nothing to restore."
fi

# `bash` rather than exec-ing the file directly: the extracted copy may not
# carry its executable bit through every zip implementation.
if [ -n "$ASSUME_YES" ]; then
  exec bash "$EMBEDDED" "$MODE" "$TARGET" "$ASSUME_YES"
else
  exec bash "$EMBEDDED" "$MODE" "$TARGET"
fi
