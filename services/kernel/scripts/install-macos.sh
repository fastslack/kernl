#!/usr/bin/env bash
set -euo pipefail

# ── Kernl · macOS Installer ─────────────────────────────────────
# One-shot installer for macOS. Checks every prerequisite, installs
# what's missing, generates .env with sane defaults, clones the
# required sibling repo, and brings the full Docker Compose stack up.
#
# Usage:  ./scripts/install-macos.sh
# ─────────────────────────────────────────────────────────────────────

# Colors (no fancy chars — works in any Terminal.app)
BOLD=$'\033[1m'; DIM=$'\033[2m'
GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; BLUE=$'\033[0;34m'
NC=$'\033[0m'

step() { printf "\n${BOLD}==> %s${NC}\n" "$1"; }
ok()   { printf "    ${GREEN}[OK]${NC}   %s\n" "$1"; }
warn() { printf "    ${YELLOW}[WARN]${NC} %s\n" "$1"; }
info() { printf "    ${DIM}%s${NC}\n" "$1"; }
die()  { printf "    ${RED}[FAIL]${NC} %s\n" "$1" >&2; exit 1; }

# ── Args ─────────────────────────────────────────────────────────────
ENGINE_OVERRIDE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --engine=*) ENGINE_OVERRIDE="${1#--engine=}"; shift ;;
        --engine)   ENGINE_OVERRIDE="${2:-}"; shift 2 ;;
        -h|--help)
            cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Installs and starts Kernl on macOS via Docker Compose.
Auto-installs prerequisites (Xcode CLT, Homebrew, container engine)
and generates .env with sensible defaults. IBKR is disabled.

Options:
  --engine=<name>   Container engine to use. One of:
                      colima           lightweight, free      (default install)
                      orbstack         fastest, freemium
                      docker-desktop   official, heaviest
  -h, --help        Show this help

If --engine is omitted, the installer reuses any running Docker
daemon. Otherwise it picks (in order): orbstack, colima, docker-desktop
if installed; or installs Colima as the lightweight default.
EOF
            exit 0 ;;
        *) die "Unknown option: $1 (try --help)" ;;
    esac
done
case "${ENGINE_OVERRIDE:-}" in
    ""|colima|orbstack|docker-desktop) ;;
    *) die "Invalid --engine '$ENGINE_OVERRIDE'. Use: colima | orbstack | docker-desktop" ;;
esac

cat <<EOF

  ${BOLD}┌────────────────────────────────────────┐${NC}
  ${BOLD}│      Kernl · macOS Installer       │${NC}
  ${BOLD}│   Personal Life Management Server      │${NC}
  ${BOLD}└────────────────────────────────────────┘${NC}

  ${DIM}Docker Compose path. Installs prerequisites, clones siblings,
  generates configuration, and starts the full stack.
  Supported container engines: Colima · OrbStack · Docker Desktop.${NC}

EOF

# ── 0. Sanity ────────────────────────────────────────────────────────
[[ "$(uname -s)" == "Darwin" ]] || die "This installer is for macOS only. Use scripts/install.sh on Linux."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROJECTS_ROOT="$(dirname "$REPO_ROOT")"
cd "$REPO_ROOT"

ARCH="$(uname -m)"
info "macOS $(sw_vers -productVersion) · $ARCH"
info "Repo:     $REPO_ROOT"
info "Projects: $PROJECTS_ROOT"

# ── 1. Xcode Command Line Tools ──────────────────────────────────────
step "Checking Xcode Command Line Tools"
if xcode-select -p >/dev/null 2>&1; then
    ok "Already installed ($(xcode-select -p))"
else
    warn "Not installed — launching Apple installer"
    xcode-select --install || true
    cat <<EOF

    A dialog should have appeared. Click ${BOLD}Install${NC}, accept the license,
    wait for it to finish (a few minutes), then re-run this script.

EOF
    exit 1
fi

# ── 2. Homebrew ──────────────────────────────────────────────────────
step "Checking Homebrew"
if command -v brew >/dev/null 2>&1; then
    ok "$(brew --version | head -1)"
else
    warn "Not installed — running Homebrew installer (will prompt for password)"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [[ "$ARCH" == "arm64" ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    else
        eval "$(/usr/local/bin/brew shellenv)"
    fi
    ok "Homebrew installed"
fi

# ── 3. Container engine (Colima · OrbStack · Docker Desktop) ─────────
step "Selecting container engine"

engine_installed() {
    case "$1" in
        colima)         command -v colima >/dev/null 2>&1 ;;
        orbstack)       [[ -d "/Applications/OrbStack.app" ]] ;;
        docker-desktop) [[ -d "/Applications/Docker.app" ]] ;;
    esac
}

install_engine() {
    case "$1" in
        colima)
            info "Installing Colima + docker CLI + compose plugin"
            brew install colima docker docker-compose
            mkdir -p "$HOME/.docker/cli-plugins"
            ln -sfn "$(brew --prefix)/opt/docker-compose/bin/docker-compose" \
                    "$HOME/.docker/cli-plugins/docker-compose"
            ;;
        orbstack)
            info "Installing OrbStack (~200 MB)"
            brew install --cask orbstack
            ;;
        docker-desktop)
            info "Installing Docker Desktop (~700 MB)"
            brew install --cask docker
            ;;
    esac
}

start_engine() {
    case "$1" in
        colima)
            info "Starting Colima VM (cpu=4, mem=6 GB, disk=60 GB)"
            colima start --cpu 4 --memory 6 --disk 60
            ;;
        orbstack)
            info "Launching OrbStack.app"
            open -a OrbStack
            ;;
        docker-desktop)
            info "Launching Docker.app"
            open -a Docker
            ;;
    esac
}

wait_for_daemon() {
    local max=120 waited=0
    while ! docker info >/dev/null 2>&1; do
        sleep 3; waited=$((waited+3))
        printf "    ${DIM}waiting for daemon... %ds/%ds${NC}\r" "$waited" "$max"
        if (( waited >= max )); then
            echo
            die "Daemon did not start in ${max}s. Start the engine manually and re-run."
        fi
    done
    echo
}

identify_running_engine() {
    if command -v orb >/dev/null 2>&1 && pgrep -qf OrbStack 2>/dev/null; then
        echo "OrbStack"
    elif pgrep -qf "Docker Desktop" 2>/dev/null || pgrep -qf "Docker.app" 2>/dev/null; then
        echo "Docker Desktop"
    elif pgrep -qf "colima" 2>/dev/null; then
        echo "Colima"
    else
        echo "unknown"
    fi
}

# Decide which engine to use
ENGINE=""
if [[ -n "$ENGINE_OVERRIDE" ]]; then
    ENGINE="$ENGINE_OVERRIDE"
    info "Engine forced via --engine: $ENGINE"
elif docker info >/dev/null 2>&1; then
    ENGINE="already-running"
elif engine_installed orbstack; then
    ENGINE="orbstack"
elif engine_installed colima; then
    ENGINE="colima"
elif engine_installed docker-desktop; then
    ENGINE="docker-desktop"
else
    ENGINE="colima"   # lightweight default — open source, free, ~200 MB
    info "No container engine found — defaulting to Colima (lightweight, open source)"
fi

if [[ "$ENGINE" == "already-running" ]]; then
    ok "Docker daemon already running ($(identify_running_engine))"
else
    if engine_installed "$ENGINE"; then
        ok "$ENGINE already installed"
    else
        install_engine "$ENGINE"
        ok "$ENGINE installed"
    fi
    if ! docker info >/dev/null 2>&1; then
        start_engine "$ENGINE"
        wait_for_daemon
    fi
    ok "Engine running: $ENGINE"
fi

ok "$(docker --version)"
ok "$(docker compose version | head -1)"

# ── 4. Sibling repo: mtwRequest ──────────────────────────────────────
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
if [[ ! -d "$WA_BRIDGE_DIR" ]]; then
    warn "WhatsApp bridge subdir not found at $WA_BRIDGE_DIR"
    info "Compose will fail to build the bridge — file an issue if this persists."
fi

# ── 5. .env generation ───────────────────────────────────────────────
step "Configuring .env"
if [[ -f .env ]]; then
    ok ".env already exists — leaving it untouched"
    ENV_CREATED=false
else
    cp .env.example .env
    ok "Created .env from template"
    ENV_CREATED=true
fi

# BSD sed (macOS) needs '' after -i
set_env() {
    local key="$1" val="$2"
    if grep -qE "^${key}=" .env; then
        # Escape | in value (used as sed delimiter)
        local escaped="${val//|/\\|}"
        sed -i '' "s|^${key}=.*|${key}=${escaped}|" .env
    else
        printf "\n%s=%s\n" "$key" "$val" >> .env
    fi
}

# Fill empty secrets
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

# Host paths
set_env HOST_HOME           "$HOME"
set_env HOST_KERNEL_ROOT    "$REPO_ROOT"
set_env HOST_PROJECTS_ROOT  "$PROJECTS_ROOT"
set_env KERNEL_REQUEST_SRC     "$KERNEL_REQUEST_DIR"
set_env KERNEL_WHATSAPP_BRIDGE_SRC "$WA_BRIDGE_DIR"
ok "Host paths written"

# Disable optional integrations by default (user can flip them later)
set_env IBKR_ENABLED       false
set_env WHATSAPP_ENABLED   false
set_env TELEGRAM_ENABLED   false
set_env SLACK_ENABLED      false
set_env DISCORD_ENABLED    false
ok "IBKR / WhatsApp / Telegram / Slack / Discord disabled by default"

# ── 6. Data dir ──────────────────────────────────────────────────────
mkdir -p data data/commander-workspace
ok "Data directories ready"

# ── 7. Build & start ─────────────────────────────────────────────────
step "Building images and starting stack"
info "First build pulls bun:1.2 + neo4j:5.22 — give it a few minutes."

# Pull what we can in parallel (cached images won't redownload)
docker compose pull --ignore-buildable 2>/dev/null || true

# Build the dashboard SPA so nginx has something to serve
info "Building dashboard bundle..."
docker compose run --rm dashboard-build >/dev/null 2>&1 || warn "dashboard-build returned non-zero — continuing"

# Bring up: kernel + dashboard + neo4j + mtw-request + whatsapp-bridge
# (IBKR is behind the 'ibkr' profile and stays off.)
docker compose up -d --build neo4j kernel dashboard

# ── 8. Health ────────────────────────────────────────────────────────
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
    warn "Dashboard not yet reachable — give it a moment, then refresh http://localhost:3086"
fi

NEO4J_PASS="$(grep -oE '^NEO4J_PASSWORD=.*' .env | cut -d'=' -f2- || echo password)"
if docker exec mtw-neo4j cypher-shell -u neo4j -p "$NEO4J_PASS" "RETURN 1" >/dev/null 2>&1; then
    ok "Neo4j is up"
else
    warn "Neo4j still initializing (GDS plugin takes ~30s on first boot)"
fi

# ── 9. Done ──────────────────────────────────────────────────────────
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
    ${DIM}docker compose ps${NC}                  status
    ${DIM}docker compose logs -f kernel${NC}      follow kernel logs
    ${DIM}docker compose restart kernel${NC}      restart kernel
    ${DIM}docker compose down${NC}                stop everything

EOF

if [[ "$ENV_CREATED" == "true" ]]; then
    cat <<EOF
  ${YELLOW}Next:${NC} edit ${BOLD}.env${NC} to add LLM API keys
        (OPENAI_API_KEY, ANTHROPIC_API_KEY, GROK_API_KEY, NVIDIA_API_KEY).
        Then: ${DIM}docker compose restart kernel${NC}

EOF
fi

# Open the dashboard automatically — user explicitly asked for "do it all"
open "http://localhost:3086" 2>/dev/null || true
