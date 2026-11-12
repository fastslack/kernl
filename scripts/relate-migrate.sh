#!/usr/bin/env bash
# Copy Kernl's Neo4j graph into a Relate store (the `relate` graph driver).
#
#   NEO4J_PASSWORD=… scripts/relate-migrate.sh [DEST]
#
# DEST defaults to data/graph, the directory store the relate driver opens when the
# kernel's SQLite database lives in data/. The source is only read; DEST must
# not exist yet (relate pull writes into an empty store only).
#
# Environment:
#   NEO4J_PASSWORD   required
#   NEO4J_HTTP_URI   Neo4j's HTTP Query API origin (default http://localhost:17474,
#                    the host port the kernl-public stack publishes)
#   NEO4J_USER       default neo4j
#   NEO4J_DATABASE   default neo4j
#   RELATE_BIN       the relate CLI (default: `relate` on PATH)
#
# Vector and full-text indexes are not copied (relate pull skips them); the
# kernel recreates them on its next start, from the same definitions it uses
# against Neo4j. Afterwards, activate the driver from /extensions or start the
# kernel with RELATE_DATABASE pointing at DEST on a fresh install.

set -euo pipefail

DEST="${1:-data/graph}"
RELATE_BIN="${RELATE_BIN:-relate}"
SRC_URI="${NEO4J_HTTP_URI:-http://localhost:17474}"
SRC_USER="${NEO4J_USER:-neo4j}"
SRC_DB="${NEO4J_DATABASE:-neo4j}"

die() { echo "relate-migrate: $*" >&2; exit 1; }

[[ -n "${NEO4J_PASSWORD:-}" ]] || die "NEO4J_PASSWORD is required"
command -v "$RELATE_BIN" >/dev/null 2>&1 || die "relate CLI not found (set RELATE_BIN or install it from https://relatedb.ai)"
[[ ! -e "$DEST" ]] || die "$DEST already exists — move it away first; pull only writes into an empty store"

# Usage metrics are on by default in the CLI build; this script sends none.
export RELATE_TELEMETRY=0

# Credentials go through a private env file, never the command line.
envfile="$(mktemp)"
trap 'rm -f "$envfile"' EXIT
chmod 600 "$envfile"
{
  echo "NEO4J_URI=$SRC_URI"
  echo "NEO4J_USERNAME=$SRC_USER"
  echo "NEO4J_PASSWORD=$NEO4J_PASSWORD"
  echo "NEO4J_DATABASE=$SRC_DB"
} >"$envfile"

# Count on the source through the same Query API pull uses.
source_count() {
  curl -fsS -u "$SRC_USER:$NEO4J_PASSWORD" -H 'Content-Type: application/json' \
    -d "{\"statement\": \"$1\"}" "$SRC_URI/db/$SRC_DB/query/v2" |
    sed -E 's/.*"values":\[\[?([0-9]+)\]?\].*/\1/'
}

dest_count() {
  "$RELATE_BIN" --database "$DEST" --read-only --mode csv "$1" | tail -n 1 | tr -dc '0-9'
}

src_nodes="$(source_count 'MATCH (n) RETURN count(n)')"
src_rels="$(source_count 'MATCH ()-[r]->() RETURN count(r)')"
echo "source: $src_nodes nodes, $src_rels relationships ($SRC_URI, database $SRC_DB)"

mkdir -p "$(dirname "$DEST")"
plaintext=()
case "$SRC_URI" in
  http://localhost* | http://127.0.0.1* | http://\[::1\]* | https://*) ;;
  http://*) plaintext=(--allow-plaintext) ;;
esac
"$RELATE_BIN" pull --from "$envfile" ${plaintext[@]+"${plaintext[@]}"} \
  --query 'MATCH (n) RETURN n; MATCH ()-[r]->() RETURN r' \
  --database "$DEST"

dst_nodes="$(dest_count 'MATCH (n) RETURN count(n) AS c')"
dst_rels="$(dest_count 'MATCH ()-[r]->() RETURN count(r) AS c')"
echo "relate: $dst_nodes nodes, $dst_rels relationships ($DEST)"

if [[ "$src_nodes" != "$dst_nodes" || "$src_rels" != "$dst_rels" ]]; then
  die "counts differ — keep using Neo4j and inspect $DEST before switching"
fi
echo "relate-migrate: done — counts match"
