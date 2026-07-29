#!/usr/bin/env bash
set -e

# ── Kernl Docker Installer ──────────────────────────────────────
# Only requires: Docker + Docker Compose
# Builds and runs: kernel (API) + dashboard (SvelteKit) + Neo4j (graph)
# ─────────────────────────────────────────────────────────────────────

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Raíz del repo: acá viven docker-compose*.yml y .env.example.
cd "$SCRIPT_DIR/../../.."

# ── Header ────────────────────────────────────────────
echo ""
echo -e "${BOLD}  ┌─────────────────────────────────────┐${NC}"
echo -e "${BOLD}  │       Kernl  Docker Install      │${NC}"
echo -e "${BOLD}  │   Personal Life Management Server    │${NC}"
echo -e "${BOLD}  └─────────────────────────────────────┘${NC}"
echo ""

# ── Parse flags ───────────────────────────────────────
SKIP_NEO4J=false
NO_BUILD=false
DETACH=true

while [[ $# -gt 0 ]]; do
    case $1 in
        --no-neo4j)    SKIP_NEO4J=true; shift ;;
        --no-build)    NO_BUILD=true; shift ;;
        --foreground)  DETACH=false; shift ;;
        --help|-h)
            echo "Usage: ./install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --no-neo4j     Skip Neo4j (graph features disabled, saves ~1GB RAM)"
            echo "  --no-build     Skip Docker build (use existing images)"
            echo "  --foreground   Run in foreground (see logs directly)"
            echo "  -h, --help     Show this help"
            echo ""
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Run ./install.sh --help for usage"
            exit 1
            ;;
    esac
done

# ── Step 1: Check prerequisites ──────────────────────
echo -e "${BOLD}Checking prerequisites...${NC}"
echo ""

# Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}[FAIL]${NC} Docker is not installed"
    echo ""
    echo "  Install Docker: https://docs.docker.com/get-docker/"
    exit 1
fi
DOCKER_VERSION=$(docker --version 2>/dev/null | head -1)
echo -e "${GREEN}  [OK]${NC} $DOCKER_VERSION"

# Docker Compose (bundled with Docker since v20.10+)
if ! docker compose version &> /dev/null; then
    echo -e "${RED}[FAIL]${NC} docker compose not available — update Docker"
    echo ""
    echo "  Install/update: https://docs.docker.com/get-docker/"
    exit 1
fi
echo -e "${GREEN}  [OK]${NC} $(docker compose version 2>/dev/null | head -1)"

# Docker daemon running
if ! docker info &> /dev/null 2>&1; then
    echo -e "${RED}[FAIL]${NC} Docker daemon is not running"
    echo ""
    echo "  Start Docker and try again"
    exit 1
fi
echo -e "${GREEN}  [OK]${NC} Docker daemon is running"
echo ""

# ── Step 2: Environment file ─────────────────────────
echo -e "${BOLD}Configuring environment...${NC}"
echo ""

if [ ! -f .env ]; then
    cp .env.example .env
    # Auto-generate the mandatory secrets so the kernel boots out of the box.
    if command -v openssl >/dev/null 2>&1; then
        sed -i.bak \
            -e "s|^KERNEL_AUTH_TOKEN=.*|KERNEL_AUTH_TOKEN=$(openssl rand -hex 32)|" \
            -e "s|^KERNEL_ENCRYPTION_KEY=.*|KERNEL_ENCRYPTION_KEY=$(openssl rand -hex 32)|" \
            -e "s|^NEO4J_PASSWORD=.*|NEO4J_PASSWORD=$(openssl rand -hex 16)|" \
            .env && rm -f .env.bak
        echo -e "${GREEN}  [OK]${NC} Generated KERNEL_AUTH_TOKEN, KERNEL_ENCRYPTION_KEY and NEO4J_PASSWORD"
    else
        echo -e "${YELLOW}  [!!]${NC} openssl not found — set KERNEL_AUTH_TOKEN, KERNEL_ENCRYPTION_KEY and NEO4J_PASSWORD in .env manually"
    fi
    echo -e "${GREEN}  [OK]${NC} Created .env from .env.example"
    echo -e "${YELLOW}       Edit .env to add API keys and customize settings${NC}"
    ENV_CREATED=true
else
    echo -e "${GREEN}  [OK]${NC} .env already exists"
    ENV_CREATED=false
fi

# ── Step 3: Data directory ────────────────────────────
mkdir -p data
echo -e "${GREEN}  [OK]${NC} Data directory ready (./data)"
echo ""

# ── Step 4: Build & start ────────────────────────────
echo -e "${BOLD}Starting services...${NC}"
echo ""

# Determine which services to start
SERVICES="kernel dashboard"
if [ "$SKIP_NEO4J" = false ]; then
    SERVICES="neo4j $SERVICES"
fi

# Build flags
BUILD_FLAG=""
if [ "$NO_BUILD" = false ]; then
    BUILD_FLAG="--build"
fi

# Detach flag
DETACH_FLAG=""
if [ "$DETACH" = true ]; then
    DETACH_FLAG="-d"
fi

if [ "$SKIP_NEO4J" = true ]; then
    echo -e "${YELLOW}  [SKIP]${NC} Neo4j (--no-neo4j flag)"
    echo -e "${DIM}         Graph features will be unavailable${NC}"
fi

echo -e "${DIM}  Building and starting containers...${NC}"
echo ""

docker compose up $BUILD_FLAG $DETACH_FLAG $SERVICES

# If running in foreground, we won't reach here
if [ "$DETACH" = false ]; then
    exit 0
fi

# ── Step 5: Wait for health ──────────────────────────
echo ""
echo -e "${BOLD}Waiting for services to be ready...${NC}"
echo ""

# Wait for kernel health (max 90s)
WAIT_MAX=90
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $WAIT_MAX ]; do
    if curl -sf http://localhost:3087/api/health > /dev/null 2>&1; then
        echo -e "${GREEN}  [OK]${NC} Kernel API is healthy"
        break
    fi
    WAIT_COUNT=$((WAIT_COUNT + 3))
    sleep 3
    printf "\r${DIM}  Waiting for kernel... (%ds/%ds)${NC}" "$WAIT_COUNT" "$WAIT_MAX"
done

if [ $WAIT_COUNT -ge $WAIT_MAX ]; then
    echo ""
    echo -e "${YELLOW}  [WARN]${NC} Kernel did not become healthy in ${WAIT_MAX}s"
    echo -e "${DIM}         Check logs: docker compose logs kernel${NC}"
fi

# Check dashboard
if curl -sf http://localhost:3086 > /dev/null 2>&1; then
    echo -e "${GREEN}  [OK]${NC} Dashboard is reachable"
else
    echo -e "${YELLOW}  [WAIT]${NC} Dashboard may still be starting..."
fi

# Check Neo4j (if not skipped)
if [ "$SKIP_NEO4J" = false ]; then
    NEO4J_PASS=$(grep -oP '^NEO4J_PASSWORD=\K.*' .env 2>/dev/null || echo "password")
    if docker exec mtw-neo4j cypher-shell -u neo4j -p "$NEO4J_PASS" "RETURN 1" > /dev/null 2>&1; then
        echo -e "${GREEN}  [OK]${NC} Neo4j is healthy"
    else
        echo -e "${YELLOW}  [WAIT]${NC} Neo4j may still be initializing (GDS plugin takes ~30s)..."
    fi
fi

# ── Step 6: Summary ──────────────────────────────────
echo ""
echo -e "${BOLD}  ┌─────────────────────────────────────┐${NC}"
echo -e "${BOLD}  │         Installation Complete        │${NC}"
echo -e "${BOLD}  └─────────────────────────────────────┘${NC}"
echo ""
echo -e "  ${BOLD}Services:${NC}"
echo -e "    Dashboard    ${BLUE}http://localhost:3086${NC}"
echo -e "    Kernel API   ${BLUE}http://localhost:3087${NC}/api"
echo -e "    MCP (HTTP)   ${BLUE}http://localhost:3086${NC}/mcp"
if [ "$SKIP_NEO4J" = false ]; then
echo -e "    Neo4j        ${BLUE}http://localhost:17474${NC}  (credentials in .env)"
fi
echo ""
echo -e "  ${BOLD}MCP Client Config:${NC}"
echo -e "    Add to your Claude/Cursor settings:"
echo ""
echo -e "    ${DIM}{${NC}"
echo -e "    ${DIM}  \"mcpServers\": {${NC}"
echo -e "    ${DIM}    \"kernl\": {${NC}"
echo -e "    ${DIM}      \"type\": \"streamable-http\",${NC}"
echo -e "    ${DIM}      \"url\": \"http://localhost:3086/mcp\"${NC}"
echo -e "    ${DIM}    }${NC}"
echo -e "    ${DIM}  }${NC}"
echo -e "    ${DIM}}${NC}"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    ${DIM}docker compose logs -f${NC}          Follow all logs"
echo -e "    ${DIM}docker compose logs -f kernel${NC}   Follow kernel logs"
echo -e "    ${DIM}docker compose restart kernel${NC}   Restart kernel"
echo -e "    ${DIM}docker compose down${NC}             Stop everything"
echo -e "    ${DIM}docker compose up -d --build${NC}    Rebuild & restart"
echo ""

if [ "$ENV_CREATED" = true ]; then
    echo -e "  ${YELLOW}Next step: Edit ${BOLD}.env${NC}${YELLOW} to add your API keys and preferences${NC}"
    echo -e "  ${DIM}Then run: docker compose restart kernel${NC}"
    echo ""
fi
