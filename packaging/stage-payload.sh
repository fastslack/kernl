#!/bin/bash
# Stage the runtime payload that the per-platform packagers consume.
#
# Invocation:
#   PLATFORM=linux-x64    packaging/rpm/build-rpm.sh
#   PLATFORM=linux-x64    packaging/deb/build-deb.sh
#   PLATFORM=darwin-arm64 packaging/macos/build-app.sh
#   PLATFORM=darwin-x64   packaging/macos/build-app.sh
#   PLATFORM=win-x64      packaging/windows/build-zip.sh
#
# Produces a tree at:
#   $STAGE_DIR/kernl-$VERSION/
#     bin/{bun|bun.exe}           Bun runtime for the target platform
#     bin/mcp-server.js           bundled kernel
#     bin/static/                 static HTML pages
#     bin/extensions/             pre-built .kernl bundles
#     node_modules/               native deps (downloaded for $PLATFORM)
#     dashboard/                  Svelte SPA build
#     assets/                     extensions, agents, skills
#     packaging/                  per-format glue files (caller copies in)
#     package.json
#
# Caller must export STAGE_DIR before sourcing or invoking this script.
# On exit, $SRC_TREE points at $STAGE_DIR/kernl-$VERSION.

set -euo pipefail

_THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$_THIS_DIR/.." && pwd)"
cd "$REPO_ROOT"

VERSION="$(node -p "require('./services/kernel/package.json').version" 2>/dev/null || echo "0.1.0")"
NAME="kernl"
STAGE_DIR="${STAGE_DIR:-$(mktemp -d)}"
SRC_TREE="$STAGE_DIR/${NAME}-${VERSION}"
PLATFORM="${PLATFORM:-linux-x64}"

# ── Platform → bun-release-asset + native-module npm-target mapping ──
case "$PLATFORM" in
  linux-x64)
    BUN_ASSET="bun-linux-x64-baseline.zip"
    BUN_EXE="bun"
    NPM_PLATFORM="linux"; NPM_ARCH="x64"
    ;;
  darwin-arm64)
    BUN_ASSET="bun-darwin-aarch64.zip"
    BUN_EXE="bun"
    NPM_PLATFORM="darwin"; NPM_ARCH="arm64"
    ;;
  darwin-x64)
    BUN_ASSET="bun-darwin-x64.zip"
    BUN_EXE="bun"
    NPM_PLATFORM="darwin"; NPM_ARCH="x64"
    ;;
  win-x64)
    BUN_ASSET="bun-windows-x64.zip"
    BUN_EXE="bun.exe"
    NPM_PLATFORM="win32"; NPM_ARCH="x64"
    ;;
  *)
    echo "ERROR: unsupported PLATFORM '$PLATFORM'. Use one of: linux-x64, darwin-arm64, darwin-x64, win-x64" >&2
    exit 1
    ;;
esac

rm -rf "$SRC_TREE"
mkdir -p "$SRC_TREE/bin" "$SRC_TREE/packaging"

echo "▶ stage-payload: ${NAME} ${VERSION} for ${PLATFORM}"
echo "  staging dir: $STAGE_DIR"

# ── 1) Fresh kernel + dashboard build ──────────────────────────────
if [ ! -f services/kernel/dist/mcp-server.js ] || [ "$(find services/kernel/src -newer services/kernel/dist/mcp-server.js -name '*.ts' 2>/dev/null | head -1)" ]; then
  echo "▶ npm run build (kernel + extensions)"
  npm run build >/dev/null
fi

if [ ! -d services/dashboard/build ]; then
  echo "▶ npm run dashboard:build"
  npm run dashboard:build >/dev/null
fi

# ── 2) Vendor Bun for the target platform ───────────────────────────
# Linux-x64 host can use system bun directly; cross-platform needs a
# download from GitHub releases. We pin to "latest" so each release pulls
# the freshest runtime.
if [ "$PLATFORM" = "linux-x64" ] && command -v bun &>/dev/null && [ "$(uname -m)" = "x86_64" ]; then
  echo "▶ vendoring system bun ($(bun --version))"
  cp "$(command -v bun)" "$SRC_TREE/bin/$BUN_EXE"
else
  echo "▶ downloading bun ($PLATFORM)"
  TMP_BUN="$(mktemp -d)"
  curl -fsSL -o "$TMP_BUN/bun.zip" \
    "https://github.com/oven-sh/bun/releases/latest/download/$BUN_ASSET"
  ( cd "$TMP_BUN" && unzip -q bun.zip )
  # Releases unpack to bun-<platform>/<exe> ; find and copy.
  EXTRACTED="$(find "$TMP_BUN" -name "$BUN_EXE" -type f | head -1)"
  cp "$EXTRACTED" "$SRC_TREE/bin/$BUN_EXE"
  rm -rf "$TMP_BUN"
fi
chmod 0755 "$SRC_TREE/bin/$BUN_EXE"

# ── 3) Bundled kernel JS + static + built extensions ───────────────
cp services/kernel/dist/mcp-server.js "$SRC_TREE/bin/mcp-server.js"
[ -d services/kernel/dist/static ]     && cp -a services/kernel/dist/static     "$SRC_TREE/bin/static"
[ -d services/kernel/dist/extensions ] && cp -a services/kernel/dist/extensions "$SRC_TREE/bin/extensions"

# ── 4) Native modules ──────────────────────────────────────────────
# Two paths:
#   a) PLATFORM matches the host → reuse `./node_modules` (fast: ~5s).
#      Only the linux-x64 host case today, but mac-on-mac / win-on-win
#      work the same way once we run on those CI runners.
#   b) PLATFORM is cross-host → install fresh into a temp tree (~3 min)
#      so prebuild-install downloads the right architecture binaries.
HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
HOST_ARCH="$(uname -m)"
[ "$HOST_OS" = "linux" ]   && HOST_PLATFORM="linux-x64"
[ "$HOST_OS" = "darwin" ] && [ "$HOST_ARCH" = "arm64" ]  && HOST_PLATFORM="darwin-arm64"
[ "$HOST_OS" = "darwin" ] && [ "$HOST_ARCH" = "x86_64" ] && HOST_PLATFORM="darwin-x64"

mkdir -p "$SRC_TREE/node_modules"

# ── 4a) What the bundled extensions import ─────────────────────────
# The staged node_modules used to carry only what the KERNEL needs. The
# bundled extensions under assets/extensions/ import their own packages, and
# in a native install nothing resolves them: the tree is pruned and there is
# no parent node_modules to walk up into. Docker never showed this because
# /app/node_modules is a full install.
#
# The result was 50 of 79 registered extensions failing to load — mostly on
# `uuid` — so the dashboard listed them and none of them worked.
#
# Derived from the built entry points rather than hardcoded, so adding an
# extension that pulls a new package does not silently ship broken. Names are
# validated against npm's grammar because these files embed SQL, and `FROM
# communications` reads exactly like an import to a naive regex.
echo "▶ scanning bundled extensions for external imports"
EXT_DEPS="$(node -e "
  const fs = require('node:fs'), path = require('node:path');
  const builtins = new Set(require('node:module').builtinModules);
  const VALID = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*\$/;
  // Deliberately NOT staged. Together these pull ~100 MB of transitive
  // closure — a third of the whole package — to serve the minority who
  // connect Discord, Slack or S3. Each extension records them in
  // backend.packages and the kernel installs them into the extension's own
  // directory the moment someone enables it. Adding one here trades the
  // install size of everyone for the convenience of a few; before doing that,
  // measure it.
  const ON_DEMAND = new Set([
    'discord.js', 'grammy', '@slack/bolt',
    '@aws-sdk/client-s3', '@aws-sdk/lib-storage',
    '@anthropic-ai/claude-agent-sdk', '@modelcontextprotocol/sdk',
  ]);
  const root = 'services/kernel/assets/extensions';
  const found = new Set();
  if (fs.existsSync(root)) (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/(?:\bfrom|\brequire\()\s*[\"']([^\"'\n]+)[\"']/g)) {
          const spec = m[1];
          if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
          const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          if (builtins.has(name) || !VALID.test(name)) continue;
          // Anything not actually installed is a false positive from the same
          // string-matching problem; the consumers below skip it anyway.
          if (!fs.existsSync(path.join('services/kernel/node_modules', name))) continue;
          if (ON_DEMAND.has(name)) continue;
          found.add(name);
        }
      }
    }
  })(root);
  console.log(JSON.stringify([...found].sort()));
")"
echo "  $(node -e "console.log(JSON.parse(process.argv[1]).length)" "$EXT_DEPS") packages: $(node -e "console.log(JSON.parse(process.argv[1]).join(', '))" "$EXT_DEPS")"

if [ "${HOST_PLATFORM:-}" = "$PLATFORM" ] && [ -d services/kernel/node_modules/better-sqlite3 ]; then
  echo "▶ reusing host node_modules (PLATFORM matches host)"
  cp -a services/kernel/node_modules/better-sqlite3 "$SRC_TREE/node_modules/"
  cp -a services/kernel/node_modules/onnxruntime-node "$SRC_TREE/node_modules/"
  mkdir -p "$SRC_TREE/node_modules/@huggingface"
  cp -a services/kernel/node_modules/@huggingface/transformers "$SRC_TREE/node_modules/@huggingface/"
  cp -a services/kernel/node_modules/neo4j-driver "$SRC_TREE/node_modules/" 2>/dev/null || true

  # Resolve dep closure of those four against the host's node_modules.
  echo "▶ resolving dep closure"
  DEPS_LIST="$(node -e "
    const fs = require('node:fs');
    const path = require('node:path');
    const seen = new Set();
    function walk(name) {
      if (seen.has(name)) return;
      const pj = path.join('services/kernel/node_modules', name, 'package.json');
      if (!fs.existsSync(pj)) return;
      seen.add(name);
      const p = JSON.parse(fs.readFileSync(pj));
      for (const dep of Object.keys(p.dependencies ?? {})) walk(dep);
    }
    walk('better-sqlite3'); walk('onnxruntime-node');
    walk('@huggingface/transformers'); walk('neo4j-driver');
    for (const d of $EXT_DEPS) walk(d);
    console.log(JSON.stringify([...seen]));
  ")"
  node -e "
    const list = $DEPS_LIST;
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    for (const dep of list) {
      const src = path.join('services/kernel/node_modules', dep);
      const dst = path.join('$SRC_TREE/node_modules', dep);
      if (fs.existsSync(dst)) continue;
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      spawnSync('cp', ['-a', src, dst], { stdio: 'inherit' });
    }
  "
else
  echo "▶ resolving native deps for $NPM_PLATFORM-$NPM_ARCH (cross-host install)"
  NATIVE_TMP="$(mktemp -d)"
  # Version resolution: direct dep in package.json first, else whatever the
  # host tree already resolved. onnxruntime-node has no package.json entry —
  # it arrives transitively through @huggingface/transformers.
  node -e "
    const fs = require('node:fs');
    const pkg = require('./services/kernel/package.json');
    const names = ['better-sqlite3', 'onnxruntime-node', '@huggingface/transformers', 'neo4j-driver',
                   ...$EXT_DEPS];
    const dependencies = {};
    for (const name of names) {
      let version = pkg.dependencies?.[name];
      if (!version) {
        const installed = 'services/kernel/node_modules/' + name + '/package.json';
        if (fs.existsSync(installed)) version = JSON.parse(fs.readFileSync(installed)).version;
      }
      if (!version) {
        console.error('  WARN: no version for ' + name + ' — skipping');
        continue;
      }
      dependencies[name] = version;
    }
    fs.writeFileSync(process.argv[1], JSON.stringify(
      { name: 'kernl-native-stage', version: '0.0.0', private: true, dependencies }, null, 2));
  " "$NATIVE_TMP/package.json"
  (
    cd "$NATIVE_TMP"
    # npm_config_platform/_arch  → what prebuild-install reads to fetch the
    #   right prebuilt .node (npm_config_target_* is node-gyp's, and silently
    #   leaves you with a host-arch binary).
    # --os/--cpu                 → what npm reads to pick the right
    #   optionalDependencies (@img/sharp-win32-x64 instead of -linux-x64).
    # No --silent: it swallows ETARGET and friends, leaving an empty log.
    npm_config_platform="$NPM_PLATFORM" \
    npm_config_arch="$NPM_ARCH" \
    npm_config_runtime="node" \
    # --legacy-peer-deps: this tree exists only to have files copied out of
    #   it, never to run. Staging the extensions' packages alongside the
    #   kernel's puts unrelated libraries in one synthetic package.json, and
    #   npm refuses on their peer ranges (zod, via the Anthropic and MCP SDKs).
    #   Peer resolution is meaningless here — the host tree already resolved
    #   these versions and they are what ships.
    npm install --os="$NPM_PLATFORM" --cpu="$NPM_ARCH" \
      --legacy-peer-deps \
      --omit=dev --no-audit --no-fund --loglevel=error
  )
  cp -a "$NATIVE_TMP/node_modules/." "$SRC_TREE/node_modules/"
  rm -rf "$NATIVE_TMP"
fi

# Prune onnxruntime: keep only the target platform's CPU bin (drop GPU
# providers — CUDA/TensorRT — that pull massive driver dependencies).
ORT_BIN="$SRC_TREE/node_modules/onnxruntime-node/bin/napi-v3"
if [ -d "$ORT_BIN" ]; then
  case "$NPM_PLATFORM" in
    linux)  KEEP_OS="linux" ;;
    darwin) KEEP_OS="darwin" ;;
    win32)  KEEP_OS="win32" ;;
  esac
  find "$ORT_BIN" -mindepth 1 -maxdepth 1 -type d \
    ! -name "$KEEP_OS" -exec rm -rf {} +
  if [ -d "$ORT_BIN/$KEEP_OS" ]; then
    find "$ORT_BIN/$KEEP_OS" -mindepth 1 -maxdepth 1 -type d \
      ! -name "$NPM_ARCH" -exec rm -rf {} +
    # Drop GPU providers regardless of platform.
    find "$ORT_BIN/$KEEP_OS/$NPM_ARCH" -name "*providers_cuda*" -delete 2>/dev/null
    find "$ORT_BIN/$KEEP_OS/$NPM_ARCH" -name "*providers_tensorrt*" -delete 2>/dev/null
    find "$ORT_BIN/$KEEP_OS/$NPM_ARCH" -name "*providers_shared*" -delete 2>/dev/null
  fi
fi

# ── 5) Dashboard SPA + assets + manifest ───────────────────────────
cp -a services/dashboard/build "$SRC_TREE/dashboard"
cp -a services/kernel/assets "$SRC_TREE/assets"
cp services/kernel/package.json "$SRC_TREE/package.json"

echo "▶ stage-payload: tree size $(du -sh "$SRC_TREE" | cut -f1)"

export NAME VERSION STAGE_DIR SRC_TREE PLATFORM BUN_EXE
