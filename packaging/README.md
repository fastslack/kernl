# Kernl — cross-platform packaging

Single staging pipeline (`stage-payload.sh`) feeds platform-specific
packagers. Same kernel + dashboard + native deps, different wrappers.

```
                        ┌─────────────────────┐
                        │  stage-payload.sh   │
                        │   (PLATFORM=...)    │
                        └──────────┬──────────┘
                                   │
        ┌──────────────┬──────────┼──────────────┬──────────────┐
        ▼              ▼          ▼              ▼              ▼
   linux-x64     linux-x64   darwin-arm64   darwin-x64     win-x64
        │              │          │              │              │
        ▼              ▼          ▼              ▼              ▼
   build-rpm.sh   build-deb.sh  build-app.sh     ✦       build-zip.sh
        │              │          │              │       build-msi.sh
        ▼              ▼          ▼              ▼              ▼
      .rpm          .deb       .app + .dmg   .app + .dmg     .zip + .msi
```

## Build matrix

| Platform | Output | Build host | Time | Status |
|---|---|---|---|---|
| Fedora/RHEL/CentOS    | `.rpm` | Linux | ~30s | ✅ working |
| Debian/Ubuntu/Mint | `.deb` | Linux (any) | ~30s | ✅ working |
| macOS Apple Silicon | `.app` + `.dmg` | macOS arm64 | ~2m | ⏳ CI only |
| macOS Intel | `.app` + `.dmg` | macOS x64 | ~2m | ⏳ CI only |
| Windows x64 portable | `.zip` | Linux (cross) or Windows | ~2m | ⚠️ builds, untested |
| Windows x64 installer | `.msi` | Windows + WiX | ~3m | ⏳ CI only |

Mac and Windows artifacts build on **GitHub Actions** for free
(`macos-13`, `macos-14`, `windows-latest` runners). See
`.github/workflows/release.yml`.

The Windows `.zip` also cross-builds from a Linux host: `stage-payload.sh`
downloads `bun-windows-x64` and resolves the native deps for `win32-x64`.
Verified 2026-07-29 — every shipped binary (`bun.exe`, `better_sqlite3.node`,
`sharp-win32-x64`, `onnxruntime-node`) is PE32+ x86-64, no Linux or macOS
artifacts leak in. **The result has never been executed on Windows**, so
treat a cross-built zip as unvalidated until someone runs `start.bat` on a
real machine. Bun does not run under wine, so there's no local smoke test.

Cross-building requires the right env vars, and getting them wrong fails
silently rather than loudly:

- `npm_config_platform` / `npm_config_arch` — what `prebuild-install` reads.
  The node-gyp pair (`npm_config_target_platform` / `_target_arch`) is *not*
  a synonym; with those you get a host-arch `better_sqlite3.node` inside the
  Windows package and a crash on first DB access.
- `--os` / `--cpu` — what npm reads to pick `optionalDependencies`. Without
  them you ship `@img/sharp-linux-x64` instead of `@img/sharp-win32-x64`.

## Local commands

```bash
# Linux RPM (Fedora-like host)
PLATFORM=linux-x64 packaging/rpm/build-rpm.sh
# → ~/rpmbuild/RPMS/x86_64/kernl-*.rpm  (~143 MB)

# Linux DEB (any host with ar+tar+zstd)
PLATFORM=linux-x64 packaging/deb/build-deb.sh
# → ./kernl_*.deb  (~141 MB)

# macOS portable .app + tarball (works on macOS host or Linux with native
# downloads; .icns + signing only happen on macOS)
PLATFORM=darwin-arm64 packaging/macos/build-app.sh
PLATFORM=darwin-x64   packaging/macos/build-app.sh
# → ./Kernl-*.app + ./Kernl-*-macos.tar.gz  (~150 MB compressed)

# Windows portable .zip (any host)
PLATFORM=win-x64 packaging/windows/build-zip.sh
# → packaging/out/kernl-*-windows-x64.zip  (~105 MB, 350 MB extracted)

# Windows MSI (Windows host with WiX 3.x on PATH)
PLATFORM=win-x64 packaging/windows/build-msi.sh
# → ./Kernl-*-windows-x64.msi
```

## Per-user install paths (after install/extract)

| Platform | App location | Per-user state | Per-user config |
|---|---|---|---|
| Linux | `/opt/kernl/` | `~/.local/share/kernl/` | `~/.config/kernl/.env` |
| macOS | `/Applications/Kernl.app` | `~/Library/Application Support/Kernl/` | same/config/.env |
| Windows | `C:\Program Files\Kernl\` | `%LOCALAPPDATA%\Kernl\` | `%APPDATA%\Kernl\.env` |

Each platform anchors SQLite + extension installs to the per-user data
dir, so multiple OS accounts get isolated kernels. The wrapper script
(`/usr/bin/kernl` / `Contents/MacOS/kernl` / `start.bat`) handles
the cd-to-data-dir + env loading transparently.

## Tier 1 vs Tier 2

**Tier 1 — out of the box, every platform:**

- Tasks, CRM, reminders, finance, notes, calendar, time-tracking, health,
  goals, comms (Gmail OAuth), chat (LLM keys), torrents, cinema (lexical
  search only), social.
- Graph driver registry boots with `noop` active. Graph-dependent tools
  return empty payloads gracefully — no crashes.

**Tier 2 — opt-in graph analytics:**

1. Install Neo4j Desktop (multi-platform, free for personal use):
   - macOS: `.dmg` from neo4j.com
   - Windows: `.exe` installer from neo4j.com
   - Linux: `.deb`/`.rpm` from neo4j.com or container
2. Open `http://localhost:3086/extensions`
3. Filter "Database", click `Neo4j` → enter Bolt URI + creds → **Activate**
4. GDS auto-detected; analytics + ML features unlocked

The toggle is hot (~85% of modules); switching backends takes effect
without a kernel restart.

## Code signing

| Platform | Signed? | Tool | Cert cost |
|---|---|---|---|
| Linux RPM/DEB | not yet | `rpm-sign` / `dpkg-sig` + GPG | $0 (self-issued) |
| macOS | not yet | `codesign` + `notarytool` | $99/yr (Apple Developer) |
| Windows | not yet | `signtool` | $300+/yr (EV cert) |

The CI workflow has signing wired up via secrets — set the appropriate
`*_CERT_DATA` / `*_PASSWORD` repository secrets and the workflow auto-signs.
Without those secrets, releases ship unsigned and users see one-time
warnings (Mac: right-click → Open; Windows: SmartScreen "Run anyway"; Linux:
no warning, but `dnf` won't auto-update without a signed repo).

## Distribution channels

| Format | Channel | Auto-update |
|---|---|---|
| `.rpm` | Fedora Copr (free, public) → `dnf copr enable matware/kernl` | ✓ via Copr |
| `.deb` | apt-mirror or PackageCloud → `add-apt-repository` | ✓ via repo metadata |
| `.dmg` | GitHub Releases + Sparkle updater | needs Sparkle integration |
| `.msi` | GitHub Releases + WiX Bootstrapper | needs Burn integration |
| All | GitHub Releases (manual download) | ✗ user re-downloads |

Initial recommendation: **GitHub Releases for all 4 formats** (zero infra,
discoverable). Add Copr + apt-mirror later if Linux usage grows.

## What's still missing

- [ ] Run the cross-built Windows zip on a real Windows box (`start.bat` →
      dashboard on :3086) — nothing has ever executed it
- [ ] GPG key + Copr repo for Linux signed releases
- [ ] Apple Developer cert + notarization profile
- [ ] Windows code-signing cert (or self-signed for unsigned MVP)
- [ ] `Sparkle.framework` + appcast.xml for macOS auto-updates
- [ ] WiX Bootstrapper or Squirrel.Windows for `.msi` auto-updates
- [ ] Welcome / first-run page in the dashboard explaining Tier 1 vs Tier 2

## Why bun and not Node

We bundle Bun (statically linked, ~80 MB) instead of relying on system
Node:

1. **Single source of truth** — same runtime everywhere, no version drift
   between user machines and the build host.
2. **No "install Node first" step** — the package is self-contained.
3. **Faster startup** — Bun's V8 alternative cold-starts ~3× faster.
4. **Simpler native modules** — Bun's bundler handles `--external` correctly
   for the three native deps we ship.

The trade-off is bundle size: Linux installs are ~150 MB vs ~50 MB if we
required system Node. For an "extremely simple install" target, that's
the right trade.
