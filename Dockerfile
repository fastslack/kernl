# ── Stage 1: Build dashboard (SvelteKit) ──────────────
FROM oven/bun:1.2 AS dashboard-build

WORKDIR /build/dashboard
COPY services/dashboard/package.json services/dashboard/package-lock.json* ./
RUN bun install

COPY services/dashboard/ ./
RUN bun run build

# ── Stage 2: Build kernel (TypeScript → single bundle) ─
FROM oven/bun:1.2 AS kernel-build

# better-sqlite3 needs native build tools (even though runtime uses bun:sqlite)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY services/kernel/package.json services/kernel/bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY services/kernel/tsconfig.json services/kernel/bunfig.toml ./
COPY services/kernel/bin/ bin/
COPY services/kernel/src/ src/
COPY services/kernel/assets/ assets/
COPY services/kernel/scripts/ scripts/

RUN bun build bin/mcp-server.ts --outdir dist --target bun \
    --external link-preview-js --external jimp \
 && bun run scripts/build-extensions.ts

# Copy static files that the legacy server fallback needs
COPY services/kernel/src/modules/dashboard/static dist/modules/dashboard/static/

# ── Stage 3: Production image ─────────────────────────
FROM oven/bun:1.2-slim

LABEL org.opencontainers.image.title="Kernl"
LABEL org.opencontainers.image.description="Personal Life Management Server"
LABEL org.opencontainers.image.source="https://github.com/fastslack/kernl"

WORKDIR /app

# Install git + glab CLI (for devtools module)
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates jq \
    && curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v1.89.0/downloads/glab_1.89.0_linux_$(dpkg --print-architecture).deb" -o /tmp/glab.deb \
    && dpkg -i /tmp/glab.deb \
    && rm /tmp/glab.deb \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy built kernel bundle (--chown avoids slow recursive chown)
COPY --chown=bun:bun --from=kernel-build /build/dist/ ./dist/
COPY --chown=bun:bun --from=kernel-build /build/node_modules/ ./node_modules/
COPY --chown=bun:bun --from=kernel-build /build/package.json ./

# MCP stdio bridge — spawned at runtime by the Claude Agent SDK (claude_code
# agents + chat) as `bun /app/bin/mcp-stdio-bridge.ts <socket>`. It is NOT
# part of the dist bundle, so without this copy every claude_code session
# silently loses the kernel MCP tools (mcp__kernel__*).
COPY --chown=bun:bun --from=kernel-build /build/bin/ ./bin/

# Copy built dashboard
COPY --chown=bun:bun --from=dashboard-build /build/dashboard/build/ ./dashboard/build/

# Copy bundled assets (skills + sandbox agents + COMPILED extension backends)
# from the build stage — the context's assets/ lacks the gitignored entry.js.
COPY --chown=bun:bun --from=kernel-build /build/assets/ ./assets/

# Create runtime directory
RUN mkdir -p /app/data && chown -R bun:bun /app/data

USER bun

# Defaults — override via docker-compose or env
ENV MCP_TRANSPORT=http \
    DASHBOARD_ENABLED=true \
    DASHBOARD_PORT=3086 \
    SQLITE_PATH=/app/data/kernel.db \
    NEO4J_URI=bolt://neo4j:7687 \
    NEO4J_USER=neo4j \
    LOG_LEVEL=info \
    TIMEZONE=UTC

EXPOSE 3086

VOLUME /app/data

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://localhost:3086/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["bun", "run", "dist/mcp-server.js"]
