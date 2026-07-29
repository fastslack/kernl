#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
#  preflight.sh — check the host BEFORE `docker compose up`.
#
#  The public stack's #1 first-impression failure is a silent `docker compose`
#  abort: a port is already taken, or Neo4j gets OOM-killed on a small host.
#  This prints clear, actionable guidance up front instead.
#
#  Usage:  bash scripts/preflight.sh
#  Exits non-zero if a hard blocker (occupied port) is found. RAM is a warning.
# ──────────────────────────────────────────────────────────────────────────
set -u

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

fail=0

port_in_use() {
  # Returns 0 if the TCP port is in use. Tries ss, then lsof, then /dev/tcp.
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "( sport = :$p )" 2>/dev/null | grep -q .
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$p") >/dev/null 2>&1 && { exec 3>&- 3<&-; return 0; } || return 1
  fi
}

hdr "Ports (the public stack needs these free)"
# 3086 = dashboard (loopback), 7474 = Neo4j HTTP, 7687 = Neo4j Bolt.
for entry in "3086:dashboard" "7474:Neo4j HTTP" "7687:Neo4j Bolt"; do
  p="${entry%%:*}"; label="${entry#*:}"
  if port_in_use "$p"; then
    bad "port $p ($label) is already in use — stop the other service, or override the mapping in a compose override file."
    fail=1
  else
    ok "port $p ($label) free"
  fi
done

hdr "Memory (Neo4j is the heaviest service)"
mem_kb=0
if [ -r /proc/meminfo ]; then
  mem_kb="$(awk '/MemTotal/{print $2}' /proc/meminfo)"
elif command -v sysctl >/dev/null 2>&1; then
  bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"; mem_kb=$(( bytes / 1024 ))
fi
mem_gb=$(( mem_kb / 1024 / 1024 ))
if [ "$mem_kb" -eq 0 ]; then
  warn "could not detect total RAM — ensure you have ~3 GB free for Neo4j + embeddings."
elif [ "$mem_gb" -lt 3 ]; then
  warn "only ~${mem_gb} GB RAM detected. Neo4j may be OOM-killed. On a small host, drop the 'neo4j' service from docker-compose.yml (graph features degrade gracefully)."
else
  ok "~${mem_gb} GB RAM — enough for the full stack."
fi

hdr "Docker"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok "docker is installed and the daemon is reachable"
else
  bad "docker not available — install Docker and start the daemon."
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  printf '\n\033[31m\033[1mPreflight found blockers — resolve them, then run:\033[0m\n'
  printf '  docker compose up -d --build\n'
  exit 1
fi
printf '\n\033[32m\033[1mPreflight OK — start the stack:\033[0m\n'
printf '  docker compose up -d --build\n'
printf '  open http://localhost:3086\n'
