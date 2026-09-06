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

# `kernl token` — print the API token and exit.
#
# The launcher hands the token to the browser it opens, but that covers exactly
# one browser on one machine. Opening the dashboard from a second browser, a
# private window, or a phone on the LAN lands on a login form, and the only
# answer used to be "read this dotfile", which assumes the user knows the file
# exists and where the data dir went. One command, printable, pipeable.
if [ "${1:-}" = "token" ]; then
  if [ -n "${KERNEL_AUTH_TOKEN:-}" ]; then
    echo "$KERNEL_AUTH_TOKEN"
    exit 0
  fi
  TOKEN_FILE="$DATA_DIR/data/.kernel-auth-token"
  if [ -f "$TOKEN_FILE" ]; then
    cat "$TOKEN_FILE"
    exit 0
  fi
  echo "kernl: no token yet — it is generated on the first boot." >&2
  echo "kernl: start the kernel once (systemctl --user start kernl), then re-run this." >&2
  exit 1
fi

# The kernel resolves data/* relative to its working directory (see
# config.ts: `sqlite.path = ./data/kernel.db`). Anchor it to the per-user
# data dir so each Linux account gets its own isolated DB.
cd "$DATA_DIR"

# Bun reads BUN_INSTALL/_HOME but the vendored binary doesn't need an
# install dir — it just runs the JS. Quiet down its install attempts.
export BUN_INSTALL="$APP_DIR"

# The dashboard requires a Bearer token. When the user hasn't pinned one, the
# kernel generates and persists it on first boot — and then the login screen
# asks for a secret nobody ever showed them. Point at it. (On first run the
# file doesn't exist yet; the kernel prints the token itself as it generates
# it, which is what the journalctl line covers.)
if [ -z "${KERNEL_AUTH_TOKEN:-}" ]; then
  TOKEN_FILE="$DATA_DIR/data/.kernel-auth-token"
  echo "kernl: dashboard at http://localhost:${DASHBOARD_PORT:-3086} — it will ask for an API token." >&2
  if [ -f "$TOKEN_FILE" ]; then
    echo "kernl:   your token:  $(cat "$TOKEN_FILE")" >&2
    echo "kernl:   (stored in $TOKEN_FILE)" >&2
  else
    echo "kernl:   one is being generated now — it's in the log below, and in $TOKEN_FILE" >&2
    echo "kernl:   once it's up, print it with:  kernl token" >&2
  fi
  echo "kernl:   print it any time with:  kernl token" >&2
  echo "kernl:   pin your own with KERNEL_AUTH_TOKEN in $CONFIG_DIR/.env" >&2
fi

exec "$APP_DIR/bin/bun" "$APP_DIR/bin/mcp-server.js" "$@"
