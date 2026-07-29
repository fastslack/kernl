#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
#  rebuild.sh — recompilá y redeployá el stack público rápido.
#
#  Uso:
#     ./rebuild.sh                  # kernel + dashboard (con cache)
#     ./rebuild.sh dashboard        # solo dashboard
#     ./rebuild.sh kernel           # solo kernel
#     ./rebuild.sh all              # kernel + dashboard (= sin args)
#     ./rebuild.sh dashboard --fresh   # --no-cache (Docker ignora el cache)
#     ./rebuild.sh kernel --ext        # antes recompila los backend/entry.js
#                                      # de las extensiones (build:extensions)
#
#  Flags:
#     --fresh   docker build --no-cache (usalo si "sigue igual" tras un rebuild:
#               Docker cachea el build interno y no toma tus cambios).
#     --ext     corre build:extensions antes del kernel (necesario cuando tocás
#               código bajo assets/extensions/*/_module/ — el backend se compila
#               aparte y NO entra en dist/mcp-server.js).
#     --logs    al terminar, sigue los logs del kernel (docker compose logs -f).
#
#  Qué hace bien (los gotchas que sufrimos a mano):
#   • Tras CUALQUIER rebuild reinicia el dashboard → nginx re-resuelve la IP del
#     kernel. Sin esto, un kernel recreado deja a nginx apuntando a la IP vieja
#     y todo responde 502.
#   • Espera a que /api/health devuelva 200 antes de dar OK.
#   • Opera SIEMPRE sobre el stack público (docker-compose.yml). Para el stack
#     full usá `scripts/dev.sh`.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ── Colores ─────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  B=$'\e[1m'; DIM=$'\e[2m'; G=$'\e[32m'; BL=$'\e[34m'; Y=$'\e[33m'; R=$'\e[31m'; Z=$'\e[0m'
else
  B=""; DIM=""; G=""; BL=""; Y=""; R=""; Z=""
fi
step() { echo "${BL}▸${Z} ${B}$*${Z}"; }
ok()   { echo "${G}✓${Z} $*"; }
warn() { echo "${Y}⚠${Z} $*"; }
die()  { echo "${R}✗${Z} $*" >&2; exit 1; }

# ── Parseo de args ──────────────────────────────────────────────────
SERVICE="all"          # all | kernel | dashboard
NOCACHE=""
DO_EXT=0
FOLLOW_LOGS=0
for a in "$@"; do
  case "$a" in
    kernel|dashboard|all) SERVICE="$a" ;;
    --fresh|--no-cache)   NOCACHE="--no-cache" ;;
    --ext|--extensions)   DO_EXT=1 ;;
    --logs)               FOLLOW_LOGS=1 ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^#//; s/^ //'
      exit 0 ;;
    *) die "arg desconocido: $a (usá -h)" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker no encontrado"
docker compose version >/dev/null 2>&1 || die "docker compose v2 requerido"
[[ -f docker-compose.yml ]] || die "docker-compose.yml no está en $ROOT"

PORT="${DASHBOARD_PORT:-3086}"
HEALTH="http://localhost:${PORT}/api/health"

# Qué servicios tocar
SERVICES=()
case "$SERVICE" in
  all)       SERVICES=(kernel dashboard) ;;
  kernel)    SERVICES=(kernel) ;;
  dashboard) SERVICES=(dashboard) ;;
esac
rebuilds_kernel() { [[ " ${SERVICES[*]} " == *" kernel "* ]]; }

# ── 1) Extensiones (opcional) ───────────────────────────────────────
# El backend de cada extensión (assets/extensions/*/backend/entry.js) se
# compila con build:extensions y se COPIA a la imagen del kernel. Si tocaste
# _module/ y no corrés esto, el kernel usa el bundle viejo.
if [[ $DO_EXT -eq 1 ]]; then
  step "build:extensions (backend/entry.js de las extensiones)"
  ( cd services/kernel && bun run scripts/build-extensions.ts ) \
    || die "build:extensions falló"
  ok "extensiones compiladas"
fi

# ── 2) Build de imágenes ────────────────────────────────────────────
step "Reconstruyendo: ${SERVICES[*]} ${NOCACHE:+(--no-cache)}"
docker compose build $NOCACHE "${SERVICES[@]}" || die "docker compose build falló"
ok "imágenes construidas"

# ── 3) Recrear containers ───────────────────────────────────────────
step "Levantando containers"
docker compose up -d "${SERVICES[@]}" || die "docker compose up falló"

# ── 4) nginx DNS refresh ────────────────────────────────────────────
# El dashboard (nginx) resuelve la IP del kernel al arrancar y la cachea. Si el
# kernel se recreó, hay que reiniciar el dashboard o todas las llamadas /api dan
# 502. Reiniciamos siempre que se haya tocado el kernel (o el dashboard mismo).
if rebuilds_kernel; then
  step "Reiniciando dashboard (refresh de DNS de nginx → kernel)"
  docker restart kernl-public-dashboard >/dev/null 2>&1 || warn "no pude reiniciar el dashboard (¿está corriendo?)"
fi

# ── 5) Esperar health ───────────────────────────────────────────────
step "Esperando /api/health (200)…"
for i in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH" 2>/dev/null || echo 000)"
  if [[ "$code" == "200" ]]; then
    ok "kernel healthy — dashboard en ${B}http://localhost:${PORT}${Z}"
    echo "${DIM}   Refrescá el navegador con Ctrl+Shift+R (el hard refresh evita chunks JS cacheados).${Z}"
    [[ $FOLLOW_LOGS -eq 1 ]] && { echo; exec docker compose logs -f kernel; }
    exit 0
  fi
  sleep 2
done
warn "health no respondió 200 tras 120s — revisá: docker compose logs kernel"
exit 1
