#!/usr/bin/env bash
set -e

echo ""
echo "setup.sh is deprecated — use the Docker installer instead:"
echo ""
echo "  ./install.sh              Full install (kernel + dashboard + Neo4j)"
echo "  ./install.sh --no-neo4j   Without Neo4j (lighter, SQLite only)"
echo "  ./install.sh --help       All options"
echo ""

# Forward to install.sh if it exists (vive junto a este script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/install.sh" ]; then
    exec "$SCRIPT_DIR/install.sh" "$@"
else
    echo "Error: install.sh not found in $SCRIPT_DIR"
    exit 1
fi
