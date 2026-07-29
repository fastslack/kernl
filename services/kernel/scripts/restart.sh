#!/usr/bin/env bash
# restart.sh — Kill all Kernl processes (including Docker) and restart cleanly
set -e

PORT="${DASHBOARD_PORT:-3086}"
echo "[restart] Killing all Kernl processes..."

# Stop Docker container if it's hogging the port
CONTAINER=$(docker ps -q --filter "publish=$PORT" 2>/dev/null || true)
if [ -n "$CONTAINER" ]; then
  echo "[restart] Stopping Docker container $CONTAINER on port $PORT"
  docker stop "$CONTAINER" 2>/dev/null || true
fi

# Kill any bun/node processes running mcp-server
pkill -9 -f "bun.*mcp-server" 2>/dev/null || true
pkill -9 -f "node.*mcp-server" 2>/dev/null || true
pkill -9 -f "tsx.*mcp-server" 2>/dev/null || true

# Wait for port to be free
echo "[restart] Waiting for port $PORT to be free..."
for i in $(seq 1 15); do
  if ! ss -tlnp sport = :"$PORT" 2>/dev/null | grep -q LISTEN; then
    break
  fi
  sleep 1
done

# Final check
if ss -tlnp sport = :"$PORT" 2>/dev/null | grep -q LISTEN; then
  echo "[restart] WARNING: port $PORT still occupied after 15s"
  ss -tlnp sport = :"$PORT"
  PORT=$((PORT + 1))
  echo "[restart] Using port $PORT instead"
fi

echo "[restart] Starting Kernl on port $PORT..."
cd "$(dirname "$0")/.."
DASHBOARD_PORT="$PORT" MCP_TRANSPORT=http nohup bun bin/mcp-server.ts > /tmp/kernl.log 2>&1 &
SERVER_PID=$!
echo "[restart] Server PID: $SERVER_PID"

# Wait for server to be ready
echo "[restart] Waiting for server..."
for i in $(seq 1 20); do
  if curl -s "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo "[restart] Server ready at http://localhost:$PORT"
    curl -s "http://localhost:$PORT/api/health"
    echo ""
    exit 0
  fi
  sleep 1
done

echo "[restart] ERROR: Server didn't start in 20s. Check /tmp/kernl.log"
tail -10 /tmp/kernl.log
exit 1
