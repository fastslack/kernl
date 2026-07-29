#!/usr/bin/env bash
# Demo Office — diagnóstico + trigger manual del meeting.
#
# 1. Verifica que los 12 agentes demo estén registrados (via HTTP API).
# 2. Saca el ID del VP Engineering (el moderador del standup).
# 3. Llama POST /api/agents/run para disparar el handler `demo:engineering:standup`.
# 4. Sigue los logs filtrados durante 40s para ver el flujo end-to-end.
#
# Uso:
#   bash scripts/demo-trigger-meeting.sh                          # default port 3087
#   KERNEL_URL=http://localhost:3087 bash scripts/...

set -e

KERNEL_URL="${KERNEL_URL:-http://localhost:3087}"
# `docker compose logs` takes a SERVICE name, not the container name.
KERNEL_SERVICE="${KERNEL_SERVICE:-kernel}"

c_red() { printf "\033[31m%s\033[0m" "$1"; }
c_grn() { printf "\033[32m%s\033[0m" "$1"; }
c_ylw() { printf "\033[33m%s\033[0m" "$1"; }
c_blu() { printf "\033[34m%s\033[0m" "$1"; }
c_dim() { printf "\033[2m%s\033[0m" "$1"; }

echo
echo "$(c_blu "==> Demo Office diagnostic")"
echo "    kernel URL: $KERNEL_URL"
echo

# Cache the agent list in /tmp so we don't re-fetch 500KB twice.
CACHE=$(mktemp -t demo-agents.XXXXXX.json)
trap "rm -f $CACHE" EXIT

# ── 1. Demo agents via API ──────────────────────────────────────────────────
echo "$(c_blu "[1/4]") Listing demo agents via $KERNEL_URL/api/agents …"

if ! curl -s --max-time 8 -o "$CACHE" -w "%{http_code}" "$KERNEL_URL/api/agents" | grep -q "^200$"; then
  echo "  $(c_red "✗") Could not reach $KERNEL_URL/api/agents (HTTP non-200)."
  echo "      Try: KERNEL_URL=http://localhost:3087 (kernel direct) or 3086 (dashboard nginx)."
  exit 1
fi

if ! head -c1 "$CACHE" | grep -q '[\[{]'; then
  echo "  $(c_red "✗") Got non-JSON response (preview):"
  head -c 200 "$CACHE"
  echo
  exit 1
fi

# Pull demo agents into a "slug|name|role|handler|active" table.
python3 - "$CACHE" <<'PY' > /tmp/demo-agents.tsv
import sys, json
with open(sys.argv[1]) as f:
    d = json.load(f)
agents = d.get("agents", d) if isinstance(d, dict) else d
demo = [a for a in agents if str(a.get("slug", "")).startswith("demo:")]
print(len(demo))
for a in demo:
    print("|".join([
        a.get("slug", "?"), a.get("name", "?"),
        a.get("role", "?"),
        a.get("builtin_handler", "(none)") or "(none)",
        str(a.get("active", "?")),
        a.get("id", ""),
    ]))
PY

COUNT=$(head -1 /tmp/demo-agents.tsv)
if [ "$COUNT" = "0" ]; then
  echo "  $(c_red "✗") No demo agents (slug starts with 'demo:'). Did the seeder run?"
  echo "      Check: docker compose logs \$KERNEL_SERVICE | grep 'Demo Office'"
  exit 1
fi
echo "  $(c_grn "✓") Found $COUNT demo agent(s):"
tail -n +2 /tmp/demo-agents.tsv | while IFS='|' read -r slug name role handler active id; do
  if [ "$role" = "manager" ]; then icon="👔"; else icon="👤"; fi
  printf "    %s %s — %s  %s\n" "$icon" "$(c_grn "$name")" "$(c_dim "[$role active=$active]")" "$(c_dim "handler=$handler")"
done

# ── 2. Resolve VP Engineering id ────────────────────────────────────────────
echo
echo "$(c_blu "[2/4]") Resolving VP Engineering id…"
VP_ID=$(awk -F'|' '$1=="demo:engineering:vp" { print $6 }' /tmp/demo-agents.tsv | head -1)
if [ -z "$VP_ID" ]; then
  echo "  $(c_red "✗") Slug 'demo:engineering:vp' not found in the agent list."
  exit 1
fi
echo "  $(c_grn "✓") VP_ID=$VP_ID"

# ── 3. Trigger the standup ──────────────────────────────────────────────────
echo
echo "$(c_blu "[3/4]") Triggering standup via POST $KERNEL_URL/api/agents/run …"
RESP=$(curl -s --max-time 5 -X POST "$KERNEL_URL/api/agents/run" \
  -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"$VP_ID\",\"goal\":\"manual demo standup\"}" 2>&1 || true)

if [ -z "$RESP" ]; then
  echo "  $(c_red "✗") Empty response. Aborting."
  exit 1
fi
echo "  $(c_grn "✓") API responded:"
echo "$RESP" | sed 's/^/      /'

RUN_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('run_id',''))" 2>/dev/null || echo "")

# ── 4. Wait for the meeting to play out, then dump filtered logs ───────────
echo
echo "$(c_blu "[4/4]") Waiting 32s for the standup to play out…"
for i in 32 28 24 20 16 12 8 4; do
  printf "  $(c_dim "%ss …") " "$i"
  sleep 4
done
echo

echo
echo "$(c_blu "  Meeting events captured:")"
# Strip ANSI color codes BEFORE grep — docker compose logs always embeds them.
# Use a $'…' literal ESC so it works portably on bash 4+.
ESC=$'\x1b'
docker compose logs --since=35s "$KERNEL_SERVICE" 2>&1 \
  | sed -E "s/${ESC}\[[0-9;]*m//g" \
  | grep -E "demo:engineering:standup|WIRE.*meeting_|WIRE.*chain_triggered|handler entered|kickoff timer fired" \
  | sed -E 's/^[^|]+\|[[:space:]]+([0-9:]+)[[:space:]]+(INF|WRN|ERR)[[:space:]]+(.*)/    \1  \3/' \
  | head -30

echo
if [ -n "$RUN_ID" ]; then
  echo "$(c_blu "==> Run status:")"
  curl -s "$KERNEL_URL/api/agents/runs/$RUN_ID" 2>&1 | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin); r = d.get('run', {})
    print(f\"  status={r.get('status')}\")
    print(f\"  result={(r.get('result') or '')[:200]}\")
    print(f\"  started={r.get('started_at')}\")
    print(f\"  completed={r.get('completed_at')}\")
except Exception as e:
    print(f'  (could not parse run status: {e})')
" 2>&1
fi

echo
echo "$(c_grn "==> Done")"
echo
echo "If you saw '***WIRE*** SENT to ch=agents.flow event=agent:flow:meeting_*' lines,"
echo "the meeting events ARE flowing to the dashboard WebSocket. Open the 3D office:"
echo "  http://localhost:3086/agents-flow   (dashboard nginx)"
echo "  http://localhost:3088/agents-flow   (dashboard-dev hot-reload)"
echo
echo "and watch for walkers converging to a meeting room + the 'Live meeting · X turns'"
echo "toast at the bottom — click it to open the transcript modal."
