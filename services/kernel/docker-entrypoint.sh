#!/bin/sh
# Kernel container entrypoint.
#
# Tor used to be started here, behind KERNEL_TOR=1. The kernel runs it now
# (src/core/peering/tor-daemon.ts) from the switch on the Friends page, so it
# can be turned on and off without editing .env or restarting — and so the
# switch can actually stop it: a tor started here would be one the kernel did
# not own. KERNEL_TOR=1 still decides the default until the switch is used.
set -e

exec "$@"
