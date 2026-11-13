# FAQ

Common setup and onboarding questions. If yours isn't here, open a
[Discussion](https://github.com/fastslack/kernl/discussions).

## Running it

**What's the fastest way to try it?**
```bash
docker compose up -d --build
open http://localhost:3086
```
Zero config: kernel (with its built-in graph) + dashboard + SearXNG. The dashboard binds to
`127.0.0.1:3086` (loopback only). The kernel auto-generates and persists an auth
token and an encryption key on first boot.

**Do I need Neo4j?**
No. The graph is built in: the kernel runs Relate, an embedded Cypher engine, on
`data/graph` — memory, semantic recall and the agents' shared learning work
with no server. Neo4j is optional, for Graph Data Science analytics (community
detection, PageRank): `docker compose -f docker-compose.yml -f docker-compose.neo4j.yml up -d`,
then activate "Neo4j" in `/extensions`.

**Does it run on Apple Silicon / ARM?**
The published images target `linux/amd64` and `linux/arm64`. If you build locally
on an M-series Mac and a native dependency (`better-sqlite3`, the ONNX embeddings
runtime) fails to compile, please open an issue with the build log — multi-arch
support is actively maintained and these reports are how we keep it working.

**A port is already in use (3086, or 17474 / 17687 with Neo4j).**
3086 is the dashboard; 17474 and 17687 are the optional Neo4j's HTTP and Bolt
ports. Stop the conflicting service or override the port mappings in a compose
override file.

**I have little RAM.**
The default stack has no graph server — the graph runs inside the kernel. Leave
out `docker-compose.neo4j.yml` on a small host: Neo4j alone wants 1–2 GB.

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
