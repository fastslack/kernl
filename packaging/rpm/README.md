# Kernl — Fedora/RHEL/CentOS RPM packaging

Self-contained x86_64 RPM that bundles:

- The Bun runtime (vendored, ~80 MB raw)
- The pre-built kernel JS (`dist/mcp-server.js`, ~22 MB)
- Linux-x64-pruned native modules (`better-sqlite3`, `onnxruntime-node` CPU
  bin only, `@huggingface/transformers`, `neo4j-driver` and their deps)
- The Svelte dashboard build
- Bundled extensions and agents

**Installed size:** ~445 MB. **RPM size on disk:** ~143 MB.

## Build

```bash
# from repo root, on a Fedora-like host with rpmbuild + node + bun + npm
sudo dnf install rpm-build
packaging/rpm/build-rpm.sh
```

Output: `~/rpmbuild/RPMS/x86_64/kernl-<version>-1.fc*.x86_64.rpm`

The script:

1. Runs `npm run build` so `dist/` is fresh.
2. Vendors the system `bun` (or downloads Linux-x64 from bun.sh if missing).
3. Stages the runtime tree under `~/.tmp/kernl-<v>/`.
4. Prunes `onnxruntime-node` to **CPU-only Linux x64** (drops CUDA, TensorRT,
   ROCm, CoreML, DirectML, arm64, win32, darwin variants — saves ~480 MB).
5. Resolves the dependency closure of `better-sqlite3` + `onnxruntime-node` +
   `@huggingface/transformers` + `neo4j-driver` and copies just those.
6. Tarballs to `~/rpmbuild/SOURCES/`.
7. Calls `rpmbuild -bb` against `kernl.spec`.

## What's inside the package

| Path | Purpose |
|---|---|
| `/opt/kernl/bin/bun` | Vendored Bun runtime |
| `/opt/kernl/bin/mcp-server.js` | Bundled kernel |
| `/opt/kernl/bin/static/` | Static HTML pages served by the kernel |
| `/opt/kernl/bin/extensions/` | Built-in `.kernl` bundles |
| `/opt/kernl/node_modules/` | Pruned native modules |
| `/opt/kernl/dashboard/` | Svelte SPA (served at `/`) |
| `/opt/kernl/assets/` | Agents, skills, agent-bundles |
| `/usr/bin/kernl` | Wrapper (cd → per-user data dir, exec bun) |
| `/usr/lib/systemd/user/kernl.service` | systemd user unit |
| `/usr/share/applications/kernl.desktop` | Desktop launcher |
| `/etc/kernl/env.example` | Per-user config template |

## Per-user state (created on first run)

| Path | What |
|---|---|
| `~/.local/share/kernl/data/kernel.db` | SQLite (tasks, contacts, …) |
| `~/.local/share/kernl/data/extensions/` | User-installed extensions |
| `~/.config/kernl/.env` | Port, encryption key, LLM keys, etc. |

Each Linux account gets its own isolated kernel.

## Install

```bash
sudo dnf install ~/rpmbuild/RPMS/x86_64/kernl-0.1.0-1.fc42.x86_64.rpm
```

## Run

Three options, all do the same thing:

| Method | Command |
|---|---|
| **Desktop** | Search "Kernl" in your launcher → click it. The launcher starts the systemd unit and opens the browser. |
| **systemd** | `systemctl --user enable --now kernl` |
| **Foreground** | `kernl` (good for debugging — logs to stdout) |

Then open `http://localhost:3086`. Logs:

```bash
journalctl --user -u kernl -f
```

## Tier 1 vs Tier 2

**Tier 1 — out of the box (no graph DB):**

- All non-graph features work: tasks, CRM, reminders, finance, notes,
  calendar, time tracking, health, goals, learning, nutrition, training,
  shopping, comms (with Gmail OAuth), chat (with LLM keys), torrents,
  cinema (semantic search degrades to SQLite-only), federation, social.
- The graph driver registry boots with `noop` active. Graph-dependent
  modules (graph-intel analytics, vector similarity, news/cinema RAG)
  return empty payloads gracefully — no crashes.

**Tier 2 — opt-in graph analytics:**

1. Install Neo4j Desktop or run a Neo4j 5+ container.
2. Open `http://localhost:3086/extensions`.
3. Filter the "Database" type, click `Neo4j` → enter your `bolt://…` URI
   + credentials → **Activate**.
4. The kernel auto-detects GDS at activation and exposes the heavy
   features (PageRank, Louvain, FastRP embeddings, vector index search).

The toggle is hot — switching backends in `/extensions` takes effect on
the next call without a kernel restart for ~85% of modules. The `trading`
module's graph layer still requires a restart after a backend switch
(migration TODO).

## Uninstall

```bash
sudo dnf remove kernl
# Per-user data is NOT removed; clear manually if desired:
rm -rf ~/.local/share/kernl ~/.config/kernl
```

## Caveats / known issues

- **No code signing yet.** Fedora won't complain (it doesn't enforce
  signatures by default), but for distribution we should sign the RPM
  with a GPG key. See `rpm-sign` and `rpmsign`.
- **bun is statically linked** — no rebuild required for users on
  different glibc minor versions, but glibc < 2.34 will fail to load
  (declared in `Requires:`).
- **No SELinux policy.** The kernel runs as a regular user process, so
  the default `unconfined_u` works. Tighter confinement is a v0.2 task.
- **Port 3086 may collide** on developer machines running the existing
  Docker dev stack. Override via `~/.config/kernl/.env`:
  `DASHBOARD_PORT=3088`.
