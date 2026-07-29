#!/usr/bin/env bash
set -euo pipefail

# ── Kernl · Linux Installer ─────────────────────────────────────
# One-shot installer for Linux. Verifies Docker, clones the required
# sibling repo, generates .env, brings the Docker Compose stack up,
# and (optionally) installs a systemd unit so it starts at boot.
#
# Usage:  ./scripts/install-linux.sh
# ─────────────────────────────────────────────────────────────────────

BOLD=$'\033[1m'; DIM=$'\033[2m'
GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; BLUE=$'\033[0;34m'
NC=$'\033[0m'

step() { printf "\n${BOLD}==> %s${NC}\n" "$1"; }
ok()   { printf "    ${GREEN}[OK]${NC}   %s\n" "$1"; }
warn() { printf "    ${YELLOW}[WARN]${NC} %s\n" "$1"; }
info() { printf "    ${DIM}%s${NC}\n" "$1"; }
die()  { printf "    ${RED}[FAIL]${NC} %s\n" "$1" >&2; exit 1; }

# ── Args ─────────────────────────────────────────────────────────────
INSTALL_SYSTEMD=true
SKIP_BROWSER=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-systemd)  INSTALL_SYSTEMD=false; shift ;;
        --no-browser)  SKIP_BROWSER=true; shift ;;
        -h|--help)
            cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Installs and starts Kernl on Linux via Docker Compose.
Verifies prerequisites, generates .env with sensible defaults,
and (by default) installs a systemd unit. IBKR is disabled.

Options:
  --no-systemd   Skip installing /etc/systemd/system/kernl.service
                 (you start the stack manually with docker compose)
  --no-browser   Don't open the dashboard at the end
  -h, --help     Show this help
EOF
            exit 0 ;;
        *) die "Unknown option: $1 (try --help)" ;;
    esac
done

cat <<EOF

  ${BOLD}┌────────────────────────────────────────┐${NC}
  ${BOLD}│      Kernl · Linux Installer       │${NC}
  ${BOLD}│   Personal Life Management Server      │${NC}
  ${BOLD}└────────────────────────────────────────┘${NC}

EOF

# ── 0. Sanity ────────────────────────────────────────────────────────
[[ "$(uname -s)" == "Linux" ]] || die "This installer is for Linux only. Use scripts/install-macos.sh on macOS."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROJECTS_ROOT="$(dirname "$REPO_ROOT")"
INSTALL_USER="${SUDO_USER:-$USER}"
INSTALL_HOME="$(getent passwd "$INSTALL_USER" | cut -d: -f6)"
[[ -n "$INSTALL_HOME" ]] || INSTALL_HOME="$HOME"
cd "$REPO_ROOT"

DISTRO="unknown"
if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO="${ID:-unknown}"
fi

info "Distro:   $DISTRO ($(uname -r))"
info "User:     $INSTALL_USER ($INSTALL_HOME)"
info "Repo:     $REPO_ROOT"
info "Projects: $PROJECTS_ROOT"

# ── 1. Docker ────────────────────────────────────────────────────────
step "Checking Docker"
if ! command -v docker >/dev/null 2>&1; then
    cat <<EOF
    ${RED}Docker is not installed.${NC}

    Install it with the official script (works on Debian/Ubuntu/Fedora/Arch):

      ${DIM}curl -fsSL https://get.docker.com | sh${NC}

    Then add yourself to the docker group:

      ${DIM}sudo usermod -aG docker $INSTALL_USER${NC}
      ${DIM}newgrp docker${NC}

    And re-run this installer.
EOF
    exit 1
fi
ok "$(docker --version)"

if ! docker compose version >/dev/null 2>&1; then
    die "Docker Compose plugin missing. Install: docker-compose-plugin (apt/dnf) or docker-compose (pacman)."
fi
ok "$(docker compose version | head -1)"

step "Checking Docker daemon"
if docker info >/dev/null 2>&1; then
    ok "Daemon running"
else
    info "Daemon not running — attempting: sudo systemctl start docker"
    sudo systemctl start docker || die "Could not start docker. Check: systemctl status docker"
    sleep 2
    docker info >/dev/null 2>&1 || die "Daemon still not responding"
    ok "Daemon started"
fi

step "Checking docker group membership"
if id -nG "$INSTALL_USER" | tr ' ' '\n' | grep -qx docker; then
    ok "$INSTALL_USER is in the docker group"
else
    warn "$INSTALL_USER is not in the docker group"
    info "Adding (requires sudo)..."
    sudo usermod -aG docker "$INSTALL_USER"
    warn "Group change takes effect on next login. For this shell run: newgrp docker"
    info "Continuing — current shell still uses sudo for docker calls if needed."
fi

# Make sure docker is enabled at boot
if ! systemctl is-enabled --quiet docker 2>/dev/null; then
    info "Enabling docker.service at boot"
    sudo systemctl enable docker.service >/dev/null
fi

# ── 2. Sibling repo: mtwRequest ──────────────────────────────────────
step "Checking sibling repo (mtwRequest)"
KERNEL_REQUEST_DIR="$PROJECTS_ROOT/mtwRequest"
if [[ -d "$KERNEL_REQUEST_DIR/.git" ]]; then
    ok "Already cloned at $KERNEL_REQUEST_DIR"
else
    warn "Cloning mtwRequest into $KERNEL_REQUEST_DIR"
    git clone https://github.com/fastslack/mtwRequest.git "$KERNEL_REQUEST_DIR" \
        || die "Could not clone mtwRequest. If the repo is private, clone it manually into $KERNEL_REQUEST_DIR and re-run."
    ok "Cloned"
fi

WA_BRIDGE_DIR="$KERNEL_REQUEST_DIR/services/whatsapp-bridge"
[[ -d "$WA_BRIDGE_DIR" ]] || warn "WhatsApp bridge subdir not found at $WA_BRIDGE_DIR"

# ── 3. .env generation ───────────────────────────────────────────────
step "Configuring .env"
if [[ -f .env ]]; then
    ok ".env already exists — leaving it untouched"
    ENV_CREATED=false
else
    cp .env.example .env
    chmod 600 .env
    ok "Created .env (mode 600)"
    ENV_CREATED=true
fi

# GNU sed (Linux) — no '' after -i
set_env() {
    local key="$1" val="$2"
    local escaped="${val//|/\\|}"
    if grep -qE "^${key}=" .env; then
        sed -i "s|^${key}=.*|${key}=${escaped}|" .env
    else
        printf "\n%s=%s\n" "$key" "$val" >> .env
    fi
}

fill_secret() {
    local key="$1"
    local current
    current="$(grep -E "^${key}=" .env | head -1 | cut -d'=' -f2- || true)"
    if [[ -z "$current" ]]; then
        set_env "$key" "$(openssl rand -hex 32)"
        ok "Generated $key"
    else
        ok "$key already set"
    fi
}
fill_secret KERNEL_ENCRYPTION_KEY
fill_secret KERNEL_AUTH_TOKEN

set_env HOST_HOME              "$INSTALL_HOME"
set_env HOST_KERNEL_ROOT       "$REPO_ROOT"
set_env HOST_PROJECTS_ROOT     "$PROJECTS_ROOT"
set_env KERNEL_REQUEST_SRC        "$KERNEL_REQUEST_DIR"
set_env KERNEL_WHATSAPP_BRIDGE_SRC "$WA_BRIDGE_DIR"
ok "Host paths written"

set_env IBKR_ENABLED       false
set_env WHATSAPP_ENABLED   false
set_env TELEGRAM_ENABLED   false
set_env SLACK_ENABLED      false
set_env DISCORD_ENABLED    false
ok "IBKR / WhatsApp / Telegram / Slack / Discord disabled by default"

# ── 4. Data dirs ─────────────────────────────────────────────────────
mkdir -p data data/commander-workspace
ok "Data directories ready"

# ── 5. Build & start ─────────────────────────────────────────────────
step "Building images and starting stack"
info "First build pulls bun:1.2 + neo4j:5.22 — give it a few minutes."

docker compose pull --ignore-buildable 2>/dev/null || true

# Run dashboard build with current uid:gid so node_modules are owner-writable
info "Building dashboard bundle..."
docker compose run --rm --user "$(id -u):$(id -g)" dashboard-build >/dev/null 2>&1 \
    || warn "dashboard-build returned non-zero — continuing"

docker compose up -d --build neo4j kernel dashboard

# ── 6. Health ────────────────────────────────────────────────────────
step "Waiting for services"
WAIT=0; MAX=120
while (( WAIT < MAX )); do
    if curl -sf "http://localhost:3087/api/health" >/dev/null 2>&1; then
        ok "Kernel API is healthy (port 3087)"
        break
    fi
    sleep 3; WAIT=$((WAIT+3))
    printf "    ${DIM}kernel... %ds/%ds${NC}\r" "$WAIT" "$MAX"
done
echo
(( WAIT < MAX )) || warn "Kernel did not become healthy in ${MAX}s — check: docker compose logs -f kernel"

if curl -sf "http://localhost:3086" >/dev/null 2>&1; then
    ok "Dashboard reachable (port 3086)"
else
    warn "Dashboard not yet reachable — refresh http://localhost:3086 in a moment"
fi

NEO4J_PASS="$(grep -oE '^NEO4J_PASSWORD=.*' .env | cut -d'=' -f2- || echo password)"
if docker exec mtw-neo4j cypher-shell -u neo4j -p "$NEO4J_PASS" "RETURN 1" >/dev/null 2>&1; then
    ok "Neo4j is up"
else
    warn "Neo4j still initializing (GDS plugin takes ~30s on first boot)"
fi

# ── 7. systemd unit ──────────────────────────────────────────────────
if [[ "$INSTALL_SYSTEMD" == "true" ]]; then
    step "Installing systemd unit"
    TEMPLATE="$REPO_ROOT/packaging/systemd/kernl.service.in"
    UNIT_PATH="/etc/systemd/system/kernl.service"
    DOCKER_BIN="$(command -v docker)"

    if [[ ! -f "$TEMPLATE" ]]; then
        warn "Template missing at $TEMPLATE — skipping systemd install"
    else
        info "Writing $UNIT_PATH"
        sudo tee "$UNIT_PATH" >/dev/null < <(
            sed -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
                -e "s|__USER__|$INSTALL_USER|g" \
                -e "s|__DOCKER_BIN__|$DOCKER_BIN|g" \
                "$TEMPLATE"
        )
        sudo systemctl daemon-reload
        sudo systemctl enable kernl.service >/dev/null
        ok "kernl.service installed and enabled"
        info "It will start automatically on next boot."
        info "Manage now with: sudo systemctl {status|restart|stop} kernl"
    fi
else
    info "Skipping systemd unit (--no-systemd)"
fi

# ── 8. Done ──────────────────────────────────────────────────────────
cat <<EOF

  ${BOLD}┌────────────────────────────────────────┐${NC}
  ${BOLD}│        Installation Complete           │${NC}
  ${BOLD}└────────────────────────────────────────┘${NC}

  ${BOLD}URLs:${NC}
    Dashboard    ${BLUE}http://localhost:3086${NC}
    Kernel API   ${BLUE}http://localhost:3087/api${NC}
    MCP HTTP     ${BLUE}http://localhost:3086/mcp${NC}
    Neo4j        ${BLUE}http://localhost:17474${NC}  ${DIM}(neo4j / $NEO4J_PASS)${NC}

  ${BOLD}MCP client (Claude Desktop / Cursor):${NC}
    ${DIM}{
      "mcpServers": {
        "kernl": {
          "type": "streamable-http",
          "url": "http://localhost:3086/mcp"
        }
      }
    }${NC}

  ${BOLD}Manage the stack:${NC}
EOF
if [[ "$INSTALL_SYSTEMD" == "true" ]]; then
    cat <<EOF
    ${DIM}sudo systemctl status kernl${NC}     systemd state
    ${DIM}sudo systemctl restart kernl${NC}    restart whole stack
    ${DIM}sudo journalctl -u kernl -f${NC}     systemd logs (orchestration)
EOF
fi
cat <<EOF
    ${DIM}docker compose ps${NC}                   per-container status
    ${DIM}docker compose logs -f kernel${NC}       follow kernel logs
    ${DIM}docker compose down${NC}                 stop everything

EOF

if [[ "$ENV_CREATED" == "true" ]]; then
    cat <<EOF
  ${YELLOW}Next:${NC} edit ${BOLD}.env${NC} to add LLM API keys
        (OPENAI_API_KEY, ANTHROPIC_API_KEY, GROK_API_KEY, NVIDIA_API_KEY).
        Then: ${DIM}sudo systemctl restart kernl${NC}  ${DIM}# (or: docker compose restart kernel)${NC}

EOF
fi

if [[ "$SKIP_BROWSER" != "true" ]]; then
    xdg-open "http://localhost:3086" >/dev/null 2>&1 || true
fi
