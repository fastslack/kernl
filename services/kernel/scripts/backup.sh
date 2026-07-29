#!/bin/bash
# Kernl Backup — creates a portable zip with code, data, and config
# Usage: ./scripts/backup.sh [output-path]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT="${1:-$HOME/kernl-backup-$TIMESTAMP.zip}"

cd "$PROJECT_DIR"

echo "=== Kernl Backup ==="
echo "Project: $PROJECT_DIR"
echo "Output:  $OUTPUT"
echo ""

# Create temp dir for backup contents
TMPDIR=$(mktemp -d)
BACKUP="$TMPDIR/kernl-backup"
mkdir -p "$BACKUP"

# 1. Data (SQLite DB)
if [ -f data/kernel.db ]; then
  echo "[1/5] Copying database..."
  mkdir -p "$BACKUP/data"
  cp data/kernel.db "$BACKUP/data/"
  ls -lh data/kernel.db | awk '{print "      DB size: "$5}'
else
  echo "[1/5] No database found — skipping"
fi

# 2. Config (.env)
if [ -f .env ]; then
  echo "[2/5] Copying .env..."
  cp .env "$BACKUP/"
else
  echo "[2/5] No .env found — skipping"
fi

# 3. WhatsApp auth (if exists)
if [ -d data/whatsapp-auth ]; then
  echo "[3/5] Copying WhatsApp auth..."
  cp -r data/whatsapp-auth "$BACKUP/data/"
else
  echo "[3/5] No WhatsApp auth — skipping"
fi

# 4. Bundled assets (custom sandbox agents + skills)
if [ -d assets ] && [ "$(ls -A assets 2>/dev/null)" ]; then
  echo "[4/5] Copying bundled assets..."
  cp -r assets "$BACKUP/"
else
  echo "[4/5] No bundled assets — skipping"
fi

# 5. Neo4j data export (if running)
if command -v docker &>/dev/null && docker compose ps neo4j 2>/dev/null | grep -q "Up"; then
  echo "[5/6] Exporting Neo4j data..."
  mkdir -p "$BACKUP/neo4j"
  # Export via APOC (cypher export) — works on running server
  # Stop Neo4j, dump, restart (only reliable method for Neo4j 5.x)
  echo "      Stopping Neo4j for dump..."
  docker compose stop neo4j 2>/dev/null || true
  sleep 2
  docker compose run --rm -T neo4j neo4j-admin database dump neo4j --to-stdout > "$BACKUP/neo4j/neo4j.dump" 2>/dev/null || true
  echo "      Restarting Neo4j..."
  docker compose up -d neo4j 2>/dev/null || true
  if [ -s "$BACKUP/neo4j/neo4j.dump" ]; then
    ls -lh "$BACKUP/neo4j/neo4j.dump" | awk '{print "      Neo4j dump: "$5}'
  else
    rm -rf "$BACKUP/neo4j"
    echo "      Neo4j dump failed — will rebuild from SQLite"
  fi
else
  echo "[5/6] Neo4j not running — skipping (will rebuild from SQLite)"
fi

# 6. Create restore script
echo "[6/6] Creating restore script..."
cat > "$BACKUP/restore.sh" << 'RESTORE'
#!/bin/bash
# Kernl Restore — run this in the Kernl project directory
# Usage: cd Kernl && bash /path/to/restore.sh

set -e
RESTORE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Kernl Restore ==="
echo "Restoring from: $RESTORE_DIR"
echo "Into project:   $(pwd)"
echo ""

# Check we're in the right directory
if [ ! -f package.json ] || ! grep -q "kernl" package.json 2>/dev/null; then
  echo "ERROR: Run this from the Kernl project directory"
  echo "  cd Kernl && bash $0"
  exit 1
fi

# Install dependencies
echo "[1/4] Installing dependencies..."
bun install

# Restore data
if [ -f "$RESTORE_DIR/data/kernel.db" ]; then
  echo "[2/4] Restoring database..."
  mkdir -p data
  cp "$RESTORE_DIR/data/kernel.db" data/
  echo "      $(ls -lh data/kernel.db | awk '{print $5}')"
else
  echo "[2/4] No database to restore"
fi

# Restore .env
if [ -f "$RESTORE_DIR/.env" ]; then
  echo "[3/4] Restoring .env..."
  cp "$RESTORE_DIR/.env" .
else
  echo "[3/4] No .env to restore — create one from .env.example"
fi

# Restore extras
if [ -d "$RESTORE_DIR/data/whatsapp-auth" ]; then
  cp -r "$RESTORE_DIR/data/whatsapp-auth" data/
  echo "      WhatsApp auth restored"
fi
if [ -d "$RESTORE_DIR/assets" ]; then
  cp -r "$RESTORE_DIR/assets" .
  echo "      Bundled assets restored"
fi

# Start Neo4j (optional)
echo "[4/4] Starting Neo4j..."
if command -v docker &>/dev/null; then
  docker compose up -d 2>/dev/null || echo "      Docker Compose failed — Neo4j optional"
else
  echo "      Docker not found — Neo4j optional, system works without it"
fi

echo ""
echo "=== Restore complete ==="
echo "Start with: bun run bin/mcp-server.ts"
echo "Dashboard:  http://localhost:3086"
RESTORE

chmod +x "$BACKUP/restore.sh"

# Create zip
echo ""
echo "Creating zip..."
cd "$TMPDIR"
zip -r "$OUTPUT" kernl-backup/ -q
rm -rf "$TMPDIR"

SIZE=$(ls -lh "$OUTPUT" | awk '{print $5}')
echo ""
echo "=== Backup complete ==="
echo "File: $OUTPUT ($SIZE)"
echo ""
echo "To restore on another machine:"
echo "  1. git clone <repo-url> && cd Kernl"
echo "  2. unzip $(basename $OUTPUT)"
echo "  3. bash kernl-backup/restore.sh"
