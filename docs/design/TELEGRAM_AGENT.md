# Telegram Personal Agent - Design Document

## Vision

Transform Kernl from an MCP server (request-response) into a **persistent personal agent** accessible 24/7 via Telegram, capable of orchestrating other specialized agents (like LattePanda CH4 monitor).

```
                    +------------------+
                    |   YOU (Telegram) |
                    +--------+---------+
                             |
                    +--------v---------+
                    |   Kernl      |
                    |   Central Agent  |
                    +--------+---------+
                             |
         +-------------------+-------------------+
         |                   |                   |
+--------v-------+  +--------v-------+  +--------v-------+
| LattePanda Bot |  | Other Agent    |  | Future Agent   |
| (CH4 Monitor)  |  | (Home sensors) |  | (whatever)     |
+----------------+  +----------------+  +----------------+
```

## Current State Analysis

### What Kernl Already Has

| Component | Status | Location |
|-----------|--------|----------|
| Agent definitions & CRUD | **Ready** | `src/modules/agents/service.ts` |
| Agent execution with tools | **Ready** | `src/modules/agents/executor.ts` |
| Event triggers for agents | **Ready** | `AgentService.addEventTrigger()` |
| Scheduled agent runs | **Ready** | `AgentService.addSchedule()` |
| Reactive engine | **Ready** | `src/modules/agents/reactive-engine.ts` |
| Chat with LLM + tool calling | **Ready** | `src/modules/chat/` |
| Internal event bus | **Ready** | `src/core/event-bus.ts` |
| Notification pattern | **Ready** | `MattermostNotifier` |
| All MCP tools | **Ready** | 70+ tools registered |

### What's Missing

| Component | Status | Effort |
|-----------|--------|--------|
| Telegram transport | **Missing** | Medium |
| Multi-channel notifier | **Missing** | Low |
| External agent registry | **Missing** | Low |
| Agent-to-agent messaging | **Missing** | Medium |
| Natural language → tool routing | **Partial** | Chat module exists |

---

## Architecture

### 1. Telegram Transport Layer

**Library choice: `grammy`**
- Modern, TypeScript-first
- Middleware pattern like Koa/Express
- Good documentation
- Active maintenance

**Alternatives considered:**
- `telegraf` - More popular but older patterns
- `node-telegram-bot-api` - Callback-style, less type-safe

```typescript
// src/core/telegram.ts

import { Bot, Context } from "grammy";
import type { KernelConfig } from "./config.js";

export class TelegramTransport {
  private bot: Bot;
  private allowedUsers: Set<number>; // Whitelist by user ID

  constructor(config: KernelConfig["telegram"]) {
    this.bot = new Bot(config.botToken);
    this.allowedUsers = new Set(config.allowedUserIds);
  }

  // Auth middleware - only allow whitelisted users
  private authMiddleware = (ctx: Context, next: () => Promise<void>) => {
    if (this.allowedUsers.has(ctx.from?.id ?? 0)) {
      return next();
    }
    return ctx.reply("Unauthorized");
  };

  async start(handler: MessageHandler): Promise<void> {
    this.bot.use(this.authMiddleware);
    
    // Text messages → handler
    this.bot.on("message:text", async (ctx) => {
      const response = await handler(ctx.message.text, {
        userId: ctx.from.id,
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
      });
      await ctx.reply(response.text, { parse_mode: "Markdown" });
    });

    // Photos with caption (future: image analysis)
    this.bot.on("message:photo", async (ctx) => { /* ... */ });

    // Callback queries (inline buttons)
    this.bot.on("callback_query:data", async (ctx) => { /* ... */ });

    await this.bot.start();
  }

  async send(chatId: number, text: string, options?: SendOptions): Promise<void> {
    await this.bot.api.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      ...options,
    });
  }

  async sendPhoto(chatId: number, photo: Buffer | string, caption?: string): Promise<void> {
    await this.bot.api.sendPhoto(chatId, photo, { caption });
  }
}
```

### 2. Config Extension

```typescript
// Add to KernelConfig

telegram: {
  botToken: string;           // TELEGRAM_BOT_TOKEN
  allowedUserIds: number[];   // TELEGRAM_ALLOWED_USERS (comma-separated)
  defaultChatId: number;      // TELEGRAM_DEFAULT_CHAT (for proactive messages)
  enabled: boolean;
};
```

### 3. Unified Notifier

Replace `MattermostNotifier` with multi-channel notifier:

```typescript
// src/core/notifier.ts

export type NotificationChannel = "mattermost" | "telegram";

export interface Notification {
  title: string;
  body: string;
  channel?: NotificationChannel;  // default: all enabled
  priority?: "low" | "normal" | "high";
  data?: Record<string, unknown>;
}

export class Notifier {
  private mattermost: MattermostNotifier | null;
  private telegram: TelegramTransport | null;
  private defaultChatId: number;

  async send(notification: Notification): Promise<void> {
    const text = `**${notification.title}**\n${notification.body}`;
    
    if (this.telegram && notification.channel !== "mattermost") {
      await this.telegram.send(this.defaultChatId, text);
    }
    
    if (this.mattermost && notification.channel !== "telegram") {
      await this.mattermost.sendRaw(text);
    }
  }
}
```

### 4. Central Orchestrator

The brain that routes incoming messages to the right handler:

```typescript
// src/core/orchestrator.ts

export class Orchestrator {
  constructor(
    private chatService: ChatService,
    private agentService: AgentService,
    private tools: ToolDefinition[],
    private notifier: Notifier,
  ) {}

  async handleMessage(
    text: string,
    context: MessageContext,
  ): Promise<OrchestratorResponse> {
    
    // 1. Check for commands (slash commands)
    if (text.startsWith("/")) {
      return this.handleCommand(text, context);
    }

    // 2. Check for agent report (from external agents)
    if (context.isAgent) {
      return this.handleAgentReport(text, context);
    }

    // 3. Natural language → Chat service with tool calling
    const episode = await this.getOrCreateEpisode(context.userId);
    const response = await this.chatService.chat(episode.id, text, {
      tools: this.tools,
    });

    return {
      text: response.message.content,
      actions: response.tool_calls,
    };
  }

  private async handleCommand(text: string, context: MessageContext) {
    const [cmd, ...args] = text.split(" ");
    
    switch (cmd) {
      case "/status":
        return this.getSystemStatus();
      case "/agents":
        return this.listAgents();
      case "/run":
        return this.runAgent(args[0], args.slice(1).join(" "));
      case "/remind":
        return this.createQuickReminder(args.join(" "));
      // ... more commands
    }
  }
}
```

### 5. External Agent Registry

Track and communicate with external agents (like LattePanda):

```typescript
// New table: external_agents

CREATE TABLE external_agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  platform        TEXT NOT NULL DEFAULT 'telegram',  -- telegram, http, mqtt
  platform_id     TEXT NOT NULL DEFAULT '',          -- telegram user_id, webhook URL, etc.
  capabilities    TEXT NOT NULL DEFAULT '[]',        -- JSON array
  last_seen_at    TEXT,
  status          TEXT NOT NULL DEFAULT 'unknown'
                  CHECK(status IN ('online','offline','unknown','error')),
  config          TEXT NOT NULL DEFAULT '{}',        -- JSON config
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

// New table: agent_messages (agent-to-agent communication log)

CREATE TABLE agent_messages (
  id              TEXT PRIMARY KEY,
  from_agent_id   TEXT,                              -- NULL = user
  to_agent_id     TEXT,                              -- NULL = user
  direction       TEXT NOT NULL DEFAULT 'inbound'
                  CHECK(direction IN ('inbound','outbound')),
  message_type    TEXT NOT NULL DEFAULT 'text'
                  CHECK(message_type IN ('text','report','command','alert')),
  content         TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);
```

### 6. Proactive Behaviors

Scheduled actions that the agent performs autonomously:

```typescript
// src/core/proactive.ts

export class ProactiveEngine {
  private intervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private notifier: Notifier,
    private dashboardService: DashboardService,
    private reminderService: ReminderService,
  ) {}

  start(): void {
    // Morning briefing at 7am
    this.scheduleDaily("morning-briefing", "07:00", async () => {
      const briefing = await this.dashboardService.getMorningBriefing();
      await this.notifier.send({
        title: "Buenos dias",
        body: briefing,
        channel: "telegram",
      });
    });

    // Check reminders every minute
    this.scheduleInterval("reminder-check", 60_000, async () => {
      const due = await this.reminderService.getDue();
      for (const reminder of due) {
        await this.notifier.send({
          title: `Reminder: ${reminder.title}`,
          body: reminder.body,
        });
      }
    });

    // Evening summary at 9pm
    this.scheduleDaily("evening-summary", "21:00", async () => {
      const summary = await this.dashboardService.getEveningSummary();
      await this.notifier.send({
        title: "Resumen del dia",
        body: summary,
        channel: "telegram",
      });
    });
  }
}
```

---

## Implementation Plan

### Phase 1: Telegram Transport (3-4 hours)

1. Add `grammy` dependency
2. Create `TelegramTransport` class
3. Add config for Telegram
4. Basic message receive/send
5. Auth middleware (whitelist)
6. Test with simple echo bot

### Phase 2: Unified Notifier (2 hours)

1. Abstract `MattermostNotifier` interface
2. Create `TelegramNotifier` implementing same interface
3. Create unified `Notifier` that routes to both
4. Update reminders to use unified notifier

### Phase 3: Orchestrator Integration (4-5 hours)

1. Create `Orchestrator` class
2. Wire Telegram messages → Orchestrator → Chat service
3. Implement slash commands (/status, /tasks, /remind, etc.)
4. Tool calling via Chat service
5. Response formatting for Telegram (Markdown)

### Phase 4: External Agents (3-4 hours)

1. Create `external_agents` table + migrations
2. Create `ExternalAgentService`
3. Register LattePanda as external agent
4. Receive reports from external agents
5. Forward alerts to user

### Phase 5: Proactive Behaviors (2-3 hours)

1. Create `ProactiveEngine`
2. Migrate morning/evening briefings
3. Integrate reminder notifications
4. Add configurable schedules

### Phase 6: Polish (2-3 hours)

1. Inline keyboards for confirmations
2. Photo support (receipts, documents)
3. Voice message transcription (optional)
4. Error handling + graceful degradation

---

## Commands Reference

| Command | Description |
|---------|-------------|
| `/status` | System health + pending items |
| `/morning` | Morning briefing |
| `/evening` | Evening summary |
| `/tasks [filter]` | List tasks |
| `/task <title>` | Quick add task |
| `/remind <text> in <time>` | Quick reminder |
| `/contacts [search]` | Search CRM |
| `/shopping` | Active shopping lists |
| `/home` | Home status (maintenance, incidents) |
| `/agents` | List registered agents |
| `/run <agent> [goal]` | Manually run an agent |

Natural language also works: "Recordame comprar leche manana" → creates reminder.

---

## Security Considerations

1. **Whitelist-only access** - Only specific Telegram user IDs can interact
2. **No secrets in messages** - Sensitive data stays in local DB
3. **Rate limiting** - Prevent abuse even from whitelisted users
4. **Audit log** - All interactions logged in `agent_messages`
5. **Graceful degradation** - If Telegram unreachable, queue messages

---

## Dependencies to Add

```json
{
  "grammy": "^1.25.0",
  "@grammyjs/parse-mode": "^1.10.0"
}
```

---

## Environment Variables

```bash
# Telegram
TELEGRAM_BOT_TOKEN=...              # From @BotFather
TELEGRAM_ALLOWED_USERS=123,456      # Comma-separated user IDs
TELEGRAM_DEFAULT_CHAT=123           # Chat ID for proactive messages
TELEGRAM_ENABLED=true
```

---

## Estimated Total Effort

| Phase | Effort |
|-------|--------|
| Phase 1: Telegram Transport | 3-4 hours |
| Phase 2: Unified Notifier | 2 hours |
| Phase 3: Orchestrator | 4-5 hours |
| Phase 4: External Agents | 3-4 hours |
| Phase 5: Proactive | 2-3 hours |
| Phase 6: Polish | 2-3 hours |
| **Total** | **16-21 hours** |

---

## Future Extensions

1. **Voice commands** - Transcribe voice messages with Whisper
2. **Image analysis** - Process photos (receipts → shopping, documents → tasks)
3. **Location sharing** - Geofenced reminders
4. **Multi-user** - Family access with permissions
5. **Web dashboard + Telegram sync** - Same view, different interfaces
6. **MQTT bridge** - Direct sensor integration without intermediate bots
