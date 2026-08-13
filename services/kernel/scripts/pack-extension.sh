#!/usr/bin/env bash
#
# pack-extension.sh — empaqueta un módulo del kernel como .kernl
#
# Produce un tarball que el runtime de `extensions` puede instalar via
# POST /api/extensions/upload. El bundle contiene:
#
#   extension.json         ← manifest (ExtensionManifest v1)
#   backend/entry.js       ← index.ts del módulo bundled
#   backend/migrations/*   ← migrations si el módulo tiene
#   README.md              ← descripción (si existe)
#
# USO:
#   scripts/pack-extension.sh <module-slug> [output-dir]
#
# EJEMPLO:
#   scripts/pack-extension.sh notes
#   → dist/extensions/notes-1.0.0.kernl
#
# PREQ:
#   - bun instalado en PATH
#   - el módulo debe tener src/modules/<slug>/index.ts con createXxxModule()
#   - (opcional) src/modules/<slug>/extension.json con manifest custom; si no
#     existe se genera uno mínimo automáticamente

set -euo pipefail

SLUG="${1:-}"
OUTDIR="${2:-dist/extensions}"

if [ -z "$SLUG" ]; then
  echo "Usage: $0 <module-slug> [output-dir]" >&2
  exit 1
fi

KERNEL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODULE_DIR="$KERNEL_ROOT/src/modules/$SLUG"
ENTRY="$MODULE_DIR/index.ts"

if [ ! -d "$MODULE_DIR" ]; then
  echo "Error: $MODULE_DIR no existe" >&2
  exit 2
fi
if [ ! -f "$ENTRY" ]; then
  echo "Error: $ENTRY no existe" >&2
  exit 2
fi

echo "📦 Packaging extension: $SLUG"
echo "   Source: $MODULE_DIR"

# ── Staging dir ─────────────────────────────────────────────
STAGING="$(mktemp -d)"
trap "rm -rf '$STAGING'" EXIT
mkdir -p "$STAGING/backend"

# ── Manifest: usar existente o generar uno mínimo ───────────
MANIFEST_SRC="$MODULE_DIR/extension.json"
if [ -f "$MANIFEST_SRC" ]; then
  echo "   Manifest: $MANIFEST_SRC"
  cp "$MANIFEST_SRC" "$STAGING/extension.json"
  VERSION="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$MANIFEST_SRC")"
else
  echo "   Manifest: auto-generated"
  VERSION="1.0.0"
  # Capitalize first letter for display name (works in portable sh)
  NAME_DISPLAY="$(echo "$SLUG" | sed 's/^./\U&/;s/-/ /g')"
  cat > "$STAGING/extension.json" <<EOF
{
  "\$schema": "kernl://extension/v1",
  "id": "com.kernl.${SLUG}",
  "slug": "${SLUG}",
  "name": "${NAME_DISPLAY}",
  "version": "${VERSION}",
  "type": "module",
  "description": "Auto-packaged from src/modules/${SLUG}",
  "author": "Kernl",
  "license": "MIT",
  "category": "feature",
  "backend": {
    "entry": "backend/entry.js"
EOF
  if [ -d "$MODULE_DIR/migrations" ]; then
    echo "    ," >> "$STAGING/extension.json"
    echo "    \"migrations\": \"backend/migrations\"" >> "$STAGING/extension.json"
  fi
  cat >> "$STAGING/extension.json" <<EOF
  }
}
EOF
fi

# ── Bundle del backend ───────────────────────────────────────
echo "   Bundling backend..."
bun build "$ENTRY" \
  --outfile "$STAGING/backend/entry.js" \
  --target bun \
  --format esm \
  --external "better-sqlite3" \
  --external "neo4j-driver" \
  --external "@modelcontextprotocol/sdk" \
  --external "@huggingface/transformers" \
  --external "@anthropic-ai/claude-agent-sdk" \
  --external "@anthropic-ai/sdk" \
  --external "openai" \
  --external "ccxt" \
  --external "cron-parser" \
  --external "jimp" \
  --external "ws" \
  --external "nodemailer" \
  --external "imapflow" \
  --external "zod" \
  --external "uuid" \
  --external "link-preview-js" \
  --external "grammy" \
  --external "discord.js" \
  --external "@slack/bolt" \
  --external "elevenlabs" \
  --external "dotenv" \
  --external "@matware/mtw-request-ts-client" \
  --external "@msgpack/msgpack" \
  2>&1 | tail -5

BUNDLE_SIZE="$(stat -c%s "$STAGING/backend/entry.js" 2>/dev/null || stat -f%z "$STAGING/backend/entry.js")"
echo "   Bundle size: $((BUNDLE_SIZE / 1024)) KB"

# ── Migrations (si existen) ──────────────────────────────────
if [ -d "$MODULE_DIR/migrations" ]; then
  echo "   Copying migrations/"
  cp -r "$MODULE_DIR/migrations" "$STAGING/backend/migrations"
fi

# ── README ───────────────────────────────────────────────────
if [ -f "$MODULE_DIR/README.md" ]; then
  cp "$MODULE_DIR/README.md" "$STAGING/README.md"
fi

# ── Empaquetar ───────────────────────────────────────────────
mkdir -p "$KERNEL_ROOT/$OUTDIR"
OUTFILE="$KERNEL_ROOT/$OUTDIR/${SLUG}-${VERSION}.kernl"

# .kernl = tar.gz con extension.json en la raíz
tar -czf "$OUTFILE" -C "$STAGING" .
OUT_SIZE="$(stat -c%s "$OUTFILE" 2>/dev/null || stat -f%z "$OUTFILE")"

echo ""
echo "✅ Packaged: $OUTFILE"
echo "   Size: $((OUT_SIZE / 1024)) KB"
echo ""
echo "Install with:"
echo "  curl -X POST http://localhost:3086/api/extensions/upload \\"
echo "    -F \"file=@$OUTFILE\""
