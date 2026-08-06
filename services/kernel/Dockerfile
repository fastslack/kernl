# ── Build: TypeScript → single bundle ─────────────────
FROM oven/bun:1.2 AS build

# better-sqlite3 needs native build tools
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY tsconfig.json bunfig.toml ./
COPY bin/ bin/
COPY src/ src/
COPY assets/ assets/
COPY scripts/ scripts/

# Externalize heavy native/problematic deps so Bun uses node_modules versions.
# onnxruntime-node + @huggingface/transformers MUST be external — onnxruntime
# loads its .node binary via `require(path.join(__dirname, '../bin/...'))`,
# which after bundling resolves to /app/bin/... (relative to /app/dist/),
# nowhere near the actual binary inside node_modules. The symlink below
# also covers the case where some bundled call still uses the wrong path.
RUN bun build bin/mcp-server.ts --outdir dist --target bun \
    --external link-preview-js --external jimp \
    --external @whiskeysockets/baileys --external ws --external qrcode-terminal \
    --external ccxt \
    --external onnxruntime-node --external @huggingface/transformers \
 && bun build bin/mcp-stdio-bridge.ts --outdir dist --target bun

# Compile extension backends (assets/extensions/**/backend/entry.js). They are
# gitignored build artifacts, so a fresh clone has none — without this step every
# default module extension fails to load at boot (status=error) and its nav,
# tools and API routes silently disappear from the public image.
RUN bun run scripts/build-extensions.ts

# ── Production ────────────────────────────────────────
FROM oven/bun:1.2-slim

LABEL org.opencontainers.image.title="Kernl API"
LABEL org.opencontainers.image.description="Personal Life Management Server — API + MCP"

WORKDIR /app

# Install git + glab CLI (for devtools module) + bubblewrap + socat + docker CLI.
# - bubblewrap: sandbox del Claude Agent SDK (cae a rules si el host bloquea userns).
# - socat: networking helper que usa el sandbox del SDK para proxy/relays — sin
#   esto el SDK loguea "Sandbox disabled: socat not installed" y corre comandos
#   SIN aislamiento de red/filesystem.
# - docker CLI: usado por el claude_code executor para spawnear cada run en su
#   propio container (Capa 2 isolation). Accede al socket del host via el
#   bind-mount /var/run/docker.sock ya declarado en docker-compose.
# tor: onion service for instance peering. Installed but inert — it only runs
# when KERNEL_TOR=1 (see docker-entrypoint.sh), and the kernel advertises no
# onion reach entry when it is absent.
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates bubblewrap socat ffmpeg build-essential cmake tor \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v1.89.0/downloads/glab_1.89.0_linux_$(dpkg --print-architecture).deb" -o /tmp/glab.deb \
    && dpkg -i /tmp/glab.deb \
    && rm /tmp/glab.deb \
    && cd /tmp && git clone --depth 1 https://github.com/ggerganov/whisper.cpp \
    && cd whisper.cpp \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF \
    && cmake --build build --config Release -j 4 \
    && cp build/bin/whisper-cli /usr/local/bin/whisper-cli \
    # whisper-cli is dynamically linked against libwhisper.so + libggml*.so,
    # which the build leaves under build/{src,ggml/src}. Without installing
    # them to a real lib path + ldconfig, the binary fails at runtime with
    # `error while loading shared libraries: libwhisper.so.1` (exit 127) and
    # subtitle generation silently dies right after audio extraction.
    && find build -name '*.so*' -exec cp -a {} /usr/local/lib/ \; \
    && ldconfig \
    && cd / && rm -rf /tmp/whisper.cpp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Use --chown in COPY instead of slow `chown -R` (saves ~150s)
COPY --chown=bun:bun --from=build /build/dist/ ./dist/
COPY --chown=bun:bun --from=build /build/node_modules/ ./node_modules/
COPY --chown=bun:bun --from=build /build/package.json ./
# assets/ MUST come from the build stage (not the context): it now contains the
# compiled backend/entry.js bundles produced by build-extensions above.
COPY --chown=bun:bun --from=build /build/assets/ ./assets/

COPY --chown=bun:bun docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 0755 /app/docker-entrypoint.sh

RUN mkdir -p /app/data && chown -R bun:bun /app/data

# Belt-and-suspenders for onnxruntime-node: even with --external, some
# bundled code paths reference `../bin/napi-v3/...` relative to the entry
# point (/app/dist/...), which would resolve to /app/bin/... (does not
# exist). Symlink so both routes find the same .node binary in
# node_modules. This makes NLLB/Whisper translation actually load.
RUN ln -snf /app/node_modules/onnxruntime-node/bin /app/bin

# Agregar al usuario bun al grupo que posee /var/run/docker.sock en el host,
# para que el claude_code executor pueda spawnear containers via docker-in-docker.
# GID 981 coincide con el grupo 'docker' del host de desarrollo actual.
ARG HOST_DOCKER_GID=981
RUN groupadd -g ${HOST_DOCKER_GID} hostdocker 2>/dev/null || true \
    && usermod -aG ${HOST_DOCKER_GID} bun

USER bun

# KERNEL_MCP_BRIDGE: el SDK de Claude spawnea este script como MCP server
# stdio para hablar con el kernel vía unix socket. El default del código es
# /app/bin/mcp-stdio-bridge.ts, pero acá /app/bin es un symlink a
# onnxruntime-node/bin (ver arriba) — sin este override, TODO claude_code
# (agentes + chat del comandante) pierde los tools mcp__kernel__* en silencio.
ENV MCP_TRANSPORT=http \
    DASHBOARD_ENABLED=false \
    DASHBOARD_PORT=3087 \
    SQLITE_PATH=/app/data/kernel.db \
    NEO4J_URI=bolt://neo4j:7687 \
    NEO4J_USER=neo4j \
    LOG_LEVEL=info \
    TIMEZONE=UTC \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    KERNEL_MCP_BRIDGE=/app/dist/mcp-stdio-bridge.js

EXPOSE 3087

VOLUME /app/data

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://localhost:3087/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]

CMD ["bun", "run", "dist/mcp-server.js"]
