#!/bin/sh
# Kernl — launcher for the portable Linux tarball.
#
# The tarball's counterpart of /usr/bin/kernl in the packages, and it exists
# for the same reason. The kernel resolves data/ against its working directory
# (config.ts: `sqlite.path = ./data/kernel.db`), so running bin/mcp-server.js
# from inside this folder kept the database here — and the in-app update
# replaces this folder, then deletes the old copy once the new one works.
# Anchoring to the per-user data dir keeps the two apart.
#
# POSIX sh: this is the first thing that runs on a fresh machine.

set -eu

# Follow symlinks before taking dirname: `ln -s .../kernl-x.y.z/kernl
# ~/.local/bin/kernl` is the obvious way to put this on PATH, and without this
# APP_DIR became ~/.local/bin and the exec below looked for ~/.local/bin/bin/bun.
# A readlink loop rather than `readlink -f`, which is not POSIX.
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *)  SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
APP_DIR="$(cd "$(dirname "$SELF")" && pwd -P)"
DATA_DIR="${KERNEL_DATA_DIR:-$HOME/.local/share/kernl}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/kernl"

mkdir -p "$DATA_DIR/data" "$DATA_DIR/logs" "$CONFIG_DIR"

# Per-user .env, same file the packages read.
if [ -f "$CONFIG_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$CONFIG_DIR/.env"
  set +a
fi

# `kernl token` — print the API token and exit.
if [ "${1:-}" = "token" ]; then
  if [ -n "${KERNEL_AUTH_TOKEN:-}" ]; then
    echo "$KERNEL_AUTH_TOKEN"
    exit 0
  fi
  if [ -f "$DATA_DIR/data/.kernel-auth-token" ]; then
    cat "$DATA_DIR/data/.kernel-auth-token"
    exit 0
  fi
  echo "kernl: no token yet — it is generated on the first boot." >&2
  exit 1
fi

# Data from before this launcher existed sits in the install folder. Say where
# it is rather than starting over with an empty database next to it.
if [ -f "$APP_DIR/data/kernel.db" ] && [ ! -f "$DATA_DIR/data/kernel.db" ]; then
  echo "kernl: found a database inside the install folder ($APP_DIR/data)." >&2
  echo "kernl: move it so updates cannot touch it:" >&2
  echo "kernl:   mv \"$APP_DIR/data\"/* \"$DATA_DIR/data/\"" >&2
fi

# Bundled mtw-server + whatsapp-bridge (stage-payload.sh, section 2d). The
# kernel supervises them (src/core/bootstrap/sidecars.ts); these exports turn
# on its side of both bridges and point it at the sockets under the data dir.
# Absent from a payload built before the binaries were published, in which
# case nothing changes.
if [ -x "$APP_DIR/bin/mtw-server/mtw-server" ]; then
  export KERNL_BINARY_INSTALL=1 BRIDGE_ENABLED=true RUST_BRIDGE_ENABLED=true
  export KERNEL_URL=ws://127.0.0.1:7741/ws
  export RUST_BRIDGE_SOCKET="$DATA_DIR/run/mtw-rust.sock"
  export KERNL_APP_DIR="$APP_DIR" KERNL_DATA_DIR="$DATA_DIR"
fi

cd "$DATA_DIR"
exec "$APP_DIR/bin/bun" "$APP_DIR/bin/mcp-server.js" "$@"
