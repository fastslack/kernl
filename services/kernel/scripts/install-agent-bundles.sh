#!/bin/bash
# Pack and install every agent-bundle found under assets/bundles/ (public,
# tracked, ships with the kernel) and assets/personal/ (gitignored,
# instance-specific). Safe to re-run: uninstalls old copy first, then installs.
set -e

KERNEL=${KERNEL:-http://localhost:3087}

# Discover bundles dynamically — any subdir containing an extension.json.
BUNDLES=()
for root in assets/bundles assets/personal; do
  [ -d "$root" ] || continue
  for dir in "$root"/*/; do
    [ -f "$dir/extension.json" ] || continue
    BUNDLES+=("$(basename "$dir")")
  done
done

if [ ${#BUNDLES[@]} -eq 0 ]; then
  echo "No bundles found under assets/bundles/ or assets/personal/"
  exit 0
fi

echo "Discovered ${#BUNDLES[@]} bundle(s): ${BUNDLES[*]}"

for slug in "${BUNDLES[@]}"; do
  echo ""
  echo "=== $slug ==="
  bun run scripts/pack-agent-bundle.ts "$slug" > /dev/null 2>&1 || { echo "  pack failed"; continue; }
  bundle_path="dist/extensions/${slug}-1.0.0.kernlext"
  [ -f "$bundle_path" ] || { echo "  missing $bundle_path"; continue; }

  # Uninstall old copy (ok if 404).
  curl -sS -X POST "$KERNEL/api/extensions/item/com.kernl.$slug/uninstall" > /dev/null 2>&1 || true

  # Install.
  b64=$(base64 -w0 "$bundle_path")
  resp=$(curl -sS -X POST "$KERNEL/api/extensions/upload" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg b64 "$b64" --arg fn "${slug}-1.0.0.kernlext" '{filename:$fn, base64:$b64}')")
  ok=$(echo "$resp" | jq -r '.success // false')
  status=$(echo "$resp" | jq -r '.item.status // "?"')
  echo "  ok=$ok status=$status"
done
