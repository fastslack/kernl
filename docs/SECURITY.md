# Security Policy

Kernl is a self-hosted personal/small-team kernel that handles sensitive
data — contacts, communications, finance, credentials vault, and integration
tokens. We take security reports seriously and appreciate responsible
disclosure.

## Supported Versions

Security fixes are applied to the latest released version on the `main`
branch. Older releases are not patched retroactively.

| Version | Supported |
| ------- | --------- |
| latest `main` / newest release | ✅ |
| older releases | ❌ |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately through one of:

1. **GitHub Security Advisories** (preferred) — use the
   [**Report a vulnerability**](https://github.com/fastslack/kernl/security/advisories/new)
   button on the Security tab. This keeps the report private until a fix
   is published.
2. **Email** — `fastslack@gmail.com` with the subject line
   `[Kernl security]`. Encrypt with the maintainer's public key if you
   have it.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept if possible).
- Affected version / commit, and your environment (OS, Node/Bun version).
- Any suggested remediation.

**Redact secrets** (tokens, API keys, personal data) from logs and PoCs
before sending.

## What to Expect

- **Acknowledgement** within 72 hours.
- An initial assessment and severity classification within 7 days.
- Coordinated disclosure: we will agree on a timeline with you before any
  public advisory. We aim to ship a fix within 90 days, sooner for
  high-severity issues.
- Credit in the advisory and release notes, unless you prefer to remain
  anonymous.

## Scope

In scope:

- The kernel server (`services/kernel/src/`), bundled extensions (`services/kernel/assets/extensions/`),
  the dashboard (`services/dashboard/`), and packaging/distribution artifacts.
- Authentication, session handling, SSRF guards, secret storage (vault),
  and the MCP transport layers (stdio + Streamable HTTP).

Out of scope:

- Vulnerabilities in third-party dependencies that already have a public
  advisory and a maintainer fix in progress (please upstream those).
- Issues that require a pre-compromised host or physical access.
- Self-inflicted misconfiguration (e.g. exposing the HTTP transport to the
  public internet without authentication).

## Security Measures

Kernl implements the following security measures:

- **API Authentication**: Bearer token required for all API endpoints (`KERNEL_AUTH_TOKEN`)
- **WebSocket Authentication**: Token required on connection
- **Encryption**: Sensitive data encrypted at rest using AES-256-GCM (`KERNEL_ENCRYPTION_KEY`)
- **PII Protection**: Automatic PII filtering before external LLM API calls (enabled by default)
- **Rate Limiting**: Configurable rate limits on messaging channels and the HTTP API
- **CORS**: Configurable origin whitelist via `CORS_ALLOWED_ORIGINS`
- **Input Validation**: Zod schemas validate all MCP tool inputs
- **SQL Injection Prevention**: Parameterized queries throughout
- **Local-First**: All data stored locally (SQLite + optional Neo4j). Zero telemetry.

## Hardening Notes for Operators

- **Always set `KERNEL_AUTH_TOKEN` and `KERNEL_ENCRYPTION_KEY`** — generate
  each with `openssl rand -hex 32` (the server refuses tokens shorter than
  32 chars). `install.sh` generates them for you.
- **Change the Neo4j password** — never ship the compose stack with a weak
  or default password.
- **Restrict CORS** — set `CORS_ALLOWED_ORIGINS` to your dashboard URL only.
- Never commit your `.env`, `data/`, or `*.db` files — they are gitignored
  by default; keep them that way.
- Keep the credentials vault locked when not in use.
- Bind to localhost and run the HTTP transport behind a reverse proxy with
  TLS (Nginx, Caddy) for any network exposure; it is not designed to be
  exposed directly to untrusted networks.
- Rotate integration tokens (Telegram, Mattermost, Google, etc.) if you
  suspect they were ever logged or shared.
