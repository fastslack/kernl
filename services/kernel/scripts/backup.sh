#!/bin/bash
# Kernl Backup — a consistent snapshot of the live database, secrets and config.
#
# Usage: ./scripts/backup.sh [output-path]
#
# Environment:
#   KERNEL_BACKUP_MODE       auto (default) | docker | native
#   KERNEL_BACKUP_DATA_DIR   native mode: the dir holding kernel.db
#   KERNEL_BACKUP_SKIP_NEO4J 1 to skip the graph dump (it stops Neo4j briefly)
#   KERNEL_BACKUP_SKIP_GRAPH 1 to leave the built-in graph store out
#   KERNEL_BACKUP_GRAPH_DIR  native mode: the graph store (default <data-dir>/graph)
#
# Three things this gets right, each of which the previous version got wrong:
#
#   1. It backs up the database the kernel is ACTUALLY using. Under Docker that
#      lives in the `kernel-data` volume, not in the repo's ./data — which is
#      usually a stale leftover from running outside Docker. Copying the wrong
#      file and reporting success is the worst possible outcome for a backup.
#
#   2. It copies through SQLite (`VACUUM INTO`), never `cp`. The kernel holds
#      the DB open in WAL mode, so recent writes live in kernel.db-wal; a file
#      copy of kernel.db silently loses everything since the last checkpoint
#      and yields a database that may not even open.
#
#   3. It fails loudly. No database, an unreadable copy, a failed graph dump —
#      all exit non-zero. A backup problem you don't hear about is one you find
#      out about at restore time.
#
# It also captures the generated secrets (.kernel-auth-token,
# .kernel-encryption-key). Losing the encryption key makes every encrypted
# secret in the DB permanently unrecoverable, so a backup without it is only
# half a backup.
#
# And it captures the built-in graph (Relate, the `data/graph` directory
# store). Since 0.5.0 that store is the only copy of chat long-term memory, the
# CRM's KNOWS links and the news archive — none of it can be rebuilt from
# SQLite. Like the database, it is never copied with `cp`: the running kernel
# holds it open, and a file copy taken mid-checkpoint mixes shards from two
# states. Instead the kernel's own store copier (the internal task
# `relate-store-migration`, which the 0.5.0 upgrade uses too) opens the live
# store read-only — a directory store allows any number of readers beside its
# writer, and a reader loads the checkpoints plus the WAL, i.e. every committed
# write — and writes a fresh store from that snapshot. No pause, no restart.
# The copy is then reopened in a separate process and its node and
# relationship counts must match the snapshot's, or the backup fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$PROJECT_DIR/../.." && pwd)"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT="${1:-$HOME/kernl-backup-$TIMESTAMP.zip}"

MODE="${KERNEL_BACKUP_MODE:-auto}"
SKIP_NEO4J="${KERNEL_BACKUP_SKIP_NEO4J:-0}"
SKIP_GRAPH="${KERNEL_BACKUP_SKIP_GRAPH:-0}"
KERNEL_SERVICE="kernel"
NEO4J_SERVICE="neo4j"

die() { echo "ERROR: $*" >&2; exit 1; }
note() { echo "$*"; }

# The SQLite work runs through bun (the runtime we already ship, in the image
# too). Kept in heredocs and passed as a single argv element so no layer of
# shell quoting can mangle it.
#
# Paths arrive as environment variables, not argv: `bun -e` and `bun run file`
# index process.argv differently (there is no script element under -e), and
# getting that wrong silently snapshots the wrong file.
#
# The destination is spliced in as a quoted SQL literal rather than a bound
# parameter: SQLite rejects a bound filename on VACUUM INTO ("non-text
# filename"), and it fails quietly enough to leave a zero-byte "backup".
read -r -d '' SNAPSHOT_JS <<'SNAPSHOT_EOF' || true
const { Database } = require("bun:sqlite");
const src = process.env.KERNL_SNAPSHOT_SRC;
const dest = process.env.KERNL_SNAPSHOT_DEST;
if (!src || !dest) {
  console.error("KERNL_SNAPSHOT_SRC / KERNL_SNAPSHOT_DEST not set");
  process.exit(1);
}
const db = new Database(src);
db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
db.close();
SNAPSHOT_EOF

read -r -d '' VERIFY_JS <<'VERIFY_EOF' || true
const { Database } = require("bun:sqlite");
const db = new Database(process.env.KERNL_VERIFY_DB, { readonly: true });
const row = db.query("PRAGMA integrity_check").get();
const verdict = row && Object.values(row)[0];
if (verdict !== "ok") {
  console.error("integrity_check:", verdict);
  process.exit(1);
}
const { c } = db.query("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'").get();
if (!c) {
  console.error("the snapshot has no tables");
  process.exit(1);
}
console.log(`      integrity ok · ${c} tables`);
db.close();
VERIFY_EOF

# Reopens a copied graph store read-only, in a process of its own, and prints
# "<nodes> <relationships>". The client resolves from the kernel's own
# node_modules (KERNL_GRAPH_RESOLVE_FROM), or RELATE_CLIENT_MODULE as the
# kernel itself honours it.
read -r -d '' VERIFY_GRAPH_JS <<'VERIFY_GRAPH_EOF' || true
const store = process.env.KERNL_VERIFY_GRAPH;
if (!store) {
  console.error("KERNL_VERIFY_GRAPH not set");
  process.exit(1);
}
const spec = process.env.RELATE_CLIENT_MODULE?.trim()
  || require.resolve("@relate/relate", { paths: [process.env.KERNL_GRAPH_RESOLVE_FROM || process.cwd()] });
const mod = require(spec);
const { Database } = mod.Database ? mod : mod.default;
const conn = Database.open(store, { readOnly: true }).connect();
const n = Number(conn.query("MATCH (n) RETURN count(n) AS n").rows[0].n);
const r = Number(conn.query("MATCH ()-[r]->() RETURN count(r) AS n").rows[0].n);
console.log(`${n} ${r}`);
VERIFY_GRAPH_EOF

# Directory-tree cleanup without `rm -r`: delete the files, then the now-empty
# directories from the leaves up.
cleanup_tree() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  find "$dir" -type f -delete 2>/dev/null || true
  find "$dir" -depth -type d -empty -delete 2>/dev/null || true
}

# ── Mode detection ───────────────────────────────────────────────────
docker_stack_running() {
  command -v docker >/dev/null 2>&1 || return 1
  [ -n "$(docker compose --project-directory "$REPO_ROOT" ps -q "$KERNEL_SERVICE" 2>/dev/null)" ]
}

NATIVE_DATA_DIR="${KERNEL_BACKUP_DATA_DIR:-$PROJECT_DIR/data}"

if [ "$MODE" = "auto" ]; then
  if docker_stack_running; then
    MODE="docker"
  elif [ -f "$NATIVE_DATA_DIR/kernel.db" ]; then
    MODE="native"
  else
    die "no database found. Looked for a running Docker stack in $REPO_ROOT and for $NATIVE_DATA_DIR/kernel.db. Point at one with KERNEL_BACKUP_DATA_DIR, or start the stack."
  fi
fi

echo "=== Kernl Backup ==="
echo "Mode:   $MODE"
echo "Output: $OUTPUT"
echo ""

TMPDIR_BACKUP=$(mktemp -d)
BACKUP="$TMPDIR_BACKUP/kernl-backup"
mkdir -p "$BACKUP/data"
trap 'cleanup_tree "$TMPDIR_BACKUP"' EXIT

# ── 1. The database, through SQLite ──────────────────────────────────
# `VACUUM INTO` asks SQLite for a consistent copy: it reads through the WAL and
# writes a defragmented database, with no lock held on the source beyond a read.
note "[1/6] Snapshotting the database (VACUUM INTO)…"

vacuum_locally() {
  local src="$1" dest="$2"
  command -v bun >/dev/null 2>&1 || die "bun not found — needed to snapshot SQLite consistently."
  # VACUUM INTO refuses to overwrite an existing file.
  rm -f "$dest"
  KERNL_SNAPSHOT_SRC="$src" KERNL_SNAPSHOT_DEST="$dest" \
    bun -e "$SNAPSHOT_JS" || die "VACUUM INTO failed for $src"
}

case "$MODE" in
  docker)
    docker_stack_running || die "Docker mode requested but the '$KERNEL_SERVICE' service is not running in $REPO_ROOT."
    CONTAINER_TMP="/tmp/kernl-backup-$TIMESTAMP.db"
    CONTAINER_DB="$(docker compose --project-directory "$REPO_ROOT" exec -T "$KERNEL_SERVICE" \
      sh -c 'echo "${SQLITE_PATH:-/app/data/kernel.db}"' | tr -d '\r')"
    docker compose --project-directory "$REPO_ROOT" exec -T "$KERNEL_SERVICE" \
      rm -f "$CONTAINER_TMP" || true
    docker compose --project-directory "$REPO_ROOT" exec -T \
      -e KERNL_SNAPSHOT_SRC="$CONTAINER_DB" -e KERNL_SNAPSHOT_DEST="$CONTAINER_TMP" \
      "$KERNEL_SERVICE" bun -e "$SNAPSHOT_JS" \
      || die "VACUUM INTO failed inside the $KERNEL_SERVICE container."
    docker compose --project-directory "$REPO_ROOT" cp \
      "$KERNEL_SERVICE:$CONTAINER_TMP" "$BACKUP/data/kernel.db" \
      || die "could not copy the snapshot out of the container."
    docker compose --project-directory "$REPO_ROOT" exec -T "$KERNEL_SERVICE" \
      rm -f "$CONTAINER_TMP" || true

    # The generated secrets live beside the DB in the volume.
    for secret in .kernel-auth-token .kernel-encryption-key; do
      if docker compose --project-directory "$REPO_ROOT" exec -T "$KERNEL_SERVICE" \
           test -f "/app/data/$secret" 2>/dev/null; then
        docker compose --project-directory "$REPO_ROOT" cp \
          "$KERNEL_SERVICE:/app/data/$secret" "$BACKUP/data/$secret" >/dev/null \
          && chmod 600 "$BACKUP/data/$secret"
      fi
    done
    ;;

  native)
    [ -f "$NATIVE_DATA_DIR/kernel.db" ] \
      || die "no database at $NATIVE_DATA_DIR/kernel.db"
    vacuum_locally "$NATIVE_DATA_DIR/kernel.db" "$BACKUP/data/kernel.db"

    for secret in .kernel-auth-token .kernel-encryption-key; do
      if [ -f "$NATIVE_DATA_DIR/$secret" ]; then
        cp "$NATIVE_DATA_DIR/$secret" "$BACKUP/data/$secret"
        chmod 600 "$BACKUP/data/$secret"
      fi
    done
    ;;

  *)
    die "unknown KERNEL_BACKUP_MODE '$MODE' (expected auto, docker or native)"
    ;;
esac

# ── 2. Verify the snapshot before calling it a backup ────────────────
note "[2/6] Verifying the snapshot…"
[ -s "$BACKUP/data/kernel.db" ] || die "the snapshot is empty."
command -v bun >/dev/null 2>&1 || die "bun not found — needed to verify the snapshot."
KERNL_VERIFY_DB="$BACKUP/data/kernel.db" bun -e "$VERIFY_JS" \
  || die "the snapshot did not verify — NOT a usable backup."

DB_SIZE=$(du -h "$BACKUP/data/kernel.db" | cut -f1)
note "      database: $DB_SIZE"

# ── 3. Config + auxiliary state ──────────────────────────────────────
note "[3/6] Copying config…"
for candidate in "$REPO_ROOT/.env" "$PROJECT_DIR/.env"; do
  if [ -f "$candidate" ]; then
    cp "$candidate" "$BACKUP/.env"
    note "      $candidate"
    break
  fi
done

if [ "$MODE" = "native" ]; then
  if [ -d "$NATIVE_DATA_DIR/whatsapp-auth" ]; then
    cp -r "$NATIVE_DATA_DIR/whatsapp-auth" "$BACKUP/data/"
    note "      WhatsApp auth"
  fi
else
  if docker compose --project-directory "$REPO_ROOT" exec -T "$KERNEL_SERVICE" \
       test -d /app/data/whatsapp-auth 2>/dev/null; then
    docker compose --project-directory "$REPO_ROOT" cp \
      "$KERNEL_SERVICE:/app/data/whatsapp-auth" "$BACKUP/data/whatsapp-auth" >/dev/null \
      && note "      WhatsApp auth"
  fi
fi

# ── 4. The built-in graph (Relate) ───────────────────────────────────
# See the header: a read-only snapshot of the live store, written out as a
# fresh store by the kernel's own copier, then reopened and counted. The
# kernel keeps running; the copy needs memory for one more copy of the graph
# while it runs (the engine keeps a store in memory).
GRAPH_SKIP_HINT="Re-run with KERNEL_BACKUP_SKIP_GRAPH=1 to accept a backup WITHOUT the graph (chat memory, CRM links and the news archive live only there)."
GRAPH_COUNTS=""
GRAPH_VERIFY_ERR="$TMPDIR_BACKUP/graph-verify.err"

# "<nodes> <relationships>" from the copier's summary line
# ("N nodes, M relationships, K schema statements in T ms").
graph_counts_from_copy() {
  printf '%s\n' "$1" | sed -n 's/^\([0-9][0-9]*\) nodes, \([0-9][0-9]*\) relationships.*/\1 \2/p' | tail -1
}

last_lines() { printf '%s\n' "$1" | tail -5; }

# The copier checks its own copy against the snapshot it read; this checks
# again from a separate process that opens only the copy.
check_graph_counts() {
  local expected="$1" got="$2"
  [ -n "$expected" ] || die "the graph copy reported no counts — NOT a usable backup. $GRAPH_SKIP_HINT"
  [ "$expected" = "$got" ] \
    || die "the graph copy does not match: the snapshot had '$expected' (nodes relationships), the copy reopens with '${got:-nothing}' — NOT a usable backup."
  GRAPH_COUNTS="$expected"
}

legacy_graph_die() {
  die "the graph is still the single-file store $1, which the running kernel holds exclusively. Start a 0.5+ kernel once (it moves the graph to a directory store), or stop the kernel and copy that file by hand. $GRAPH_SKIP_HINT"
}

if [ "$SKIP_GRAPH" = "1" ]; then
  note "[4/6] Skipping the graph store (KERNEL_BACKUP_SKIP_GRAPH=1)"
elif [ "$MODE" = "native" ]; then
  GRAPH_SRC="${KERNEL_BACKUP_GRAPH_DIR:-$NATIVE_DATA_DIR/graph}"
  if [ -d "$GRAPH_SRC" ]; then
    note "[4/6] Copying the graph store (read-only snapshot; the kernel keeps running)…"
    [ -f "$PROJECT_DIR/bin/mcp-server.ts" ] \
      || die "the kernel entry point $PROJECT_DIR/bin/mcp-server.ts is missing — it does the graph copy."
    # The copier opens a fresh store and refuses an existing one.
    [ ! -e "$BACKUP/data/graph" ] || die "internal: $BACKUP/data/graph already exists."
    COPY_OUT="$(cd "$PROJECT_DIR" && KERNL_INTERNAL_TASK=relate-store-migration \
      KERNL_RELATE_MIGRATE_FROM="$GRAPH_SRC" KERNL_RELATE_MIGRATE_TO="$BACKUP/data/graph" \
      bun bin/mcp-server.ts 2>&1)" \
      || die "the graph copy failed:
$(last_lines "$COPY_OUT")
$GRAPH_SKIP_HINT"
    GOT="$(KERNL_VERIFY_GRAPH="$BACKUP/data/graph" KERNL_GRAPH_RESOLVE_FROM="$PROJECT_DIR" \
      bun -e "$VERIFY_GRAPH_JS" 2>"$GRAPH_VERIFY_ERR")" \
      || die "the graph copy does not open:
$(tail -5 "$GRAPH_VERIFY_ERR")
NOT a usable backup."
    check_graph_counts "$(graph_counts_from_copy "$COPY_OUT")" "$GOT"
  elif [ -f "$NATIVE_DATA_DIR/graph.rl" ] && [ -z "${KERNEL_BACKUP_GRAPH_DIR:-}" ]; then
    legacy_graph_die "$NATIVE_DATA_DIR/graph.rl"
  else
    note "[4/6] No built-in graph store at $GRAPH_SRC — nothing to copy"
  fi
else
  dc() { docker compose --project-directory "$REPO_ROOT" "$@"; }
  # Where the kernel keeps it: RELATE_DATABASE, else `graph` beside the DB.
  CONTAINER_GRAPH="$(dc exec -T "$KERNEL_SERVICE" \
    sh -c 'echo "${RELATE_DATABASE:-$(dirname "${SQLITE_PATH:-/app/data/kernel.db}")/graph}"' | tr -d '\r')"
  if dc exec -T "$KERNEL_SERVICE" test -d "$CONTAINER_GRAPH" 2>/dev/null; then
    note "[4/6] Copying the graph store (read-only snapshot; the kernel keeps running)…"
    CONTAINER_GRAPH_TMP="/tmp/kernl-backup-graph-$TIMESTAMP"
    remove_container_graph_tmp() {
      dc exec -T "$KERNEL_SERVICE" sh -c \
        'find "$1" -type f -delete 2>/dev/null; find "$1" -depth -type d -empty -delete 2>/dev/null; true' \
        sh "$CONTAINER_GRAPH_TMP" >/dev/null 2>&1 || true
    }
    remove_container_graph_tmp
    COPY_OUT="$(dc exec -T \
      -e KERNL_INTERNAL_TASK=relate-store-migration \
      -e KERNL_RELATE_MIGRATE_FROM="$CONTAINER_GRAPH" -e KERNL_RELATE_MIGRATE_TO="$CONTAINER_GRAPH_TMP" \
      "$KERNEL_SERVICE" bun run dist/mcp-server.js 2>&1 | tr -d '\r')" \
      || { remove_container_graph_tmp; die "the graph copy failed inside the $KERNEL_SERVICE container:
$(last_lines "$COPY_OUT")
$GRAPH_SKIP_HINT"; }
    GOT="$(dc exec -T -e KERNL_VERIFY_GRAPH="$CONTAINER_GRAPH_TMP" -e KERNL_GRAPH_RESOLVE_FROM=/app \
      "$KERNEL_SERVICE" bun -e "$VERIFY_GRAPH_JS" 2>"$GRAPH_VERIFY_ERR" | tr -d '\r')" \
      || { remove_container_graph_tmp; die "the graph copy does not open:
$(tail -5 "$GRAPH_VERIFY_ERR")
NOT a usable backup."; }
    check_graph_counts "$(graph_counts_from_copy "$COPY_OUT")" "$GOT"
    dc cp "$KERNEL_SERVICE:$CONTAINER_GRAPH_TMP" "$BACKUP/data/graph" >/dev/null \
      || { remove_container_graph_tmp; die "could not copy the graph store out of the container."; }
    remove_container_graph_tmp
    [ -f "$BACKUP/data/graph/manifest.json" ] \
      || die "the graph store came out of the container incomplete (no manifest.json) — NOT a usable backup."
  elif dc exec -T "$KERNEL_SERVICE" test -f "$CONTAINER_GRAPH" 2>/dev/null; then
    legacy_graph_die "$CONTAINER_GRAPH"
  elif dc exec -T "$KERNEL_SERVICE" test -f "$(dirname "$CONTAINER_GRAPH")/graph.rl" 2>/dev/null; then
    legacy_graph_die "$(dirname "$CONTAINER_GRAPH")/graph.rl"
  else
    note "[4/6] No built-in graph store in the container ($CONTAINER_GRAPH) — nothing to copy"
  fi
fi
if [ -n "$GRAPH_COUNTS" ]; then
  note "      graph: ${GRAPH_COUNTS% *} nodes, ${GRAPH_COUNTS#* } relationships ($(du -sh "$BACKUP/data/graph" | cut -f1)) · reopened and counted"
fi

# ── 5. Neo4j (Docker only; the graph is rebuildable but slow) ────────
if [ "$MODE" = "docker" ] && [ "$SKIP_NEO4J" != "1" ] \
   && [ -n "$(docker compose --project-directory "$REPO_ROOT" ps -q "$NEO4J_SERVICE" 2>/dev/null)" ]; then
  note "[5/6] Dumping Neo4j (stops it briefly)…"
  mkdir -p "$BACKUP/neo4j"

  # Guarantee the restart. An interrupted backup that leaves the user's graph
  # database stopped is a worse outcome than no backup at all — so the restart
  # is armed BEFORE the stop and fires on any exit path.
  restart_neo4j() {
    docker compose --project-directory "$REPO_ROOT" up -d "$NEO4J_SERVICE" >/dev/null 2>&1 || true
  }
  trap 'restart_neo4j; cleanup_tree "$TMPDIR_BACKUP"' EXIT INT TERM

  docker compose --project-directory "$REPO_ROOT" stop "$NEO4J_SERVICE" >/dev/null 2>&1 || true
  if docker compose --project-directory "$REPO_ROOT" run --rm -T "$NEO4J_SERVICE" \
       neo4j-admin database dump neo4j --to-stdout > "$BACKUP/neo4j/neo4j.dump" 2>/dev/null \
     && [ -s "$BACKUP/neo4j/neo4j.dump" ]; then
    note "      graph: $(du -h "$BACKUP/neo4j/neo4j.dump" | cut -f1)"
  else
    die "the Neo4j dump failed or came out empty. The graph rebuilds from SQLite, so re-run with KERNEL_BACKUP_SKIP_NEO4J=1 to accept that and continue."
  fi

  restart_neo4j
  trap 'cleanup_tree "$TMPDIR_BACKUP"' EXIT
else
  note "[5/6] Skipping Neo4j (rebuildable from SQLite)"
fi

# ── 6. Restore script + archive ──────────────────────────────────────
note "[6/6] Writing the restore script…"
cat > "$BACKUP/restore.sh" << 'RESTORE'
#!/bin/bash
# Kernl Restore.
#
#   Docker:  bash restore.sh --docker /path/to/kernl-repo [--yes]
#   Native:  bash restore.sh --native /path/to/data-dir   [--yes]
#
# Restoring REPLACES the target database. The kernel must be stopped first:
# writing under a live kernel corrupts both copies.
#
# The graph store (data/graph), when the archive has one, replaces the target's;
# the store it replaces is kept beside it as graph.before-restore-<time>, since
# it may hold the only copy of what was written after this backup was taken.

set -euo pipefail
RESTORE_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-}"
TARGET="${2:-}"
ASSUME_YES=0
[ "${3:-}" = "--yes" ] && ASSUME_YES=1

die() { echo "ERROR: $*" >&2; exit 1; }
STAMP="$(date +%Y%m%d-%H%M%S)"
HAS_GRAPH=0
if [ -d "$RESTORE_DIR/data/graph" ]; then
  [ -f "$RESTORE_DIR/data/graph/manifest.json" ] \
    || die "the archive's graph store is incomplete (no manifest.json) — refusing to restore it over a working one."
  HAS_GRAPH=1
fi

[ -f "$RESTORE_DIR/data/kernel.db" ] || die "this archive has no database — refusing to 'restore' nothing."
case "$MODE" in
  --docker|--native) ;;
  *) die "usage: restore.sh --docker <repo-dir> | --native <data-dir> [--yes]" ;;
esac
[ -n "$TARGET" ] || die "usage: restore.sh $MODE <target> [--yes]"

echo "=== Kernl Restore ==="
echo "From: $RESTORE_DIR"
echo "To:   $TARGET ($MODE)"
echo ""
if [ "$ASSUME_YES" != "1" ]; then
  if [ "$HAS_GRAPH" = "1" ]; then
    printf "This REPLACES the database and the graph store at the target. Type 'yes' to continue: "
  else
    printf "This REPLACES the database at the target. Type 'yes' to continue: "
  fi
  read -r confirm
  [ "$confirm" = "yes" ] || die "aborted."
fi

if [ "$MODE" = "--docker" ]; then
  command -v docker >/dev/null 2>&1 || die "docker not found."
  dc() { docker compose --project-directory "$TARGET" "$@"; }
  echo "[1/4] Stopping the kernel…"
  docker compose --project-directory "$TARGET" stop kernel >/dev/null

  echo "[2/4] Restoring the database and secrets…"
  docker compose --project-directory "$TARGET" cp \
    "$RESTORE_DIR/data/kernel.db" "kernel:/app/data/kernel.db"
  # Stale WAL/shm from the replaced database would shadow what we just wrote.
  # --no-deps: this throwaway container only needs the data volume; without it
  # compose would boot Neo4j and SearXNG just to run one `rm`.
  docker compose --project-directory "$TARGET" run --rm --no-deps -T --entrypoint sh kernel \
    -c 'rm -f /app/data/kernel.db-wal /app/data/kernel.db-shm' >/dev/null 2>&1 || true
  for secret in .kernel-auth-token .kernel-encryption-key; do
    if [ -f "$RESTORE_DIR/data/$secret" ]; then
      docker compose --project-directory "$TARGET" cp \
        "$RESTORE_DIR/data/$secret" "kernel:/app/data/$secret"
    fi
  done

  RESTORED="/app/data/kernel.db /app/data/.kernel-auth-token /app/data/.kernel-encryption-key"
  if [ "$HAS_GRAPH" = "1" ]; then
    echo "[3/4] Restoring the graph store…"
    # Where the kernel keeps it (RELATE_DATABASE, else `graph` beside the DB).
    # The current store is moved aside, not deleted, and the path must be free
    # anyway: copying a directory onto an existing one nests it inside.
    GRAPH_PATH="$(dc run --rm --no-deps -T --entrypoint sh kernel -c '
      G="${RELATE_DATABASE:-$(dirname "${SQLITE_PATH:-/app/data/kernel.db}")/graph}"
      if [ -e "$G" ]; then mv "$G" "$G.before-restore-$1" || exit 1; fi
      echo "$G"' sh "$STAMP" | tr -d '\r' | tail -1)" \
      || die "could not make room for the graph store in the kernel-data volume."
    [ -n "$GRAPH_PATH" ] || die "could not find where the kernel keeps its graph store."
    dc cp "$RESTORE_DIR/data/graph" "kernel:$GRAPH_PATH" \
      || die "could not copy the graph store into the container (the previous one is at $GRAPH_PATH.before-restore-$STAMP)."
    RESTORED="$RESTORED $GRAPH_PATH"
    echo "      $GRAPH_PATH (the previous store, if any: $GRAPH_PATH.before-restore-$STAMP)"
  else
    echo "[3/4] No graph store in this archive — the target's graph is left as it is."
  fi
  # `docker compose cp` writes files as root, and the kernel runs as an
  # unprivileged user: hand everything restored to the volume's owner, or the
  # kernel starts on a database and a graph it cannot write.
  dc run --rm --no-deps -T --user root --entrypoint sh kernel -c '
    owner="$(stat -c %u:%g /app/data)"
    for p in "$@"; do [ -e "$p" ] && chown -R "$owner" "$p"; done; true' sh $RESTORED >/dev/null \
    || die "could not hand the restored files to the kernel's user — fix their ownership in the kernel-data volume before starting the kernel."

  echo "[4/4] Starting the kernel…"
  docker compose --project-directory "$TARGET" up -d kernel >/dev/null
else
  mkdir -p "$TARGET"
  echo "[1/3] Restoring the database and secrets…"
  cp "$RESTORE_DIR/data/kernel.db" "$TARGET/kernel.db"
  rm -f "$TARGET/kernel.db-wal" "$TARGET/kernel.db-shm"
  for secret in .kernel-auth-token .kernel-encryption-key; do
    if [ -f "$RESTORE_DIR/data/$secret" ]; then
      cp "$RESTORE_DIR/data/$secret" "$TARGET/$secret"
      chmod 600 "$TARGET/$secret"
    fi
  done
  if [ "$HAS_GRAPH" = "1" ]; then
    echo "[2/3] Restoring the graph store…"
    # The current store is moved aside, not deleted; the path must be free
    # anyway, or `cp -R` would nest the copy inside it.
    if [ -e "$TARGET/graph" ]; then
      mv "$TARGET/graph" "$TARGET/graph.before-restore-$STAMP"
      echo "      previous store kept as $TARGET/graph.before-restore-$STAMP"
    fi
    cp -R "$RESTORE_DIR/data/graph" "$TARGET/graph"
    echo "      $TARGET/graph (if RELATE_DATABASE points elsewhere, move it there)"
  else
    echo "[2/3] No graph store in this archive — the target's graph is left as it is."
  fi
  echo "[3/3] Done — start the kernel."
fi

if [ -f "$RESTORE_DIR/neo4j/neo4j.dump" ]; then
  echo ""
  echo "A Neo4j dump is included but NOT restored automatically."
  echo "Load it with:  neo4j-admin database load neo4j --from-stdin < neo4j/neo4j.dump"
  echo "(Or skip it — the graph rebuilds from SQLite.)"
fi

echo ""
echo "=== Restore complete ==="
RESTORE
chmod +x "$BACKUP/restore.sh"

mkdir -p "$(dirname "$OUTPUT")"
rm -f "$OUTPUT"
( cd "$TMPDIR_BACKUP" && zip -r "$OUTPUT" kernl-backup/ -q ) || die "could not create $OUTPUT"
[ -s "$OUTPUT" ] || die "the archive came out empty."

echo ""
echo "=== Backup complete ==="
echo "File: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo ""
echo "Restore with:  unzip $(basename "$OUTPUT") && bash kernl-backup/restore.sh --$MODE <target>"
