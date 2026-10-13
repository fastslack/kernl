#!/usr/bin/env bash
#
# Manage the local Kernl stack (compose project `kernl-public`).
#
# The live stack is docker-compose.yml + docker-compose.host.yml, plus
# docker-compose.gpu.yml when the NVIDIA kernel module matches the userspace
# libs. Every command runs compose from this repo, never from a deploy copy:
# containers created from a copy under /tmp keep bind mounts into it, and when
# /tmp is wiped (reboot) docker recreates the missing file as an empty
# directory and the container can no longer start. The kernel refuses to boot
# without mtw-request, so that one dead sidecar takes everything down.
#
# Usage:
#   scripts/kernl.sh status                 containers, health, endpoints, warnings
#   scripts/kernl.sh up [service...]        start; recreate broken ones — no build
#   scripts/kernl.sh restart [service...]   restart containers (default: kernel)
#   scripts/kernl.sh recreate <service...>  force-recreate from the repo compose
#   scripts/kernl.sh stop [service...]      stop containers (volumes untouched)
#   scripts/kernl.sh logs [service] [-f] [--since 10m] [--errors]
#   scripts/kernl.sh doctor                 status + why the kernel last died
#
# Services: kernel dashboard mtw-request whatsapp-bridge neo4j searxng

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="kernl-public"
SERVICES=(neo4j searxng mtw-request whatsapp-bridge kernel dashboard)

if [[ -t 1 ]]; then
  R=$'\e[31m' G=$'\e[32m' Y=$'\e[33m' B=$'\e[1m' D=$'\e[2m' N=$'\e[0m'
else
  R='' G='' Y='' B='' D='' N=''
fi

die()  { echo "${R}error:${N} $*" >&2; exit 1; }
warn() { echo "${Y}warn:${N} $*" >&2; }
info() { echo "${D}›${N} $*"; }

# ── compose ──────────────────────────────────────────────────────────────────

gpu_ok() {
  # gpu.yml asks the nvidia runtime for libs matching the loaded module. After a
  # driver upgrade without a reboot those libs are gone and the container stays
  # in `Created`. Skip the override then; whisper falls back to CPU.
  [[ -r /proc/driver/nvidia/version ]] || return 1
  local v
  v="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+' /proc/driver/nvidia/version | head -1)"
  [[ -n "$v" ]] && compgen -G "/usr/lib64/nvidia/libEGL_nvidia.so.$v" >/dev/null \
    || compgen -G "/usr/lib/x86_64-linux-gnu/libEGL_nvidia.so.$v" >/dev/null
}

COMPOSE_FILES=(-f "$REPO/docker-compose.yml")
if gpu_ok; then
  COMPOSE_FILES+=(-f "$REPO/docker-compose.gpu.yml")
  GPU_STATE="on"
else
  GPU_STATE="off (NVIDIA module/libs mismatch or no GPU — reboot to restore)"
fi
COMPOSE_FILES+=(-f "$REPO/docker-compose.host.yml")

compose() { (cd "$REPO" && docker compose "${COMPOSE_FILES[@]}" "$@"); }

container() { echo "$PROJECT-$1"; }

valid_service() {
  local s
  for s in "${SERVICES[@]}"; do [[ "$s" == "$1" ]] && return 0; done
  die "unknown service '$1' (one of: ${SERVICES[*]})"
}

preflight() {
  [[ -f "$REPO/.env" ]] && grep -q '^KERNL_FS_ROOT=' "$REPO/.env" \
    || [[ -n "${KERNL_FS_ROOT:-}" ]] \
    || die "KERNL_FS_ROOT is not set (repo .env or environment); host.yml needs it"
  [[ -f "$REPO/mtw.docker.toml" ]] || die "$REPO/mtw.docker.toml missing — mtw-request cannot start"
  docker info >/dev/null 2>&1 || die "docker daemon not reachable"
}

# A container is broken when one of its bind sources vanished or turned into a
# directory: it cannot start again until it is recreated.
stale_reason() {
  local c="$1" src
  docker inspect "$c" >/dev/null 2>&1 || return 0
  while IFS= read -r src; do
    [[ -z "$src" || -e "$src" ]] || { echo "bind source $src missing"; return; }
  done < <(docker inspect "$c" --format '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}')
  if [[ "$(docker inspect "$c" --format '{{.State.Error}}')" == *"not a directory"* ]]; then
    echo "bind mount broken (file became a directory)"; return
  fi
}

# Created from compose files that no longer exist (a deploy copy under /tmp).
# Harmless while its binds survive, but the next `up` will recreate it.
drift_reason() {
  local files f
  files="$(docker inspect "$1" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null)"
  IFS=',' read -ra arr <<<"$files"
  for f in "${arr[@]}"; do
    [[ -z "$f" || -f "$f" ]] || { echo "from $(dirname "$f") (gone)"; return; }
  done
}

# The kernel needs host.yml (LABS + ~/.claude for claude_code agents) and, when
# the driver allows, gpu.yml. A plain `docker compose up` drops both silently.
missing_overrides() {
  local files miss=()
  files="$(docker inspect "$1" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null)"
  [[ "$files" == *docker-compose.host.yml* ]] || miss+=(host.yml)
  if [[ "$GPU_STATE" == on && "$files" != *docker-compose.gpu.yml* ]]; then miss+=(gpu.yml); fi
  ((${#miss[@]})) && echo "${miss[*]}"
  return 0
}

# ── status ───────────────────────────────────────────────────────────────────

cmd_status() {
  printf "${B}%-17s %-11s %-10s %-9s %s${N}\n" SERVICE STATE HEALTH RESTARTS NOTE
  local s c state health restarts note reason
  for s in "${SERVICES[@]}"; do
    c="$(container "$s")"
    if ! docker inspect "$c" >/dev/null 2>&1; then
      printf "%-17s %s\n" "$s" "${R}absent${N}"; continue
    fi
    state="$(docker inspect "$c" --format '{{.State.Status}}')"
    health="$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}')"
    restarts="$(docker inspect "$c" --format '{{.RestartCount}}')"
    note=""
    reason="$(stale_reason "$c")"
    if [[ -n "$reason" ]]; then note="${R}broken: $reason${N}"
    else reason="$(drift_reason "$c")"; [[ -n "$reason" ]] && note="${D}deployed $reason${N}"; fi
    if [[ "$s" == kernel ]]; then
      reason="$(missing_overrides "$c")"
      [[ -n "$reason" ]] && note="${R}degraded: created without ${reason} — run: $0 recreate kernel${N} $note"
    fi
    if [[ "$state" != running ]]; then
      local err code
      code="$(docker inspect "$c" --format '{{.State.ExitCode}}')"
      err="$(docker inspect "$c" --format '{{.State.Error}}' | cut -c1-90)"
      note="$note ${D}exit=$code${err:+ $err}${N}"
    fi
    # Pad first, colour after: escape codes would throw printf widths off.
    local color="$G" rcolor=""
    [[ "$state" != running || "$health" == unhealthy ]] && color="$R"
    (( restarts > 5 )) && rcolor="$R"
    printf -v state "%-11s" "$state"
    printf -v restarts "%-9s" "$restarts"
    printf "%-17s %s %-10s %s %b\n" "$s" "$color$state$N" "$health" "$rcolor$restarts$N" "$note"
  done

  echo
  echo "${B}endpoints${N}"
  probe "dashboard  http://127.0.0.1:3086/" "http://127.0.0.1:3086/"
  # The path the browser takes. 502 here with a healthy kernel = nginx holds a
  # stale kernel IP (menu and every page stop loading).
  local via; via="$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:3086/api/health || true)"
  if [[ "$via" == 200 ]]; then echo "  ${G}✓${N} dashboard → kernel /api/health → 200"
  else echo "  ${R}✗${N} dashboard → kernel /api/health → ${via:-no answer} — if kernel is healthy run: $0 restart dashboard"; fi
  local h
  if h="$(docker exec "$(container kernel)" bun -e \
      "fetch('http://localhost:3087/api/health').then(r=>console.log(r.status)).catch(()=>console.log('down'))" 2>/dev/null)"; then
    [[ "$h" == 200 ]] && echo "  ${G}✓${N} kernel     /api/health → 200" || echo "  ${R}✗${N} kernel     /api/health → $h"
  else
    echo "  ${R}✗${N} kernel     not running"
  fi
  echo
  echo "${D}gpu override: $GPU_STATE${N}"
}

probe() {
  local code
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$2" || true)"
  if [[ "$code" =~ ^(2|3) ]]; then echo "  ${G}✓${N} $1 → $code"
  else echo "  ${R}✗${N} $1 → ${code:-no answer}"; fi
}

# ── lifecycle ────────────────────────────────────────────────────────────────

args_or_all() { if (($#)); then printf '%s\n' "$@"; else printf '%s\n' "${SERVICES[@]}"; fi; }

cmd_up() {
  preflight
  local s targets=() stale=()
  mapfile -t targets < <(args_or_all "$@")
  for s in "${targets[@]}"; do
    valid_service "$s"
    [[ -n "$(stale_reason "$(container "$s")")" ]] && stale+=("$s")
  done
  # Broken containers are recreated from this repo; everything else is just
  # started. --no-build: images are built by reload:local, not by bringing up.
  if ((${#stale[@]})); then
    info "recreating from repo compose: ${stale[*]}"
    compose up -d --no-build --no-deps --force-recreate "${stale[@]}"
  fi
  info "up: ${targets[*]}"
  compose up -d --no-build "${targets[@]}"
  wait_kernel
  cmd_status
}

cmd_recreate() {
  (($#)) || die "recreate needs at least one service"
  preflight
  local s; for s in "$@"; do valid_service "$s"; done
  compose up -d --no-build --no-deps --force-recreate "$@"
  [[ " $* " == *" kernel "* ]] && wait_kernel
  cmd_status
}

cmd_restart() {
  local s targets=()
  mapfile -t targets < <(if (($#)); then printf '%s\n' "$@"; else echo kernel; fi)
  for s in "${targets[@]}"; do
    valid_service "$s"
    local reason; reason="$(stale_reason "$(container "$s")")"
    [[ -n "$reason" ]] && warn "$s is broken ($reason) — a restart will fail; use: $0 recreate $s"
  done
  for s in "${targets[@]}"; do info "restart $s"; docker restart "$(container "$s")" >/dev/null; done
  [[ " ${targets[*]} " == *" kernel "* ]] && wait_kernel
  cmd_status
}

cmd_stop() {
  local s targets=()
  mapfile -t targets < <(args_or_all "$@")
  for s in "${targets[@]}"; do valid_service "$s"; done
  compose stop "${targets[@]}"
}

# nginx in the dashboard resolves `kernel` once, at its own start. A recreated
# kernel gets a new IP and every /api call then 502s (menu never loads) until
# nginx re-resolves.
reload_proxy() {
  local d; d="$(container dashboard)"
  [[ "$(docker inspect "$d" --format '{{.State.Status}}' 2>/dev/null)" == running ]] || return 0
  info "reloading dashboard nginx (re-resolve kernel IP)"
  docker exec "$d" nginx -s reload >/dev/null 2>&1 || warn "nginx reload failed — run: $0 restart dashboard"
}

wait_kernel() {
  local c i st
  c="$(container kernel)"
  info "waiting for kernel health (up to 3 min)…"
  for ((i = 0; i < 36; i++)); do
    st="$(docker inspect "$c" --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || echo missing)"
    [[ "$st" == running/healthy ]] && { info "kernel healthy"; reload_proxy; return 0; }
    sleep 5
  done
  warn "kernel not healthy after 3 min (state: $st) — run: $0 doctor"
  return 0
}

# ── logs / doctor ────────────────────────────────────────────────────────────

cmd_logs() {
  local svc=kernel follow=() since=(--tail 200) errors=0
  while (($#)); do
    case "$1" in
      -f|--follow) follow=(-f) ;;
      --since)     since=(--since "${2:?--since needs a value, e.g. 10m}"); shift ;;
      --errors)    errors=1 ;;
      -*)          die "unknown flag $1" ;;
      *)           valid_service "$1"; svc="$1" ;;
    esac
    shift
  done
  if ((errors)); then
    docker logs "${since[@]}" "${follow[@]}" "$(container "$svc")" 2>&1 \
      | grep --line-buffered -E 'FATAL|ERR|WRN|ERROR|WARN|panic|Error' || true
  else
    docker logs "${since[@]}" "${follow[@]}" "$(container "$svc")" 2>&1
  fi
}

cmd_doctor() {
  cmd_status
  echo
  local c="$(container kernel)"
  local st since
  st="$(docker inspect "$c" --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || echo missing)"
  since="$(docker inspect "$c" --format '{{.State.StartedAt}}' 2>/dev/null | cut -c1-19)"
  if [[ "$st" == running/healthy ]]; then
    echo "${B}kernel: last fatal${N} ${D}(kernel healthy since ${since}Z — this is history)${N}"
  else
    echo "${B}kernel: last fatal${N} ${R}(kernel is $st)${N}"
  fi
  local fatal
  fatal="$(docker logs --tail 3000 "$c" 2>&1 | grep -A4 '\[FATAL\]' | tail -5 || true)"
  if [[ -n "$fatal" ]]; then
    echo "$fatal" | sed 's/^/  /'
    if grep -q 'MtwError' <<<"$fatal"; then
      echo "  ${Y}→ the kernel cannot boot without mtw-request. Check it with: $0 status / $0 logs mtw-request${N}"
    fi
  else
    echo "  ${D}none in the last 3000 lines${N}"
  fi
  echo
  echo "${B}kernel: restarts by SIGTERM (external docker restart)${N}"
  docker logs "$c" 2>&1 | grep -c 'Received SIGTERM' | sed 's/^/  /' || true
}

# ── main ─────────────────────────────────────────────────────────────────────

cmd="${1:-status}"; shift || true
case "$cmd" in
  status)   cmd_status ;;
  up|start) cmd_up "$@" ;;
  restart)  cmd_restart "$@" ;;
  recreate) cmd_recreate "$@" ;;
  stop|down) cmd_stop "$@" ;;
  logs|log) cmd_logs "$@" ;;
  doctor)   cmd_doctor ;;
  -h|--help|help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '$cmd' (status|up|restart|recreate|stop|logs|doctor)" ;;
esac
