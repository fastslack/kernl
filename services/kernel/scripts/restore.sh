#!/bin/bash
# Kernl Full Restore — clone repo + restore data from backup zip
# Usage: bash restore.sh <backup-zip> [target-dir]
#
# Example:
#   bash restore.sh kernl-backup-20260318.zip ~/Kernl

set -e

ZIP="${1:-}"
TARGET="${2:-$(pwd)/Kernl}"

if [ -z "$ZIP" ]; then
  echo "Usage: bash restore.sh <backup-zip> [target-dir]"
  echo ""
  echo "Example:"
  echo "  bash restore.sh kernl-backup-20260318.zip ~/Kernl"
  exit 1
fi

if [ ! -f "$ZIP" ]; then
  echo "ERROR: Backup file not found: $ZIP"
  exit 1
fi

ZIP="$(cd "$(dirname "$ZIP")" && pwd)/$(basename "$ZIP")"

echo "=== Kernl Full Restore ==="
echo "Backup: $ZIP"
echo "Target: $TARGET"
echo ""

# ── Step 1: Clone or verify repo ──
if [ -d "$TARGET/.git" ]; then
  echo "[1/7] Project exists — pulling latest..."
  cd "$TARGET"
  git pull --ff-only 2>/dev/null || echo "      Pull skipped (local changes)"
elif [ -d "$TARGET/package.json" ]; then
  echo "[1/7] Project exists (no git) — using as-is"
  cd "$TARGET"
else
  echo "[1/7] Cloning repository..."
  REPO_URL=$(git -C "$(dirname "$0")" remote get-url origin 2>/dev/null || echo "")
  if [ -z "$REPO_URL" ]; then
    echo "      No remote URL found — create target dir manually and clone your repo there"
    mkdir -p "$TARGET"
    cd "$TARGET"
  else
    git clone "$REPO_URL" "$TARGET"
    cd "$TARGET"
  fi
fi

# ── Step 2: Install dependencies ──
echo "[2/7] Installing dependencies..."
if command -v bun &>/dev/null; then
  bun install --frozen-lockfile 2>/dev/null || bun install
else
  echo "      WARNING: bun not found. Install it: curl -fsSL https://bun.sh/install | bash"
  echo "      Trying npm as fallback..."
  npm install 2>/dev/null || echo "      npm install failed — install bun first"
fi

# ── Step 3: Extract backup ──
echo "[3/7] Extracting backup..."
TMPDIR=$(mktemp -d)
unzip -q "$ZIP" -d "$TMPDIR"

# Find the backup directory (could be nested)
BACKUP_DIR=$(find "$TMPDIR" -name "kernel.db" -o -name ".env" | head -1 | xargs dirname 2>/dev/null)
if [ -z "$BACKUP_DIR" ]; then
  BACKUP_DIR=$(find "$TMPDIR" -type d -name "kernl-backup" | head -1)
fi
if [ -z "$BACKUP_DIR" ]; then
  BACKUP_DIR="$TMPDIR"
fi

echo "      Found backup at: $BACKUP_DIR"

# ── Step 4: Restore database ──
if [ -f "$BACKUP_DIR/data/kernel.db" ]; then
  echo "[4/7] Restoring database..."
  mkdir -p data
  cp "$BACKUP_DIR/data/kernel.db" data/
  SIZE=$(ls -lh data/kernel.db | awk '{print $5}')
  echo "      kernel.db restored ($SIZE)"
else
  echo "[4/7] No database in backup — starting fresh"
fi

# ── Step 5: Restore config ──
if [ -f "$BACKUP_DIR/.env" ]; then
  echo "[5/7] Restoring .env..."
  cp "$BACKUP_DIR/.env" .
  KEYS=$(grep -c "=" .env 2>/dev/null || echo 0)
  echo "      .env restored ($KEYS variables)"
else
  echo "[5/7] No .env in backup — create one from .env.example"
fi

# ── Step 6: Restore extras ──
echo "[6/7] Restoring extras..."
EXTRAS=0

# WhatsApp auth
if [ -d "$BACKUP_DIR/data/whatsapp-auth" ]; then
  mkdir -p data
  cp -r "$BACKUP_DIR/data/whatsapp-auth" data/
  echo "      WhatsApp auth restored"
  EXTRAS=$((EXTRAS + 1))
fi

# Custom agents
if [ -d "$BACKUP_DIR/assets" ] && [ "$(ls -A "$BACKUP_DIR/assets" 2>/dev/null)" ]; then
  cp -r "$BACKUP_DIR/assets" .
  AGENT_COUNT=$(ls assets/plugins/ 2>/dev/null | wc -l)
  echo "      $AGENT_COUNT custom agent(s) restored"
  EXTRAS=$((EXTRAS + 1))
fi

# Chat images
if [ -d "$BACKUP_DIR/data/chat-images" ]; then
  mkdir -p data
  cp -r "$BACKUP_DIR/data/chat-images" data/
  echo "      Chat images restored"
  EXTRAS=$((EXTRAS + 1))
fi

# Security data
if [ -d "$BACKUP_DIR/data/security" ]; then
  mkdir -p data
  cp -r "$BACKUP_DIR/data/security" data/
  echo "      Security data restored"
  EXTRAS=$((EXTRAS + 1))
fi

if [ "$EXTRAS" -eq 0 ]; then
  echo "      No extras to restore"
fi

# Cleanup
rm -rf "$TMPDIR"

# ── Step 7: Build dashboard + start services ──
echo "[7/7] Building dashboard..."
if [ -d "services/dashboard" ]; then
  cd services/dashboard
  npm install --silent 2>/dev/null || bun install 2>/dev/null
  npm run build --silent 2>/dev/null || echo "      Dashboard build failed — not critical"
  cd ..
fi

# Start Neo4j + restore dump if available
if command -v docker &>/dev/null; then
  echo "      Starting Neo4j..."
  docker compose up -d 2>/dev/null || echo "      Docker Compose failed — Neo4j is optional"

  if [ -f "$BACKUP_DIR/neo4j/neo4j.dump" ]; then
    echo "      Restoring Neo4j dump (waiting for Neo4j to start)..."
    sleep 10
    # Stop Neo4j, load dump, restart
    docker compose exec -T neo4j neo4j-admin database load neo4j --from-stdin --overwrite-destination < "$BACKUP_DIR/neo4j/neo4j.dump" 2>/dev/null
    if [ $? -eq 0 ]; then
      docker compose restart neo4j 2>/dev/null
      echo "      Neo4j data restored"
    else
      echo "      Neo4j restore failed — graph will rebuild from SQLite automatically"
    fi
  fi
else
  echo "      Docker not found — Neo4j optional (system works without it)"
fi

echo ""
echo "=========================================="
echo "  Kernl restore complete!"
echo "=========================================="
echo ""
echo "  Project: $TARGET"
echo ""
echo "  Start:"
echo "    cd $TARGET"
echo "    bun run services/kernel/bin/mcp-server.ts"
echo ""
echo "  Dashboard: http://localhost:3086"
echo "  Neo4j:     http://localhost:17474"
echo ""
echo "  MCP config (Claude Desktop):"
echo "    {\"mcpServers\": {\"Kernl\": {\"command\": \"bun\", \"args\": [\"run\", \"$TARGET/services/kernel/bin/mcp-server.ts\"]}}}"
echo ""
