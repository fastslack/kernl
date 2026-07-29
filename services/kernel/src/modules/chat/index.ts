import type {
  ExtensibleModule,
  DashboardDescriptor,
  ModuleContext,
  ToolDefinition,
} from "../../core/types.js";
import { runMigrations } from "../../core/db/migrations.js";
import { chatMigrations } from "./migrations/001_chat.js";
import { ChatService } from "./service.js";
import { chatTools } from "./tools.js";
import { queryChat } from "./dashboard-queries.js";
import { registerChatRoutes } from "./api-routes.js";
import { chatDashboardRpcActions } from "./dashboard-rpc-actions.js";
import { MemoryDistiller } from "./memory-distiller.js";
import { llm as getLlmClient } from "../../core/llm/client.js";
import { log } from "../../core/logger.js";
import type { EventBus } from "../../core/event-bus.js";
import type { SqliteDb } from "../../core/db/sqlite.js";

export interface ChatModule extends ExtensibleModule {
  getService(): ChatService | null;
  getDistiller(): MemoryDistiller | null;
  /**
   * Wire the memory distiller. Called from bootstrap AFTER the global LLM
   * client is set (the distiller depends on it). Returns true on success,
   * false when the LLM client isn't reachable yet — boot can proceed
   * either way; recall just stays off until next restart.
   */
  wireDistiller(): boolean;
}

export function createChatModule(): ChatModule {
  let tools: ToolDefinition[] = [];
  let chatService: ChatService | null = null;
  let distiller: MemoryDistiller | null = null;
  let eventsRef: EventBus | null = null;
  let sqliteRef: SqliteDb | null = null;

  return {
    name: "chat",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "chat", chatMigrations);

      chatService = new ChatService(
        ctx.sqlite,
        () => ctx.graph,
        ctx.events,
        ctx.config,
      );
      eventsRef = ctx.events;
      sqliteRef = ctx.sqlite;

      // Create Neo4j constraints and vector indexes
      await chatService.getKnowledgeService().createConstraintsAndIndexes();

      // Distiller cannot be created here: it needs `globalThis.__llm` which
      // bootstrap() sets AFTER initializeAll(). Bootstrap calls
      // `wireDistiller()` (below) once the LLM client is ready. Until then
      // the chat works fine, just without recall.

      tools = chatTools(chatService);

      // ARCH 3D beam bridge — chat-originated contact interactions
      // (message extraction) → cross-module beam from chat to crm. The
      // comms module forwards the email-originated half.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.events.on("contact.interaction" as any, (p: any) => {
        if (p?.type !== "message") return;
        ctx.events.emit("arch.cross_module", {
          source: "chat",
          target: "crm",
          label: `contact: ${p?.contactName ?? ""}`,
        }).catch(() => {});
      });
    },

    wireDistiller() {
      if (!chatService || !sqliteRef || !eventsRef) {
        log.warn("chat.wireDistiller: service not fully initialized");
        return false;
      }
      if (distiller) return true; // idempotent
      try {
        const llm = getLlmClient();
        distiller = new MemoryDistiller(sqliteRef, eventsRef, llm);
        distiller.attach();
        // Closes the loop between session-end distillation and runtime
        // recall — every chat turn now injects top-N durable facts into
        // the system prompt via service.systemParts.
        chatService.setDistiller(distiller);
        log.info("Chat: memory distiller wired (session-end recall enabled)");
        return true;
      } catch (err) {
        log.warn(`chat.wireDistiller: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    },

    getTools() {
      return tools;
    },

    getService() {
      return chatService;
    },

    getDistiller() {
      return distiller;
    },

    getDashboardRpcActions() {
      return chatService ? chatDashboardRpcActions({ chatService }) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        nav: [
          { id: "chat", label: "Chat", icon: "\uD83D\uDCAC", group: "people", order: 40 },
        ],
        channels: [
          { name: "chat", query: (db) => queryChat(db) },
        ],
        channelMappings: [
          { moduleKey: "chat", channels: ["chat"] },
        ],
        stores: ["chat"],
        fetchEndpoints: [
          { url: "/api/dashboard/chat", store: "chat" },
        ],
        registerRoutes: (server) => {
          if (chatService && eventsRef) {
            registerChatRoutes(server, chatService, eventsRef, distiller);
          }
        },
      };
    },

    async shutdown() {},
  };
}
