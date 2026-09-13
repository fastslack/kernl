# FAQ

Common setup and onboarding questions. If yours isn't here, open a
[Discussion](https://github.com/fastslack/kernl/discussions).

## Running it

**What's the fastest way to try it?**
```bash
docker compose up -d --build
open http://localhost:3086
```
Zero config: kernel + dashboard + Neo4j + SearXNG. The dashboard binds to
`127.0.0.1:3086` (loopback only). The kernel auto-generates and persists an auth
token and an encryption key on first boot.

**Do I need Neo4j?**
No. Graph features (analytics, similarity, some intelligence tools) light up when
Neo4j is reachable and degrade gracefully when it isn't. The default stack
includes it; you can remove the `neo4j` service to run leaner.

**Does it run on Apple Silicon / ARM?**
The published images target `linux/amd64` and `linux/arm64`. If you build locally
on an M-series Mac and a native dependency (`better-sqlite3`, the ONNX embeddings
runtime) fails to compile, please open an issue with the build log — multi-arch
support is actively maintained and these reports are how we keep it working.

**A port is already in use (3086 / 7474 / 7687).**
Those are the dashboard, Neo4j HTTP, and Neo4j Bolt ports. Stop the conflicting
service or override the port mappings in a compose override file.

**Neo4j gets OOM-killed / I have little RAM.**
Neo4j is the heaviest service. The public compose caps its heap low, but on a
≤2 GB host you may still want to drop the `neo4j` service entirely and run without
graph features.

## Runtime & contributing

**Why Bun instead of Node?**
Bun is the runtime (fast startup, built-in SQLite, TypeScript without a build
step for dev). Scripts use `bun`; imports use the `.js` extension (ESM Node16).
If you'd prefer Node, that's a known discussion topic — open an issue before
investing in a port.

**How do I run tests?**
`bun test` — in-memory SQLite, Neo4j treated as unavailable. `bun run lint` is
`tsc --noEmit`.

**I edited an extension and nothing changed.**
Extensions run from prebuilt bundles. Run `bun run build:extensions` after editing
anything under `services/kernel/assets/extensions/*/_module/`.

**Where do I start reading?**
[`ARCHITECTURE.md`](./ARCHITECTURE.md) — it opens with the 30-second model and
where everything lives. Then [`docs/CONTRIBUTING.md`](CONTRIBUTING.md).

## Project & support

**Is this really open source, or open-core?**
100% Apache-2.0. The full kernel — all 71 modules and 290 tools — is in this
repo with no paid-only features. A hosted option may exist for people who don't
want to self-host, but it runs the same open code; nothing is held back from the
repo.

**What's the support model?**
This is a small, mostly single-maintainer project. Issues and PRs are handled
best-effort. To get a PR merged fast: keep it focused, include a test, and
reference an issue. Onboarding questions belong in Discussions; bug reports in
Issues.
