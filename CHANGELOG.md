# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **In-app update could not work on Windows, and said so only after refusing.**
  An install was recognised by the running code sitting in a `bin/` directory —
  the shape `stage-payload.sh` produces and the macOS bundle and Linux tarball
  ship. But `build-zip.sh` and `build-msi.sh` both copy the bundled kernel to
  the package ROOT, so a Windows install runs from `C:\Program Files\Kernl` and
  was classified "not an installed copy". The one platform with no package
  manager behind it was the one that could never update.
- **An MSI install is upgraded by Windows' installer now, not by moving its
  directory.** A swap under Program Files needs permission this process does
  not have, and even where it works it leaves Add/Remove Programs advertising a
  version that is no longer on disk. The app downloads the new MSI, verifies it,
  and hands it to `msiexec /i /qb` — one UAC prompt, the installer's own
  progress, registry and uninstaller kept in step. A portable copy is still
  swapped, which is right for a directory nobody else owns.
- **The updater asked for asset names the release does not publish.** It built
  them by hand — `Kernl-…-windows-x64.zip` against a published
  `kernl-…-windows-x64.zip`. GitHub resolves asset names case-insensitively so
  the download survived; the checksum lookup, an exact string comparison
  against SHA256SUMS, did not, and the update failed after transferring 311 MB.
  The name now comes from the release API, so what gets verified and what gets
  fetched are the same string by construction.
- **The Windows helper could not sleep, so it never swapped anything.** It used
  `timeout`, which exits immediately with "Input redirection is not supported"
  when stdin is redirected — and the helper is spawned with its stdio ignored.
  The wait loop burned its sixty tries in milliseconds and gave up, by which
  point the kernel had already exited: a closed app, no update, no relaunch.
- **A failed first move could nest the new install inside the old one.** The
  move that parks the previous copy was unchecked, and `move` into an existing
  directory moves *into* it — so a denied move dropped the new tree inside the
  live install, reported success, and deleted a backup that was never made.
- **The relaunch pointed at a directory.** Correct for `open` on a macOS
  bundle; on Windows it ran `start "" "C:\Program Files\Kernl"`, which opens
  Explorer, and on Linux it tried to execute a folder. Windows relaunches
  `start.bat`, the documented entry point the Start Menu shortcut already uses,
  and the Linux portable copy runs its bundled runtime against its bundled
  kernel.
- **In-app update on Linux returned 404.** The portable tarball was built and
  uploaded as a CI artifact, but the release only attached `Kernl-*-macos.tar.gz`,
  so the file the updater downloads was never published.

### Added

- A test that checks the asset names the updater asks for against the names a
  real release published. The previous test asserted the hand-built name
  against itself, which passes however wrong that name is — and is why all of
  the above shipped.

## [0.3.0] - 2026-09-08

Everything an agent is — its prompt, its runtime, its tools, its skills, what
wakes it up — used to be spread across a panel welded into the 3D world and a
second, half-duplicated panel on the agents page. This release pulls it into one
drawer that both pages mount, and then spends most of its commits filling that
drawer in.

### Added

- **The agent drawer.** A single panel, extracted out of the 3D world into its
  own shell with its own store, mounted on the agents page as well. Its tree
  carries the mandate, the default goal, allowed tools, variables, appearance
  and the runtime — the runtime being editable from the panel itself rather than
  from a settings page three clicks away.
- **A skills tab per agent** that recommends, installs and attaches in one
  place. Suggestions are served over HTTP from a scoring core lifted out of the
  suggester cron, and catalogue skills are scored alongside the ones already
  installed, so the ranking answers "what should this agent learn next" instead
  of "what does it already have".
- **Skills from a repo URL**, added without leaving the tab.
- **MCP Connections from the dashboard**: add a server, sign in, and have it
  stay working, instead of editing a config file and restarting.
- **In-app update on Linux and Windows**, with progress. macOS already had it.
- **A verdict on failed agent runs**, leading the panel, with each failure
  mapped to the control that actually fixes it.
- **Model chains** convert between the panel's list and the agent's columns.
- **Tool-loop capability** is reported in the LLM provider status, so a provider
  that cannot drive a tool loop says so before an agent is pointed at it.
- **Watch the creative office draw**, from the agent drawer.
- **macOS builds are signed and notarized, in the right order.** Every nested
  Mach-O is signed before the bundle that seals it, the `.app` is notarized and
  stapled *before* it enters the disk image — so it opens with no network — and
  the portable tarball is repacked from the signed bundle instead of the
  unsigned one written minutes earlier. The job now fails when the six Apple
  secrets are only partly set, rather than shipping a signed-but-un-notarized
  app that Gatekeeper rejects exactly like an unsigned one. A release built
  without the secrets is unsigned as before, and says so.
- **Host support for headless rendering**, for the Blender bridge that ships as
  an extension. The kernel image carries the libraries a render needs with no
  display — libEGL above all, whose absence killed a job *after* it was queued
  and the scene was built — and a rendered frame can be shown with `<img src>`
  through `?auth=`, which cannot set a header. The allowlist stays one route
  wide: the job listing beside it still refuses a token in the URL.

### Changed

- **The dashboard opens signed in on every platform.** The token handoff worked
  on one and left the others at a login screen for an instance the user had just
  installed themselves.
- **Connections, schedule and event triggers are one "triggering" section.**
  They were three places to answer one question: what starts this agent.
- The Windows installer bundles the agent and MCP SDKs, so a fresh Windows
  install can run an agent without a separate toolchain.
- The skills tab is hidden for script agents, which cannot use skills, and the
  drawer is translated.
- The README leads with the agent office and a live instance count.
- The duplicated agent skills panel is gone.
- **The "thinking" indicator lives in the agent's own tag.** It was a ⚙️ glyph
  spinning over the agent's head — at office camera distance a rotating glyph
  reads as a vibrating speck. It is now three dots breathing in sequence inside
  the nameplate, in the agent's flow colour.

### Fixed

- **The store's update button did not update.** It reported success.
- **Every `mcp__kernel__*` tool was missing from a `claude_code` run.** The
  kernel's HTTP API is fail-closed and the MCP server reached it with no
  Authorization header, so `/mcp` answered 401 and the server never finished
  initializing — silently. The agent started regardless, found only its
  built-ins and improvised. It now presents the token the process already
  holds.
- **A failed run left the chat thread silent.** The panel fell back to the run
  row only when the thread held no agent message at all, so from the second
  failure onward the failure vanished entirely: the operator saw their own
  message, no reply, and no error. The reason is now persisted the way the
  native executor does it, and rendered as a line that names the control which
  actually fixes it — a step budget that ran out says which setting moves it,
  rather than "Reached maximum number of turns (15)".
- **Every animated event tag was dead.** The icon never carried the class its
  keyframes hang off, and the keyframes themselves were referenced by a name
  Svelte had already rewritten — so pulse, spin, shake, wobble, bounce, sparkle
  and pop had never once played.
- Array and object arguments an executor had serialised into strings are
  recovered instead of reaching the tool as `"[object Object]"`.
- The Google re-auth detection matched Claude Code SDK errors and demanded a
  re-login that fixed nothing; it now matches the kernel's own error signatures.
- Model-chain coercion turned non-string values into `undefined` rather than
  strings, and now uses an explicit empty-string sentinel.
- The drawer store: stale `seed()`, per-field patch rollback, in-flight fields
  overwritten when the drawer was re-seeded, writes not reconciled against the
  saved row, and a leaked menu listener per open.
- Skill status classification, the unknown-cost display, and tokenization of
  accented text.
- Chain controls stay disabled while the chain is being written.

## [0.2.6] - 2026-08-23

### Added

- Repos are scoped to agents and surfaced in the UI; office environments moved
  to DevOps.
- Agent sandbox mounts, extension bundling, and markdown lists.

### Fixed

- The OpenAI provider, the model picker, and a readiness gate that was too wide.
- Cinema subtitle translation reuses cached transcripts and reaches our own port.

### Changed

- Stopped publishing container images nobody pulled.

## [0.2.5] - 2026-08-22

### Added

- LM Studio is found on its own, along with the model it has loaded and that
  model's real context window.
- Discover has a shelf for extensions and one for skills.
- An About section in settings, with an update check.

### Changed

- Agents walk through doorways, and each one carries a single label in the
  office.
- Community `SKILL.md` files are read the way their authors wrote them.
- Archive.org originals are preferred over the Theora derivative.

### Fixed

- A provider's design was reported as a fault.
- The music player is called by the product's name.

## [0.2.4] - 2026-08-17

### Fixed

- The ffmpeg build linked the runner's Homebrew libraries, could not link
  iconv, and took TLS from Homebrew's openssl instead of SecureTransport —
  producing binaries that did not run on a clean machine.
- Subtitle generation works in the native packages.
- A module can retire an agent driver whose upstream is gone.

### Changed

- A rebuilt whisper bundle for macOS 13 and 14.
- The standalone Models and AI Providers pages are gone.

## [0.2.3] - 2026-08-15

### Added

- `scripts/release.sh` — the release sequence, which until now lived in shell
  history.
- A `reload:local` script for the docker-compose.yml stack.

### Fixed

- Archive.org originals play, and subtitles are no longer invented for silent
  films.
- The Apple Health push route is exempt from the master token gate.
- The PTY is borrowed the way BSD `script` wants it on macOS.

### Changed

- The more-like-this strip in the cinema player, redesigned.
- The update notice is out of the sidebar column.

## [0.2.2] - 2026-08-14

### Fixed

- `ConfigService` was constructed with arguments it does not take.
- sharp's binaries are locked for every platform we build on.

### Added

- The CUDA whisper is built when the GPU overlay is applied.
- The updater verifies what it downloads, and offers brew as the other route.

## [0.2.1] - 2026-08-14

### Added

- The navigation is translated instead of rendering the manifest's English, and
  settings and nav labels carry a language.
- The kernel says when it paused an agent, and when one is waiting on an answer.
- E2E coverage for the Torrents group and the TV Spanish copy.

### Fixed

- An update macOS would refuse is refused here first, and said so before the
  first launch.
- Every agent run outcome is reported to the circuit breaker; some were not,
  so the breaker never opened.
- The download resolves from the release rather than from a template.
- sharp's platform binary ships in the payload, and the payload's packages stay
  resolvable from a materialized extension.
- Cinema's subtitle pipeline points at cinema's own routes.
- The dev server stays on loopback, like the dashboard it stands in for.

### Changed

- The reasoning scratchpad is folded instead of printed.
- "Configure a provider" is a button, not prose.
- A tool call in chat is readable and its result reachable.

## [0.2.0] - 2026-08-14

### Security

- **The default Docker stack no longer runs unauthenticated.** `docker-compose.yml`
  set `KERNEL_ALLOW_UNAUTH=1`, justified by publishing the dashboard on
  127.0.0.1. Loopback is not a trust boundary against a browser: combined with a
  wildcard `Access-Control-Allow-Origin` on every response, any page a user had
  open could read — and write — the entire kernel cross-origin, including the
  MCP tool surface. The quick start now runs with the token the kernel
  generates on first boot.
- **CORS is deny-by-default.** `Access-Control-Allow-Origin` is sent only for an
  origin explicitly listed in `CORS_ALLOWED_ORIGINS`; an empty list means
  same-origin only, which is what the bundled dashboard needs. Previously an
  empty list meant `*`, and a non-matching origin was answered with the first
  configured origin instead of a refusal.
- **License recovery no longer hands out license keys.** `GET /api/license/lookup`
  returned the full license JWT — the download credential for every extension a
  customer owns — to anyone who knew their email address, and its 404 confirmed
  which addresses were customers. It now mails the license to the address on
  file and answers 202 identically either way.
- **Torrents is gated at runtime.** The paid extension shipped with no license
  check on either its MCP tools or its `/api/torrents/*` routes; only the bundle
  download was protected.
- The auth token generated on first boot is handed to the browser through the
  URL fragment, which is never sent to the server, instead of a query string.

### Fixed

- **Backups captured the wrong database, and said so cheerfully.** `backup.sh`
  copied the repo's `./data/kernel.db` — usually a stale leftover — rather than
  the database inside the Docker volume, used `cp` on a WAL-mode database open
  by the kernel, and exited 0 when it found nothing. It now snapshots through
  SQLite (`VACUUM INTO`), verifies the result before calling it a backup, and
  fails loudly. It also captures `.kernel-encryption-key`, without which
  encrypted secrets in a restored database are unrecoverable.
- **Restores wrote where nothing reads.** `restore.sh` copied the database into
  the repo's `./data` even on Docker deployments, skipped the encryption key,
  and reported "starting fresh" when the archive had no database. It now
  requires an explicit `--docker` / `--native` target and refuses an empty
  archive.
- **Paid licenses were rejected on every non-Docker install.** The kernel
  expected an issuer of `issuer.mtwkernel.com` while licenses are minted by
  `issuer.lifekernl.com`, and only `docker-compose.yml` set the override — so
  rpm, deb, dmg and msi installs failed to activate a valid key.
- **Code signing never ran, with or without certificates.** The release
  workflow's signing steps were gated on `if: env.X != ''` with `X` defined in
  the same step's `env:` block, which is not in scope for that step's own
  condition. Every release published unsigned artifacts and reported success.
- The kernel bound to loopback even with authentication enabled: `loadConfig()`
  resolved the bind before bootstrap generated the auth token, permanently
  rewriting an explicit `0.0.0.0`. The decision now happens where the final
  token is known.
- First run on a native install dead-ended at a login screen asking for a token
  the user had never been shown. The macOS and Windows launchers now hand it
  over; the Linux launcher prints where to find it.
- `docs/DEPLOYMENT.md` documented the Neo4j backup against a volume name that
  does not exist, which makes `docker run -v` create an empty one and archive
  nothing, successfully.

## [0.1.1] - 2026-08-03

### Fixed

- Native packages serve the dashboard again: the staged SPA lives at
  `dashboard/`, which none of the static-directory candidates matched, so every
  .deb, .rpm, .dmg and .msi returned 500 at `/` while the API answered normally.
- RPM no longer generates dependencies against the vendored tree, and drops the
  sqlite dependency that blocked RHEL rebuilds.
- Release publication: artifact casing, license metadata, tag guard, macOS
  runner pinning, and a CI check that keeps the npm lockfiles in sync with
  `package.json` — drift there is what made a tagged release ship with no
  assets at all.

## [0.1.0] - 2026-07-29

Initial public release.

### Added

- ~290 MCP tools across 60+ self-contained modules (tasks, CRM, reminders,
  shopping, home, events, finance, health, training, nutrition, agents, chat,
  and more)
- Web dashboard (SvelteKit SPA) with 20+ views
- Multi-channel notifications (Telegram, Slack, Discord, WhatsApp, Mattermost,
  WebChat)
- Neo4j graph analytics (optional) with GDS algorithms
- Life Intelligence panel (weather, AQI, moon, currencies, earthquakes)
- AI agents with scheduling, triggers and feedback loops
- Cognitive chat with episodic memory and context retrieval
- Google Contacts/Gmail sync
- Encrypted secrets (AES-256-GCM), auto-generated and persisted on first boot
- PII filter for LLM calls
- Docker Compose deployment (separate frontend/backend containers)
- Cross-platform packaging: rpm, deb, dmg, msi and portable zip
- GitHub Actions CI pipeline

### Security

- API authentication via `KERNEL_AUTH_TOKEN`, generated and persisted when unset
- Configurable CORS via `CORS_ALLOWED_ORIGINS`
- Security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- HTTP rate limiting for non-local callers
- SSRF protection on user-controlled outbound fetches
- Signature verification (RS256) on paid extension bundles before install
