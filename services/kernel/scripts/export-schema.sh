#!/bin/bash
# Export Kernl SQLite schema
# Usage: ./scripts/export-schema.sh [db-path] [output-path]

DB="${1:-./data/kernel.db}"
OUT="${2:-./SCHEMA.sql}"

if [ ! -f "$DB" ]; then
  echo "Database not found: $DB"
  echo "Start the server first to create tables, then run this script."
  exit 1
fi

echo "-- Kernl SQLite Schema (exported $(date -Iseconds))" > "$OUT"
echo "-- Database: $DB" >> "$OUT"
echo "" >> "$OUT"

sqlite3 "$DB" ".schema" >> "$OUT"

TABLES=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_migration%'")
echo ""
echo "Exported schema for $TABLES tables to $OUT"
