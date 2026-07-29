<div align="center">

<img src="docs/assets/mascot.png" alt="Kernl" width="200">

# Kernl

### The memory layer your AI has been missing.

**One self-hosted server that gives any LLM your whole life — tasks, email, finance, contacts, calendar — plus a fleet of agents that actually get work done. Private by default.**

<p>
  <a href="https://github.com/fastslack/kernl/stargazers"><img src="https://img.shields.io/github/stars/fastslack/kernl?style=for-the-badge&logo=github&color=ffd700" alt="GitHub stars"></a>
  <a href="https://github.com/fastslack/kernl/releases"><img src="https://img.shields.io/github/v/release/fastslack/kernl?style=for-the-badge" alt="Latest release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge" alt="License"></a>
  <img src="https://img.shields.io/badge/MCP-native-6366f1?style=for-the-badge" alt="MCP native">
  <img src="https://img.shields.io/badge/self--hosted-000?style=for-the-badge" alt="Self-hosted">
</p>

<a href="#-quick-start"><b>Quick start</b></a> ·
<a href="#-why-kernl"><b>Why Kernl</b></a> ·
<a href="#-whats-inside"><b>Features</b></a> ·
<a href="#-mcp-integration"><b>MCP integration</b></a> ·
<a href="https://github.com/fastslack/kernl/discussions"><b>Discussions</b></a>

</div>

---

## Your AI is brilliant — and amnesiac.

Every conversation starts from zero. Your LLM can't see your tasks, read your inbox, check your budget, or remember what you told it yesterday. And the cloud "AI assistants" that promise to fix that? They want your entire life uploaded to *their* servers.

**Kernl fixes both.**

## What is Kernl?

Kernl is a **self-hosted** server that plugs your real life into **any** LLM through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). One endpoint exposes **~290 tools across 60+ modules** — tasks, contacts, email, finance, calendar, notes, health, shopping, travel and more — to Claude, Cursor, or any MCP client.

Then it goes past a data bridge: Kernl runs **agents** — autonomous teams (it calls them *offices*) that work in loops, call your tools, and finish jobs while you're away.

Everything runs on **your machine**. Your data never leaves the box.

<div align="center"><sub><b>WORKS WITH</b></sub><br>Claude · Cursor · OpenAI · Grok · LM Studio · <b>any MCP client</b></div>

## 💬 Talk to your life

Point your AI at Kernl and ask it things it could never do before:

> 💸 *"Did rent clear, and how much did I spend on food this month?"* — reads your finance module.
>
> 📥 *"Triage my inbox and draft replies to anything urgent."* — reads your email, writes the drafts.
>
> ✅ *"What's overdue, and what's due this week?"* — straight from your real tasks + calendar.
>
> 🤖 *"Spin up the dev office and clear the next three backlog items."* — launches an agent team that works on its own.

Real data. Real actions. On your machine — not in someone else's cloud.

## 🎬 See it in action

<div align="center">
<img src="docs/assets/demo.gif" alt="Kernl 3D office — watch your agents work" width="800">
<br><i>Watch your agents walk between desks and get work done in the live 3D dashboard.</i>
</div>

## ⚡ Quick start

Zero config. One command. A full stack in ~2 minutes:

```bash
git clone https://github.com/fastslack/kernl.git
cd kernl
docker compose up -d --build
```

→ Dashboard at **http://localhost:3086** · MCP endpoint at **http://localhost:3086/mcp**

No API keys, no host paths, no accounts. Add your LLM keys and channels later from **Settings → AI**. The graph brain (Neo4j) and key-free web search come bundled.

## 🔥 Why Kernl

|  |  |
|---|---|
| 🔒 **Private by default** | Self-hosted. Your tasks, email and finances never touch someone else's cloud. |
| 🧠 **Real memory** | A graph-backed brain (Neo4j + GDS) links every module, so your AI finally *remembers*. |
| 🤖 **Agents that act** | Not a chatbot — autonomous *offices* that work in loops and use your tools. |
| 🔌 **Any LLM, any client** | Claude, OpenAI, Grok, or a local model via LM Studio. Any MCP client connects. |
| 🧩 **Endlessly extensible** | Everything is a module. Ship your own as a portable `.kernlext` package. |
| 📊 **~290 tools, 60+ modules** | One surface for your whole life — not fifteen disconnected apps. |

## ⚔️ Kernl vs. the usual options

|  | Cloud AI assistants | A single MCP server | "Second brain" apps | **Kernl** |
|---|:---:|:---:|:---:|:---:|
| Your data stays on your machine | ❌ | ✅ | ⚠️ | ✅ |
| Your real life — email, finance, tasks… | partial | one thing | ❌ | **60+ modules** |
| Agents that *act*, not just chat | limited | ❌ | ❌ | ✅ |
| Works with any LLM & MCP client | ❌ | ✅ | ❌ | ✅ |
| Yours to extend & fork | ❌ | ⚠️ | ❌ | ✅ |

## 🧩 What's inside

**Your life, addressable by your AI** — tasks & projects, contacts/CRM, reminders, email (IMAP/SMTP), finance & budgets, calendar, notes, goals, health & training, shopping, travel, documents… 60+ modules, every one exposed as MCP tools.

**A fleet of agents** — cooperating agents with chains, schedules and their own workspaces. Package a whole team as an installable `.kernlext` *office*, and watch them work in a live **3D office view**.

**Pluggable everything**
- **LLM providers** — Claude, OpenAI, Grok, LM Studio (local), and more via extensions.
- **Sandbox drivers** — run agent code in Docker, CubeSandbox, or your own driver.
- **Channels** — WhatsApp, Telegram, Slack, email, Mattermost and webchat on one notification bus.

**Graph intelligence** — optional Neo4j + GDS for cross-module relationship analysis.

## 🔌 MCP integration

Kernl speaks MCP over **stdio** and **Streamable HTTP** at the same time, so every client reaches the same tools.

<details>
<summary><b>Claude Desktop / Cursor (stdio)</b></summary>

```json
{
  "mcpServers": {
    "kernl": {
      "command": "bun",
      "args": ["run", "bin/mcp-server.ts"],
      "cwd": "/absolute/path/to/kernl/services/kernel"
    }
  }
}
```
</details>

<details>
<summary><b>Any HTTP client</b></summary>

The MCP HTTP transport is at `http://localhost:3086/mcp` by default (the official Streamable HTTP spec).
</details>

## 🛠️ Build your own

An **extension** is a folder (or a packaged `.kernlext`) with a `manifest.json` plus any of: a backend module (new MCP tools + HTTP routes), agents & offices, agent-scoped skills, a theme, a channel, or a sandbox driver.

Keep operator-specific material — named agents, your WhatsApp, regional scrapers — private under `services/kernel/assets/personal-agents/` (gitignored, ideal for a private submodule).

Full guide → [`docs/architecture/extension-points.md`](./docs/architecture/extension-points.md)

## 📦 More install options

<details>
<summary><b>Full stack — real-time bridge + WhatsApp</b></summary>

Adds the [mtwRequest](https://github.com/fastslack/mtwRequest) Rust server, the WhatsApp bridge, and host-coupled mounts (so on-host `claude_code` agents can edit your sibling repos). Needs a few host paths in `.env`:

```bash
git clone https://github.com/fastslack/kernl.git
cd kernl
cp .env.example .env
$EDITOR .env   # set HOST_HOME, HOST_KERNEL_ROOT, HOST_PROJECTS_ROOT,
               # KERNEL_REQUEST_SRC, KERNEL_WHATSAPP_BRIDGE_SRC
docker compose -f docker-compose.full.yml up -d --build
```
</details>

<details>
<summary><b>Local dev — no Docker</b></summary>

```bash
git clone https://github.com/fastslack/kernl.git
cd kernl
bun install --cwd services/kernel   # requires bun >= 1.3
cp .env.example .env
bun run dev                # stdio MCP + HTTP router (delega a services/kernel)
```
</details>

## Requirements

- **Bun ≥ 1.3** (primary runtime) or **Node ≥ 20**.
- **Docker + Compose** (recommended — unlocks the full stack).
- **Neo4j 5.x + GDS** (optional; Compose starts one for you; Kernl degrades gracefully without it).

## Configuration

Everything is environment-driven — copy `.env.example` to `.env`. Minimum keys for Docker runs:

| Variable | Purpose |
|---|---|
| `HOST_HOME` | Your host home, mounted read-only into the kernel container |
| `HOST_KERNEL_ROOT` | Absolute host path of this repo (Docker-in-Docker path translation) |
| `HOST_PROJECTS_ROOT` | Parent dir of sibling repos, mounted at `/host-projects` |
| `KERNEL_ENCRYPTION_KEY` | 32-byte hex (`openssl rand -hex 32`) for encrypting stored secrets |

Everything else (LLM keys, Neo4j creds, feature toggles) is documented inline in `.env.example`.

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Start the MCP server + HTTP router |
| `bun run wizard` | Interactive setup wizard |
| `bun run doctor` | Self-diagnostics (DB, providers, channels) |
| `bun test` | Run the test suite |
| `bun run build` | Bundle to `services/kernel/dist/` |
| `bun run reload` | Rebuild + restart the kernel container |

## Documentation

- [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md) — first-run walkthrough
- [`docs/ARCHITECTURE-MAP.md`](./docs/ARCHITECTURE-MAP.md) — contributor map · [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — full system guide
- [`docs/API_DOCS.md`](./docs/API_DOCS.md) — HTTP + MCP surface reference
- [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) — production deploys
- [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) · [`docs/SECURITY.md`](./docs/SECURITY.md) · [`docs/PRIVACY.md`](./docs/PRIVACY.md)

## ⭐ Contributing & community

Kernl is Apache-2.0 and built in the open. **Star the repo** if it's useful, [open an issue](https://github.com/fastslack/kernl/issues) for bugs and ideas, and say hi in [Discussions](https://github.com/fastslack/kernl/discussions). Contributions welcome — see [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md).

## License & credits

Created and maintained by **[Matias Aguirre](https://github.com/fastslack)** — a **Matware** project. See [`AUTHORS`](./AUTHORS) and [`NOTICE`](./NOTICE).

Released under the **Apache License 2.0** — fork it, build commercial plugins on top, redistribute, modify. © 2026 Matware.
