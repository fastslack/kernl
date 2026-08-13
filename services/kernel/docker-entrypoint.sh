#!/bin/sh
# Kernel container entrypoint.
#
# Optionally brings up a Tor onion service before starting the kernel. This is
# what lets an instance behind CGNAT or a tethered phone be reachable by its
# friends: the hidden service only ever makes outbound connections, and the
# .onion address is derived from its key, so there is nothing to register and
# no port to forward.
#
# Off unless KERNEL_TOR=1. When off, the kernel simply advertises no onion
# reach entry and everything else works unchanged.
set -e

if [ "$KERNEL_TOR" = "1" ]; then
  TOR_DIR="${KERNEL_TOR_HIDDEN_SERVICE_DIR:-/app/data/tor/kernl}"
  TORRC="/app/data/tor/torrc"
  KERNEL_PORT="${DASHBOARD_PORT:-3087}"

  mkdir -p "$TOR_DIR"
  # tor refuses to start unless the key directory is private to its user.
  chmod 700 "$TOR_DIR"

  # HTTPTunnelPort is tor's own HTTP CONNECT proxy. It exists because Bun's
  # fetch rejects socks5:// outright (UnsupportedProxyProtocol) — this is the
  # only way to reach an .onion from the kernel without adding a SOCKS client
  # dependency.
  cat > "$TORRC" <<EOF
SocksPort 127.0.0.1:${KERNEL_TOR_SOCKS_PORT:-9050}
HTTPTunnelPort 127.0.0.1:${KERNEL_TOR_HTTP_PORT:-9080}
HiddenServiceDir $TOR_DIR
HiddenServicePort 80 127.0.0.1:$KERNEL_PORT
Log notice stdout
EOF

  echo "entrypoint: starting tor (hidden service -> 127.0.0.1:$KERNEL_PORT)"
  tor -f "$TORRC" &

  # Wait briefly for the address so the first presence announcement already
  # carries the onion. Not fatal if it takes longer — the kernel refreshes.
  i=0
  while [ ! -f "$TOR_DIR/hostname" ] && [ "$i" -lt 30 ]; do
    sleep 1
    i=$((i + 1))
  done
  if [ -f "$TOR_DIR/hostname" ]; then
    echo "entrypoint: onion address is $(cat "$TOR_DIR/hostname")"
  else
    echo "entrypoint: tor has not published an address yet; continuing without it"
  fi
fi

exec "$@"
