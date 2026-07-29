import type { SqliteDb } from "./db/sqlite.js";
import type { Neo4jClient } from "./db/neo4j.js";
import type { GraphDriver } from "./db-drivers/graph-driver.js";
import type { ChatService } from "../modules/chat/service.js";
import type { Notifier } from "./notify/notifier.js";
import type { ToolDefinition } from "./types.js";
import type { InlineButton } from "./extension-seams.js";
import { log } from "./logger.js";
import {
  type OrchestratorResponse,
  type CommandDeps,
  getStatus,
  listTasks,
  quickAddTask,
  quickAddReminder,
  searchContacts,
  getShoppingLists,
  getHomeStatus,
  getMorningBriefing,
  getEveningSummary,
  getExternalAgents,
  getUnacknowledgedAlerts,
  acknowledgeAlert,
  searchTasksToComplete,
  completeTask,
  confirmCompleteTask,
  snoozeReminderCallback,
  dismissReminderCallback,
  formatForTelegram,
} from "../modules/agents/orchestrator-commands.js";

export type { OrchestratorResponse };

/** Context from a messaging platform */
export interface MessageContext {
  userId: number | string;
  chatId: number | string;
  platform: "telegram" | "mattermost" | "api" | "whatsapp" | "slack" | "discord" | "webchat" | "irc" | "signal" | "matrix";
  username?: string;
}

/** Slash command definition */
interface SlashCommand {
  pattern: RegExp;
  description: string;
  handler: (args: string[], ctx: MessageContext) => Promise<OrchestratorResponse>;
}

/**
 * Central orchestrator that routes messages to the right handler.
 * - Slash commands: Direct execution (handlers in orchestrator-commands.ts)
 * - Natural language: ChatService with tool-use
 */
export class Orchestrator {
  private userEpisodes: Map<string, string> = new Map();
  private commands: SlashCommand[] = [];
  private deps: CommandDeps;

  constructor(
    private db: SqliteDb,
    private neo4j: Neo4jClient,
    private getGraph: () => GraphDriver | null,
    private chatService: ChatService | null,
    private notifier: Notifier,
    private tools: ToolDefinition[],
  ) {
    this.deps = {
      db, neo4j, getGraph, notifier, tools, chatService,
      language: chatService?.getLanguage(),
    };
    this.registerCommands();
  }

  /** Process an incoming message */
  async handleMessage(text: string, ctx: MessageContext): Promise<OrchestratorResponse> {
    const trimmed = text.trim();
    if (trimmed.startsWith("/")) {
      return this.handleCommand(trimmed, ctx);
    }
    return this.handleChat(trimmed, ctx);
  }

  /** Process a callback query (inline button press) */
  async handleCallback(data: string, ctx: MessageContext): Promise<OrchestratorResponse> {
    log.debug(`Callback from ${ctx.userId}: ${data}`);
    const parts = data.split(":");
    const action = parts[0];
    const id = parts[1];

    try {
      switch (action) {
        case "ack_alert":
          return acknowledgeAlert(this.deps, id);
        case "done_task":
          return completeTask(this.deps, id);
        case "confirm_done":
          return confirmCompleteTask(this.deps, id);
        case "cancel_done":
          return { text: "Task completion cancelled." };
        case "snooze_reminder":
          return snoozeReminderCallback(this.deps, id, parts[2]);
        case "dismiss_reminder":
          return dismissReminderCallback(this.deps, id);
        default:
          return { text: `Unknown action: ${action}` };
      }
    } catch (err) {
      log.error(`Callback error: ${data}`, err);
      return { text: `Error: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  }

  // ── Slash Commands ─────────────────────────────────

  private registerCommands(): void {
    const d = this.deps;
    this.commands = [
      { pattern: /^\/start$/i, description: "Welcome message",
        handler: async (_args, ctx) => ({
          text: `👋 *Kernl* connected!\n\nYour user ID: \`${ctx.userId}\`\nChat ID: \`${ctx.chatId}\`\n\nUse /help to see available commands, or just send a message in natural language!`,
        }),
      },
      { pattern: /^\/help$/i, description: "Show available commands",
        handler: async () => ({ text: this.formatHelp() }),
      },
      { pattern: /^\/status$/i, description: "System status",
        handler: async () => getStatus(d),
      },
      { pattern: /^\/tasks(?:\s+(.*))?$/i, description: "List tasks (optional: filter by status)",
        handler: async (args) => listTasks(d, args[0]),
      },
      { pattern: /^\/task\s+(.+)$/i, description: "Quick add task",
        handler: async (args) => quickAddTask(d, args[0]),
      },
      { pattern: /^\/remind\s+(.+)$/i, description: "Quick add reminder",
        handler: async (args) => quickAddReminder(d, args[0]),
      },
      { pattern: /^\/contacts(?:\s+(.*))?$/i, description: "Search contacts",
        handler: async (args) => searchContacts(d, args[0]),
      },
      { pattern: /^\/shopping$/i, description: "Active shopping lists",
        handler: async () => getShoppingLists(d),
      },
      { pattern: /^\/home$/i, description: "Home status summary",
        handler: async () => getHomeStatus(d),
      },
      { pattern: /^\/morning$/i, description: "Morning briefing",
        handler: async () => getMorningBriefing(d),
      },
      { pattern: /^\/evening$/i, description: "Evening summary",
        handler: async () => getEveningSummary(d),
      },
      { pattern: /^\/agents$/i, description: "External agents status",
        handler: async () => getExternalAgents(d),
      },
      { pattern: /^\/reset$/i, description: "Reset conversation",
        handler: async (_args, ctx) => this.resetConversation(ctx),
      },
      { pattern: /^\/alerts$/i, description: "View unacknowledged alerts",
        handler: async () => getUnacknowledgedAlerts(d),
      },
      { pattern: /^\/done(?:\s+(.+))?$/i, description: "Complete a task",
        handler: async (args) => searchTasksToComplete(d, args[0]),
      },
    ];
  }

  private async handleCommand(text: string, ctx: MessageContext): Promise<OrchestratorResponse> {
    for (const cmd of this.commands) {
      const match = text.match(cmd.pattern);
      if (match) {
        try {
          const args = match.slice(1).filter(Boolean);
          return await cmd.handler(args, ctx);
        } catch (err) {
          log.error(`Command error: ${text}`, err);
          return { text: `Error executing command: ${err instanceof Error ? err.message : "Unknown error"}` };
        }
      }
    }
    return { text: `Unknown command: ${text.split(" ")[0]}\n\nUse /help to see available commands.` };
  }

  // ── Natural Language Chat ───────────────────────────

  private async handleChat(text: string, ctx: MessageContext): Promise<OrchestratorResponse> {
    if (!this.chatService) {
      return { text: "Chat service not available. Use /help to see available commands." };
    }
    try {
      const episodeId = await this.getOrCreateEpisode(ctx);
      const response = await this.chatService.chat(episodeId, text, { skipExtraction: true });
      return { text: formatForTelegram(response.message.content), parseMode: "Markdown" };
    } catch (err) {
      log.error("Chat error", err);
      return { text: `Error processing message: ${err instanceof Error ? err.message : "Unknown error"}` };
    }
  }

  private getUserKey(ctx: MessageContext): string {
    return `${ctx.platform}:${ctx.userId}`;
  }

  private async getOrCreateEpisode(ctx: MessageContext): Promise<string> {
    const userKey = this.getUserKey(ctx);
    let episodeId = this.userEpisodes.get(userKey);
    if (episodeId) {
      const episode = this.chatService?.getEpisode(episodeId);
      if (episode && episode.status === "active") return episodeId;
    }
    const episode = this.chatService!.createEpisode({ title: `${ctx.platform} ${ctx.userId}` });
    this.userEpisodes.set(userKey, episode.id);
    return episode.id;
  }

  private async resetConversation(ctx: MessageContext): Promise<OrchestratorResponse> {
    const userKey = this.getUserKey(ctx);
    const oldEpisodeId = this.userEpisodes.get(userKey);
    if (oldEpisodeId && this.chatService) this.chatService.archiveEpisode(oldEpisodeId);
    this.userEpisodes.delete(userKey);
    return { text: "Conversation reset. Starting fresh!" };
  }

  private formatHelp(): string {
    const lines = ["📖 *Available Commands*\n"];
    for (const cmd of this.commands) {
      const cmdName = cmd.pattern.source
        .replace(/^\^/, "").replace(/\$$/i, "")
        .replace(/\(\?:\\s\+\(\.\+\)\)\?/g, " [args]")
        .replace(/\\s\+\(\.\+\)/g, " <text>")
        .replace(/\(\?:\\s\+\(\.\*\)\)\?/g, " [search]")
        .replace(/\\/g, "");
      lines.push(`${cmdName} — ${cmd.description}`);
    }
    lines.push("", "Or just send a message in natural language!");
    return lines.join("\n");
  }
}
