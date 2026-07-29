#!/bin/bash
# Kernl launcher — sets up per-user data dir, sources optional config,
# execs the bundled bun runtime against the bundled kernel.

set -e

APP_DIR="/opt/kernl"
DATA_DIR="${KERNEL_DATA_DIR:-$HOME/.local/share/kernl}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/kernl"

# First-run init — creates the data tree the kernel writes to.
mkdir -p "$DATA_DIR"/{data,logs}
mkdir -p "$CONFIG_DIR"

# Per-user .env — defaults to the system template on first run, then the
# user owns it. Idempotent; never overwrites an existing file.
if [ ! -f "$CONFIG_DIR/.env" ] && [ -f /etc/kernl/env.example ]; then
  cp /etc/kernl/env.example "$CONFIG_DIR/.env"
  echo "kernl: created default config at $CONFIG_DIR/.env" >&2
fi

# Source the .env so DASHBOARD_PORT, KERNEL_AUTH_TOKEN, etc. are visible
# to the kernel without it having to know about /etc/kernl.
if [ -f "$CONFIG_DIR/.env" ]; then
  set -o allexport
  # shellcheck disable=SC1091
  . "$CONFIG_DIR/.env"
  set +o allexport
fi

# The kernel resolves data/* relative to its working directory (see
# config.ts: `sqlite.path = ./data/kernel.db`). Anchor it to the per-user
# data dir so each Linux account gets its own isolated DB.
cd "$DATA_DIR"

# Bun reads BUN_INSTALL/_HOME but the vendored binary doesn't need an
# install dir — it just runs the JS. Quiet down its install attempts.
export BUN_INSTALL="$APP_DIR"

exec "$APP_DIR/bin/bun" "$APP_DIR/bin/mcp-server.js" "$@"
