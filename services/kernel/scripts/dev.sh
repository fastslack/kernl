#!/usr/bin/env bash
# Kernl dev controller — single entrypoint for the rebuild / reload /
# dev-mode dance with docker compose.
#
# Usage:
#   ./scripts/dev.sh <command> [args]
#
# Commands:
#   reload                Smart: detect what changed (git diff) and rebuild only that
#   reload all            Rebuild dashboard + extensions + kernel, then restart everything
#   reload kernel         Rebuild kernel image and restart
#   reload dashboard      Rebuild Svelte and restart nginx (refresh bind-mount)
#   reload extensions     Rebuild assets/extensions/*/backend/entry.js bundles
#                         (then `reload kernel` to pick them up)
#   reload full           Same as `reload all` (alias)
#
#   dev up                Start Vite dev server with HMR on :3088
#   dev down              Stop the Vite dev server
#   dev logs              Tail Vite logs
#
#   status                Show running containers, ports and recent kernel logs
#   logs [service]        Tail logs (default: kernel). e.g. logs dashboard
#   restart [service]     Restart a service without rebuilding (default: kernel)
#   stop                  Stop kernel + dashboard (keeps data + neo4j)
#   nuke                  docker compose down (everything except volumes)
#   fix-perms             Chown build-cache volumes to the host user (run if a
#                         build hits EACCES on /repo/node_modules etc.)
#
#   help                  Show this message
#
# Examples:
#   ./scripts/dev.sh reload                # auto-detect changes, fastest path
#   ./scripts/dev.sh reload all            # nuclear option
#   ./scripts/dev.sh reload dashboard      # only frontend touched
#   ./scripts/dev.sh dev up                # iterate frontend with hot reload
#   ./scripts/dev.sh logs kernel           # follow kernel logs
#   ./scripts/dev.sh status                # snapshot of the world

set -euo pipefail

# Raíz del REPO (no del paquete kernel): este script orquesta docker compose,
# que vive dos niveles arriba de services/kernel/scripts/.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

# ── Colours ─────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_BOLD=$'\e[1m'; C_DIM=$'\e[2m'; C_GREEN=$'\e[32m'; C_BLUE=$'\e[34m'
  C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_RESET=$'\e[0m'
else
  C_BOLD=""; C_DIM=""; C_GREEN=""; C_BLUE=""; C_YELLOW=""; C_RED=""; C_RESET=""
fi

step() { echo "${C_BLUE}▸${C_RESET} ${C_BOLD}$*${C_RESET}"; }
ok()   { echo "${C_GREEN}✓${C_RESET} $*"; }
warn() { echo "${C_YELLOW}⚠${C_RESET} $*"; }
die()  { echo "${C_RED}✗${C_RESET} $*" >&2; exit 1; }

# ── Pre-flight ──────────────────────────────────────────────────────
# This script drives the FULL host-coupled stack (dashboard-build,
# extensions-build, dashboard-dev live only there). The default
# docker-compose.yml is the zero-config public stack.
export COMPOSE_FILE=docker-compose.full.yml
command -v docker >/dev/null 2>&1 || die "docker not found"
docker compose version >/dev/null 2>&1 || die "docker compose v2 required"
[[ -f docker-compose.full.yml ]] || die "docker-compose.full.yml not in $ROOT"

# ── Volume ownership helpers ────────────────────────────────────────
# The dashboard-build / extensions-build containers run as the host user
# (HOST_UID:HOST_GID). Their named node_modules volumes are pre-existing
# from older builds where they ran as root, so the first run after the
# user-id change hits EACCES. Self-heal by chown-ing the volume to the
# host user the first time we see it root-owned.

ensure_volume_ownership() {
  local vol="$1"
  docker volume inspect "$vol" >/dev/null 2>&1 || return 0  # not created yet
  local uid; uid=$(id -u)
  local gid; gid=$(id -g)
  local owner
  owner=$(docker run --rm -v "$vol":/v alpine stat -c '%u:%g' /v 2>/dev/null || echo "")
  if [[ -z "$owner" ]] || [[ "$owner" == "$uid:$gid" ]]; then
    return 0
  fi
  warn "Volume $vol owned by $owner (expected $uid:$gid). Fixing…"
  chown_volume_to_host "$vol"
}

chown_volume_to_host() {
  local vol="$1"
  local uid; uid=$(id -u)
  local gid; gid=$(id -g)
  docker run --rm -v "$vol":/v alpine chown -R "$uid:$gid" /v >/dev/null
  ok "$vol → $uid:$gid"
}

# ── Building blocks ─────────────────────────────────────────────────

build_dashboard() {
  step "Building dashboard (Svelte → build/)"
  docker compose run --rm dashboard-build
  ok "dashboard built"
}

build_extensions() {
  step "Building extensions (_wrapper/entry.ts → backend/entry.js)"
  ensure_volume_ownership "kernl_extensions-build-node-modules"
  if ! docker compose run --rm extensions-build; then
    # Common failure: the named node_modules volume is root-owned from
    # an older run that didn't honour HOST_UID/HOST_GID. Self-heal once,
    # then retry. If it still fails after that, give up loud.
    warn "extensions-build failed — attempting volume chown + retry"
    chown_volume_to_host "kernl_extensions-build-node-modules"
    docker compose run --rm extensions-build || die "extensions-build failed even after chown"
  fi
  ok "extensions built"
}

rebuild_kernel() {
  step "Building kernel image"
  docker compose build kernel
  step "Restarting kernel container"
  docker compose up -d kernel
  ok "kernel rebuilt and started"
}

restart_dashboard() {
  step "Restarting dashboard (refresh bind-mount)"
  docker compose restart dashboard
  ok "dashboard restarted"
}

# ── Smart auto-detect ───────────────────────────────────────────────
# Looks at the git working tree (vs HEAD) to figure out which surface
# was touched. A file in `dashboard/` triggers a frontend rebuild;
# `assets/extensions/` triggers an extensions rebuild; anything in
# `src/` (other than dashboard) triggers a kernel rebuild. Multiple
# triggers run in the right order.
auto_reload() {
  if ! command -v git >/dev/null 2>&1; then
    warn "git not found — falling back to full rebuild"
    reload_all; return
  fi

  local changed
  changed="$(git status --porcelain --untracked-files=all | awk '{print $2}')"
  if [[ -z "$changed" ]]; then
    warn "working tree is clean — nothing to rebuild. Use 'reload all' to force."
    return 0
  fi

  local need_dashboard=0 need_kernel=0 need_extensions=0
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    case "$f" in
      services/dashboard/*)                 need_dashboard=1 ;;
      services/kernel/assets/extensions/*)  need_extensions=1; need_kernel=1 ;;
      services/kernel/src/*|services/kernel/bin/*|services/kernel/package.json|services/kernel/tsconfig*.json|docker-compose*.yml|Dockerfile*|services/kernel/Dockerfile)
                            need_kernel=1 ;;
      *) ;;  # docs, scripts/, README, etc — skip
    esac
  done <<< "$changed"

  if [[ $need_dashboard -eq 0 && $need_kernel -eq 0 && $need_extensions -eq 0 ]]; then
    warn "no buildable changes detected. Use 'reload all' to force."
    return 0
  fi

  echo
  step "Auto-detected changes:"
  [[ $need_dashboard  -eq 1 ]] && echo "  • dashboard"
  [[ $need_extensions -eq 1 ]] && echo "  • extensions"
  [[ $need_kernel     -eq 1 ]] && echo "  • kernel"
  echo

  # Order matters: extensions before kernel rebuild so the bundled
  # entry.js files are baked into the image. Dashboard last because
  # nginx restart is the cheapest step.
  [[ $need_extensions -eq 1 ]] && build_extensions
  [[ $need_kernel     -eq 1 ]] && rebuild_kernel
  [[ $need_dashboard  -eq 1 ]] && { build_dashboard; restart_dashboard; }

  ok "Smart reload complete"
}

reload_all() {
  build_dashboard
  build_extensions
  rebuild_kernel
  restart_dashboard
  ok "Full reload complete"
}

# ── Status ──────────────────────────────────────────────────────────
show_status() {
  step "Container status"
  docker compose ps
  echo
  step "Listening ports"
  echo "  3086 → dashboard (production build, via nginx)"
  echo "  3087 → kernel HTTP (MCP + WS-RPC)"
  echo "  3088 → dashboard-dev (Vite HMR, only if 'dev up')"
  echo "  17474/17687 → neo4j (browser/bolt)"
  echo
  step "Recent kernel logs (last 20)"
  docker compose logs --tail 20 kernel 2>&1 || warn "kernel not running"
}

# ── Dev mode (Vite HMR) ─────────────────────────────────────────────
dev_up() {
  step "Starting Vite dev server (HMR on :3088)"
  docker compose --profile dev up -d dashboard-dev
  sleep 1
  ok "Vite running. Open http://localhost:3088"
  echo "${C_DIM}Dashboard prod (:3086) and dev (:3088) are independent — pick whichever.${C_RESET}"
}

dev_down() {
  step "Stopping Vite dev server"
  docker compose --profile dev stop dashboard-dev || true
  ok "Vite stopped"
}

dev_logs() {
  docker compose --profile dev logs -f dashboard-dev
}

# ── Plumbing ────────────────────────────────────────────────────────
do_logs() {
  local svc="${1:-kernel}"
  step "Following logs: $svc (Ctrl+C to exit)"
  docker compose logs -f --tail 100 "$svc"
}

do_restart() {
  local svc="${1:-kernel}"
  step "Restarting: $svc"
  docker compose restart "$svc"
  ok "Restarted $svc"
}

do_stop() {
  step "Stopping kernel + dashboard"
  docker compose stop kernel dashboard || true
  ok "Stopped (data and neo4j untouched)"
}

do_nuke() {
  step "docker compose down (preserves volumes)"
  docker compose down
  ok "All containers gone. Volumes (data + neo4j) intact."
}

do_fix_perms() {
  # List of named volumes that build containers write to. Add new ones
  # here when docker-compose grows new build-cache volumes.
  local vols=(
    "kernl_extensions-build-node-modules"
  )
  for v in "${vols[@]}"; do
    if docker volume inspect "$v" >/dev/null 2>&1; then
      chown_volume_to_host "$v"
    else
      echo "  (skip $v — not created)"
    fi
  done
  ok "Build-cache volumes owned by $(id -u):$(id -g)"
}

# ── Help ────────────────────────────────────────────────────────────
show_help() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

# ── Dispatch ────────────────────────────────────────────────────────
cmd="${1:-help}"; shift || true

case "$cmd" in
  reload)
    sub="${1:-auto}"
    case "$sub" in
      auto|"")          auto_reload ;;
      all|full)         reload_all ;;
      kernel)           rebuild_kernel ;;
      dashboard)        build_dashboard; restart_dashboard ;;
      extensions|ext)   build_extensions ;;
      *) die "unknown reload target: $sub (try: auto | all | kernel | dashboard | extensions)" ;;
    esac
    ;;
  dev)
    sub="${1:-help}"
    case "$sub" in
      up)    dev_up ;;
      down)  dev_down ;;
      logs)  dev_logs ;;
      *) die "unknown dev subcommand: $sub (try: up | down | logs)" ;;
    esac
    ;;
  status)         show_status ;;
  logs)           do_logs "${1:-kernel}" ;;
  restart)        do_restart "${1:-kernel}" ;;
  stop)           do_stop ;;
  nuke|down)      do_nuke ;;
  fix-perms)      do_fix_perms ;;
  help|-h|--help) show_help ;;
  *) die "unknown command: $cmd  (run './scripts/dev.sh help')" ;;
esac
