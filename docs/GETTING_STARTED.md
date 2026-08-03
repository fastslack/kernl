# Getting Started with Kernl

A personal life management server that works as an MCP tool provider for Claude, with a web dashboard for visualization.

## Prerequisites

- **Bun >= 1.2** (recommended) or Node.js >= 20
- **Docker** (optional, for Neo4j graph database)

## Installation

```bash
git clone <repo-url>
cd Kernl
cp .env.example .env
bun install
```

## Minimal Setup

Kernl works with **zero external services**. The minimum `.env` needs nothing -- all defaults work:

```bash
# .env (minimal -- everything else is optional)
SQLITE_PATH=./data/kernel.db
```

Neo4j, Telegram, Google Sync, voice, and all other integrations are optional and degrade gracefully.

## Running

```bash
# Development (MCP stdio mode)
bun run dev

# With dashboard (HTTP mode)
DASHBOARD_ENABLED=true bun run dev

# Docker (recommended for production)
docker compose up -d
```

Dashboard: **http://localhost:3086**

## Using with Claude Desktop

Add to your Claude Desktop MCP config (`.mcp.json` or settings):

```json
{
  "mcpServers": {
    "Kernl": {
      "command": "bun",
      "args": ["run", "/path/to/Kernl/services/kernel/bin/mcp-server.ts"]
    }
  }
}
```

Then ask Claude: "Create a task called 'Read GETTING_STARTED.md'" -- it will use the `kernel_tasks_create` tool.

## First Actions

Once running, try these via Claude or the dashboard:

1. **Create a task**: "Add a task: Set up Kernl"
2. **Add a contact**: "Add contact John Doe, email john@example.com"
3. **Set a reminder**: "Remind me to check the dashboard in 2 hours"
4. **Log water**: "Log 1 glass of water"
5. **Check status**: "Give me a morning briefing"

## Module Overview

| Module | What it does |
|--------|-------------|
| **tasks** | GTD task management with priorities, contexts, dependencies |
| **crm** | Personal CRM (contacts, interactions, relationship tracking) |
| **reminders** | Time-based reminders with multi-channel notifications |
| **shopping** | Product inventory, shopping lists, purchase tracking |
| **home** | Home management (maintenance, appliances, projects, incidents) |
| **events** | Group event management with RSVP, waitlists, recurrence |
| **finance** | Accounts, transactions, budgets |
| **health** | Health metrics, medications, appointments |
| **training** | Workout tracking, cardio, personal records, programs |
| **nutrition** | Meal logging, macros, water, fasting |
| **notes** | Markdown notes with full-text search |
| **documents** | Document metadata and expiry tracking |
| **vehicles** | Vehicle maintenance, fuel logs, incidents |
| **goals** | OKR-style goals with key results |
| **comms** | Multi-channel communications (Gmail, drafts, templates) |
| **chat** | Cognitive chat with memory and context retrieval |
| **agents** | AI agents with scheduling, triggers, and learning |
| **dashboard** | Web UI + life intelligence (weather, AQI, moon, clocks) |

Additional Pro extensions (trading, web-intel, graph-intel, mesh, federation)
are distributed separately with a [Kernl Pro license](https://lifekernl.com/pricing).

## Optional Features

### Neo4j (Graph Analytics)
```bash
docker compose up -d neo4j
# Enables: contact network analysis, community detection, semantic search
```

### Telegram Bot
```bash
# In .env:
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USERS=your-user-id
```

### Security (recommended for network exposure)
```bash
# Generate tokens:
openssl rand -hex 32  # for each value below

# In .env:
KERNEL_AUTH_TOKEN=<generated-token>
KERNEL_ENCRYPTION_KEY=<generated-key>
CORS_ALLOWED_ORIGINS=http://localhost:3086
```

## More Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) -- System design and module development guide
- [CONTRIBUTING.md](CONTRIBUTING.md) -- How to contribute
- [SECURITY.md](SECURITY.md) -- Security measures and vulnerability reporting
- [PRIVACY.md](PRIVACY.md) -- Data handling and privacy policy
