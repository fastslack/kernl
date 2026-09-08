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

# ── 2b) Vendor whisper.cpp for the target platform ──────────────────
# Subtitles are the one feature that was silently PATH-dependent: the Docker
# image apt-installs whisper.cpp, but a native install got whatever the user
# happened to have, which for almost everyone was nothing. media-tools.ts
# turned the resulting spawn ENOENT into a readable sentence; this makes the
# sentence unnecessary.
#
# The bundles come from .github/workflows/whisper-binaries.yml — built there
# rather than downloaded from upstream because the flags we need
# (GGML_BACKEND_DL + GGML_CPU_ALL_VARIANTS: every GPU backend dlopen-ed at
# runtime, every x86 CPU generation compiled side by side) are not something
# anyone publishes.
#
# EVERYTHING GOES IN ONE FLAT DIRECTORY, deliberately. BACKEND_DL loads the
# GPU backends with dlopen, which looks beside the executable and does NOT
# consult LD_LIBRARY_PATH. A bin/ + lib/ split — the layout the Dockerfile
# uses — makes the process abort with `GGML_ASSERT(device) failed` before it
# reaches any audio.
#
# Best-effort: a release without the asset yet still produces a working
# package, it just falls back to the user's PATH exactly as before. Failing
# the build here would mean a whisper.cpp bump could block a Kernl release.
# `-2` is a rebuild of the same whisper.cpp v1.9.2, not a new upstream version.
# The first build set no macOS deployment target, so clang stamped in the
# runner's: the published darwin bundles carry `minos 15.0` and dyld refuses to
# load them on macOS 13 and 14. A new tag rather than replacing the assets on
# the old one, because the point of pinning is that a given tag keeps meaning
# the same bytes.
WHISPER_BIN_TAG="${WHISPER_BIN_TAG:-whisper-v1.9.2-2}"
WHISPER_TARBALL="whisper-${PLATFORM}.tar.gz"
WHISPER_URL="https://github.com/${GITHUB_REPOSITORY:-fastslack/kernl}/releases/download/${WHISPER_BIN_TAG}/${WHISPER_TARBALL}"

if [ -n "${WHISPER_BUNDLE_DIR:-}" ] && [ -d "$WHISPER_BUNDLE_DIR" ]; then
  # Escape hatch for local builds and for CI jobs that just built the bundle
  # in the same run: point at a directory instead of hitting the network.
  echo "▶ vendoring whisper from $WHISPER_BUNDLE_DIR"
  mkdir -p "$SRC_TREE/bin/whisper"
  cp -a "$WHISPER_BUNDLE_DIR/." "$SRC_TREE/bin/whisper/"
else
  echo "▶ downloading whisper bundle ($PLATFORM, $WHISPER_BIN_TAG)"
  TMP_W="$(mktemp -d)"
  if curl -fsSL -o "$TMP_W/w.tar.gz" "$WHISPER_URL"; then
    tar xzf "$TMP_W/w.tar.gz" -C "$TMP_W"
    mkdir -p "$SRC_TREE/bin/whisper"
    cp -a "$TMP_W/whisper/." "$SRC_TREE/bin/whisper/"
  else
    echo "  WARN: no whisper bundle at $WHISPER_URL"
    echo "  WARN: package will fall back to whisper-cli on the user's PATH"
  fi
  rm -rf "$TMP_W"
fi

if [ -d "$SRC_TREE/bin/whisper" ]; then
  case "$PLATFORM" in
    win-x64) chmod 0755 "$SRC_TREE/bin/whisper/whisper-cli.exe" 2>/dev/null || true ;;
    *)       chmod 0755 "$SRC_TREE/bin/whisper/whisper-cli"     2>/dev/null || true ;;
  esac
  echo "  whisper bundle: $(du -sh "$SRC_TREE/bin/whisper" | cut -f1)"
fi

# ── 2c) Vendor ffmpeg + ffprobe for the target platform ─────────────
# Every subtitle engine — whisper.cpp, the in-process transformers one, and
# Groq Cloud — starts by extracting audio with ffmpeg, so a package without one
# cannot generate a single subtitle whatever engine the user picks. The macOS
# .app shipped without it and without any declared dependency, and because a
# Finder-launched app gets launchd's PATH rather than the user's, even people
# who had run `brew install ffmpeg` hit `spawn ffmpeg ENOENT`.
#
# Bundles come from .github/workflows/ffmpeg-binaries.yml — see its header for
# why they are built rather than vendored from any of the published static
# builds (the one that covers every platform is `--enable-nonfree`, which is
# not redistributable at all).
#
# NOT staged for linux-x64, on purpose. `apt install ffmpeg` is one command,
# every distro packages it, the deb and rpm already carry `Recommends: ffmpeg`
# and the Docker image installs it — so bundling would add ~160 MB to serve a
# case the platform already handles. whisper.cpp is bundled everywhere for the
# opposite reason: nobody packages it.
FFMPEG_BIN_TAG="${FFMPEG_BIN_TAG:-ffmpeg-v7.1.5}"

case "$PLATFORM" in
  linux-x64)
    echo "▶ skipping ffmpeg bundle (linux uses the distro package)"
    ;;
  *)
    FFMPEG_TARBALL="ffmpeg-${PLATFORM}.tar.gz"
    FFMPEG_URL="https://github.com/${GITHUB_REPOSITORY:-fastslack/kernl}/releases/download/${FFMPEG_BIN_TAG}/${FFMPEG_TARBALL}"

    if [ -n "${FFMPEG_BUNDLE_DIR:-}" ] && [ -d "$FFMPEG_BUNDLE_DIR" ]; then
      # Same escape hatch as whisper: point at a directory instead of the
      # network, for local builds and for a CI job that just built it.
      echo "▶ vendoring ffmpeg from $FFMPEG_BUNDLE_DIR"
      mkdir -p "$SRC_TREE/bin/ffmpeg"
      cp -a "$FFMPEG_BUNDLE_DIR/." "$SRC_TREE/bin/ffmpeg/"
    else
      echo "▶ downloading ffmpeg bundle ($PLATFORM, $FFMPEG_BIN_TAG)"
      TMP_F="$(mktemp -d)"
      if curl -fsSL -o "$TMP_F/f.tar.gz" "$FFMPEG_URL"; then
        tar xzf "$TMP_F/f.tar.gz" -C "$TMP_F"
        mkdir -p "$SRC_TREE/bin/ffmpeg"
        cp -a "$TMP_F/ffmpeg/." "$SRC_TREE/bin/ffmpeg/"
      else
        # Best-effort, like whisper: a release cut before the asset exists
        # still produces a working package, it just falls back to the user's
        # PATH. Failing here would let an ffmpeg bump block a Kernl release.
        echo "  WARN: no ffmpeg bundle at $FFMPEG_URL"
        echo "  WARN: package will fall back to ffmpeg on the user's PATH"
      fi
      rm -rf "$TMP_F"
    fi

    if [ -d "$SRC_TREE/bin/ffmpeg" ]; then
      case "$PLATFORM" in
        win-x64) chmod 0755 "$SRC_TREE/bin/ffmpeg/"*.exe 2>/dev/null || true ;;
        *)       chmod 0755 "$SRC_TREE/bin/ffmpeg/ffmpeg" "$SRC_TREE/bin/ffmpeg/ffprobe" 2>/dev/null || true ;;
      esac
      echo "  ffmpeg bundle: $(du -sh "$SRC_TREE/bin/ffmpeg" | cut -f1)"
    fi
    ;;
esac

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
  // ...except the two SDKs the bundled extensions actually depend on, on
  // Windows, where they ship inside the package instead.
  //
  // Ten bundled extensions declare one of these -- Cinema, Shop, Comms and
  // filesystem-commander among them -- so leaving them out parks all of them
  // in 'installed', and a parked extension does not even serve its own page:
  // /ext-assets/<slug>/* answers 404 unless status is 'active'. The user gets
  // a failed dynamic import and a feature that looks simply broken. The
  // auto-provisioner is meant to close that gap after boot, but it depends on
  // reaching the npm registry from the user machine on first run, and when
  // that fails there is nothing to fall back to.
  //
  // Deliberate trade: ~100 MB of installer so the features work offline and on
  // first boot. Windows only for now -- measure before extending it.
  if (process.env.PLATFORM && process.env.PLATFORM.startsWith('win')) {
    ON_DEMAND.delete('@anthropic-ai/claude-agent-sdk');
    ON_DEMAND.delete('@modelcontextprotocol/sdk');
  }
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
      // optionalDependencies too — that is how native packages ship their
      // per-platform binaries. sharp declares @img/colour as a real dependency
      // (so it travelled) and all 24 @img/sharp-<platform> builds as optional
      // (so none did), and the payload got a sharp that throws
      //   Could not load the \"sharp\" module using the darwin-arm64 runtime
      // on first use. That is every subtitle job, since @huggingface/transformers
      // pulls sharp in. walk() already returns early when the package is not on
      // disk, so this copies only the variants the host actually installed:
      // the target platform's, and nothing else.
      for (const dep of Object.keys(p.optionalDependencies ?? {})) walk(dep);
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
