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

# ── whisper.cpp ───────────────────────────────────────
# Its own stage so the Vulkan shader toolchain (glslc, glslang, SPIR-V
# headers) stays out of the runtime image — it is build-time only and none of
# it is small.
#
# Three flags carry the weight, and each one fixes a failure the previous
# build had:
#
#   GGML_BACKEND_DL       every backend as its own dlopen-able .so, picked at
#                         runtime. One image, GPU where there is a GPU.
#   GGML_CPU_ALL_VARIANTS sse42 … zen4 compiled side by side and dispatched at
#                         load. GGML_NATIVE=OFF alone (what this file had) is
#                         portable but pins everyone to the baseline ISA.
#   CMAKE_INSTALL_RPATH   without it cmake bakes the build tree's absolute
#                         path into RUNPATH, and the binary dies with
#                         `libwhisper.so.1: cannot open shared object file`
#                         the moment /tmp/whisper.cpp is deleted below.
#
# No CUDA, deliberately. Measured on an RTX 4070 with large-v3-turbo over an
# 80.5-minute film: CUDA 47 s, Vulkan 54 s — 15%, seven seconds, for ~930 MB
# of CUDA runtime and NVIDIA-only coverage. Vulkan is 42 MB and also covers
# AMD and Intel. Anyone who wants that 15% can build their own and point
# WHISPERCPP_BIN at it; the env override outranks this.
FROM debian:bookworm-slim AS whisper
ARG WHISPER_REF=v1.9.2
# OFF ships the portable image: Vulkan + CPU variants, ~50 MB, works on any
# GPU vendor — and on bare metal it does work, measured at 54 s for an
# 80.5-minute film. Inside a container on this host it does NOT: the driver
# loads, exposes vk_icdGetInstanceProcAddr, and returns NULL from it. Ruled
# out with evidence: devices (incl. /dev/nvidiactl), the ICD (mounted at
# /etc/vulkan/icd.d), driver deps (`ldd -r` clean), loader version (1.4.313
# behaves identically to bookworm's 1.3.239), the base distro (Fedora 42 fails
# the same way), and missing libraries (the container gets 52, the host has
# 49). Unresolved.
#
# ON is the escape hatch for exactly that case: CUDA works in containers here,
# and is faster anyway — 47 s against Vulkan's 54 s on the same film. It costs
# roughly 700 MB and only helps NVIDIA, which is why it is not the default.
ARG WHISPER_CUDA=OFF
# One architecture, not five. 89 is Ada — the RTX 40 series. Each extra
# architecture multiplies nvcc time and the size of libggml-cuda.so; a build
# aimed at one known machine has no reason to carry the others.
ARG CUDA_ARCHS=89
RUN apt-get update && apt-get install -y --no-install-recommends \
      git cmake build-essential ca-certificates curl gnupg \
      pkg-config libwayland-dev libx11-xcb-dev libxrandr-dev \
      libvulkan-dev glslc spirv-tools spirv-headers glslang-tools \
    && rm -rf /var/lib/apt/lists/*
# Bookworm ships Vulkan headers 1.3.239. ggml-vulkan needs
# VK_EXT_layer_settings (1.3.272+) and fails to compile without it —
# `'LayerSettingEXT' is not a member of 'vk'`. Upgrading the headers is safe
# in a way that upgrading the base image is not: they are header-only, the
# loader stays bookworm's, and the glibc the binary links against stays 2.36.
#
# That last part is the constraint that rules out the obvious fix. The runtime
# below is oven/bun:1.2-slim, which is bookworm — build this stage on Ubuntu
# 24.04 to get newer headers and the resulting binary demands glibc 2.39 and
# will not start.
ARG VULKAN_SDK_REF=v1.4.313
RUN git clone --depth 1 --branch ${VULKAN_SDK_REF} \
      https://github.com/KhronosGroup/Vulkan-Headers /vh \
    && cmake -B /vh/build -S /vh -DCMAKE_INSTALL_PREFIX=/usr/local \
    && cmake --install /vh/build \
    && rm -rf /vh

# The Vulkan LOADER, for the same reason and a different failure.
#
# Bookworm's libvulkan is 1.3.239, from 2023. A current NVIDIA driver presents
# a Vulkan 1.4 ICD, and the old loader cannot negotiate with it: it finds
# /etc/vulkan/icd.d/nvidia_icd.json, dlopens libGLX_nvidia.so.0 successfully,
# then fails to resolve vk_icdGetInstanceProcAddr and reports "Found no
# drivers!". The symbol is right there in the driver — verified with nm — so
# this looks like a broken driver and is not one.
#
# Shipping the loader next to whisper-cli rather than replacing the system one
# keeps the blast radius at zero: the $ORIGIN rpath means only whisper and its
# Vulkan backend pick it up, and anything else in the image that ever links
# libvulkan keeps bookworm's.
RUN git clone --depth 1 --branch ${VULKAN_SDK_REF} \
      https://github.com/KhronosGroup/Vulkan-Loader /vl \
    && cmake -B /vl/build -S /vl \
      -DCMAKE_BUILD_TYPE=Release \
      -DVULKAN_HEADERS_INSTALL_DIR=/usr/local \
      -DCMAKE_INSTALL_PREFIX=/vl/out \
    && cmake --build /vl/build -j "$(nproc)" \
    && cmake --install /vl/build
# CUDA toolkit from NVIDIA's own debian12 repo rather than an nvidia/cuda
# base image. The base images are Ubuntu, and swapping to one would move the
# builder's glibc away from the bookworm runtime's 2.36 — the same trap that
# rules out ubuntu-24.04 for the Vulkan headers above. Staying on bookworm and
# adding the toolkit keeps every binary linked against one glibc.
RUN if [ "$WHISPER_CUDA" = "ON" ]; then \
      curl -fsSL -o /tmp/cuda-keyring.deb \
        https://developer.download.nvidia.com/compute/cuda/repos/debian12/x86_64/cuda-keyring_1.1-1_all.deb \
      && dpkg -i /tmp/cuda-keyring.deb \
      && apt-get update \
      && apt-get install -y --no-install-recommends \
           cuda-nvcc-13-0 cuda-cudart-dev-13-0 libcublas-dev-13-0 \
      && rm -f /tmp/cuda-keyring.deb && rm -rf /var/lib/apt/lists/*; \
    fi
ENV PATH=/usr/local/cuda/bin:$PATH

RUN git clone --depth 1 --branch ${WHISPER_REF} \
      https://github.com/ggml-org/whisper.cpp /src
RUN cmake -B /build -S /src \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=ON \
      -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
      -DCMAKE_INSTALL_RPATH='$ORIGIN' \
      -DVulkan_INCLUDE_DIR=/usr/local/include \
      -DGGML_BACKEND_DL=ON \
      -DGGML_NATIVE=OFF \
      -DGGML_CPU_ALL_VARIANTS=ON \
      -DGGML_VULKAN=ON \
      -DGGML_CUDA=${WHISPER_CUDA} \
      -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCHS}" \
      # NCCL off even when CUDA is on. It is multi-GPU collectives, useless
      # for one card, and 181 MB — and if cmake finds it on the builder it
      # links against it, after which libggml-cuda.so fails its dlopen on any
      # machine without it. BACKEND_DL handles that by skipping the backend
      # SILENTLY, which is how a GPU build ends up transcribing on the CPU
      # with nothing in the logs. Verified the hard way.
      -DGGML_NCCL=OFF \
      -DWHISPER_BUILD_TESTS=OFF
RUN cmake --build /build --config Release -j "$(nproc)"
# ONE flat directory. Not tidiness — a requirement. BACKEND_DL resolves the
# GPU backends with dlopen, which looks beside the executable and ignores
# LD_LIBRARY_PATH, so the bin/ + lib/ split this file used to ship makes the
# process abort with `GGML_ASSERT(device) failed` before touching any audio.
RUN mkdir -p /opt/whisper \
    && cp /build/bin/whisper-cli /opt/whisper/ \
    && find /build -name '*.so*' -exec cp -a {} /opt/whisper/ \; \
    && cp -a /vl/out/lib/libvulkan.so* /opt/whisper/ \
    # libcudart and libcublas are TOOLKIT libraries, not driver ones:
    # nvidia-container-toolkit mounts libcuda.so from the host but never
    # these, so they have to ride along or libggml-cuda.so cannot be
    # dlopen-ed on the target.
    && if [ "$WHISPER_CUDA" = "ON" ]; then \
         cp -a /usr/local/cuda/lib64/libcudart.so* /opt/whisper/ \
         && cp -a /usr/local/cuda/lib64/libcublas.so* /opt/whisper/ \
         && cp -a /usr/local/cuda/lib64/libcublasLt.so* /opt/whisper/; \
       fi \
    && ls -la /opt/whisper

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
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# whisper.cpp, built in its own stage above. libvulkan1 is the ICD loader:
# without it libggml-vulkan.so fails its dlopen and BACKEND_DL skips the
# backend SILENTLY, leaving the container on the CPU with nothing in the logs
# to say why. It is ~150 KB and does nothing when no GPU is passed through, so
# it ships unconditionally rather than becoming a build flag someone forgets.
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan1 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /opt/whisper /opt/whisper
# The env override is the highest-priority branch of mediaToolBin(), which is
# what makes this work without the binary being on PATH — and what lets a user
# point at their own CUDA build without touching the image.
ENV WHISPERCPP_BIN=/opt/whisper/whisper-cli

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
