# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
