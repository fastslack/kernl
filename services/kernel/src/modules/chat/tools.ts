import { z } from "zod";
import type { ToolDefinition } from "../../core/types.js";
import type { ChatService } from "./service.js";
import { textResult, errorResult } from "../../core/helpers.js";
import { defineTool, defineToolNoInput } from "../../core/tool-builder.js";

export function chatTools(service: ChatService): ToolDefinition[] {
  return [
    // ── kernel_chat_start ──────────────────────────
    defineTool({
      name: "kernel_chat_start",
      description:
        "Start a new chat episode (conversation). Returns the episode ID to use with kernel_chat_message.",
      schema: z.object({
        title: z.string().optional().describe("Optional title for the episode"),
        provider: z
          .string()
          .optional()
          .describe("LLM provider: claude, openai, lmstudio (default from config)"),
        model: z
          .string()
          .optional()
          .describe("Specific model override (e.g. claude-sonnet-4-20250514)"),
      }),
      handler: async (input) => {
        const episode = service.createEpisode(input);
        return textResult(
          [
            `Episode started:`,
            `  ID: ${episode.id}`,
            `  Provider: ${episode.llm_provider}`,
            episode.llm_model ? `  Model: ${episode.llm_model}` : null,
            episode.title ? `  Title: ${episode.title}` : null,
            ``,
            `Use kernel_chat_message with this episode_id to chat.`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    }),

    // ── kernel_chat_message ────────────────────────
    defineTool({
      name: "kernel_chat_message",
      description:
        "Send a message in a chat episode and receive the LLM response. The system automatically retrieves relevant context from memory (when available).",
      schema: z.object({
        episode_id: z.string().describe("Episode ID from kernel_chat_start"),
        message: z.string().describe("The user message to send"),
        context_budget: z
          .number()
          .optional()
          .describe("Max tokens for context injection (default from config)"),
      }),
      handler: async (input) => {
        const { episode_id, message, context_budget } = input;

        const response = await service.chat(episode_id, message, {
          contextBudget: context_budget,
        });

        const lines = [response.message.content];
        if (response.tokens_used > 0) {
          lines.push(
            `\n---\n_Tokens: ${response.tokens_used} | Context: ${response.context_summary}_`,
          );
        }
        return textResult(lines.join(""));
      },
    }),

    // ── kernel_chat_history ────────────────────────
    defineTool({
      name: "kernel_chat_history",
      description: "Get message history for a chat episode.",
      schema: z.object({
        episode_id: z.string().describe("Episode ID"),
        limit: z
          .number()
          .optional()
          .describe("Max messages to return (default: all)"),
        offset: z.number().optional().describe("Skip first N messages"),
      }),
      handler: async (input) => {
        const { episode_id, limit, offset } = input;

        const messages = service.getMessages(episode_id, limit, offset);
        if (messages.length === 0) {
          return textResult("No messages in this episode.");
        }

        const lines = messages.map((m) => {
          const role = m.role.toUpperCase();
          const preview =
            m.content.length > 200
              ? m.content.slice(0, 197) + "..."
              : m.content;
          return `[${role}] ${m.created_at}\n${preview}`;
        });

        return textResult(
          `Messages (${messages.length}):\n\n${lines.join("\n\n")}`,
        );
      },
    }),

    // ── kernel_chat_list ───────────────────────────
    defineTool({
      name: "kernel_chat_list",
      description: "List chat episodes, optionally filtered by status.",
      schema: z.object({
        status: z
          .enum(["active", "archived"])
          .optional()
          .describe("Filter by status"),
        limit: z
          .number()
          .optional()
          .describe("Max episodes to return (default: 20)"),
      }),
      handler: async (input) => {
        const { status, limit } = input;

        const episodes = service.listEpisodes({
          status,
          limit: limit || 20,
        });

        if (episodes.length === 0) {
          return textResult("No episodes found.");
        }

        const lines = episodes.map((e) => {
          const title = e.title || "(untitled)";
          return [
            `- **${title}** [${e.status}]`,
            `  ID: ${e.id}`,
            `  Messages: ${e.message_count} | Tokens: ${e.total_tokens} | Provider: ${e.llm_provider}`,
            `  Updated: ${e.updated_at}`,
          ].join("\n");
        });

        return textResult(`Episodes (${episodes.length}):\n\n${lines.join("\n\n")}`);
      },
    }),

    // ── kernel_chat_archive ────────────────────────
    defineTool({
      name: "kernel_chat_archive",
      description:
        "Archive a chat episode. In future phases, this also generates a summary embedding.",
      schema: z.object({
        episode_id: z.string().describe("Episode ID to archive"),
      }),
      handler: async (input) => {
        const { episode_id } = input;
        const episode = service.archiveEpisode(episode_id);
        if (!episode) return errorResult(`Episode not found: ${episode_id}`);
        return textResult(
          `Episode archived: ${episode.title || episode.id}\nMessages: ${episode.message_count}`,
        );
      },
    }),

    // ── kernel_chat_search ─────────────────────────
    defineTool({
      name: "kernel_chat_search",
      description:
        "Full-text search across all chat messages. Returns matching messages with their episode context.",
      schema: z.object({
        query: z
          .string()
          .describe("Search query (FTS5 syntax supported)"),
        limit: z
          .number()
          .optional()
          .describe("Max results (default: 20)"),
      }),
      handler: async (input) => {
        const { query, limit } = input;

        const messages = service.searchMessages(query, limit || 20);
        if (messages.length === 0) {
          return textResult(`No messages found for: "${query}"`);
        }

        const lines = messages.map((m) => {
          const preview =
            m.content.length > 150
              ? m.content.slice(0, 147) + "..."
              : m.content;
          return `[${m.role}] Episode: ${m.episode_id}\n${m.created_at}\n${preview}`;
        });

        return textResult(
          `Search results (${messages.length}):\n\n${lines.join("\n\n")}`,
        );
      },
    }),

    // ── kernel_chat_recall ─────────────────────────
    defineTool({
      name: "kernel_chat_recall",
      description:
        "Reinforce a memory node manually, boosting its strength against decay. Use this to mark a memory as important.",
      schema: z.object({
        memory_id: z.string().describe("Memory node ID (same as message ID)"),
      }),
      handler: async (input) => {
        const { memory_id } = input;
        const ok = await service.reinforceMemory(memory_id);
        if (!ok) {
          return errorResult(
            "Memory reinforcement unavailable (Neo4j not connected)",
          );
        }
        return textResult(`Memory reinforced: ${memory_id}`);
      },
    }),

    // ── kernel_chat_context ────────────────────────
    defineTool({
      name: "kernel_chat_context",
      description:
        "Preview the cognitive context that would be retrieved for a query. Useful for debugging the retrieval pipeline.",
      schema: z.object({
        query: z.string().describe("The query to retrieve context for"),
        episode_id: z
          .string()
          .optional()
          .describe("Episode ID for current-episode boost (optional)"),
        budget: z
          .number()
          .optional()
          .describe("Max context tokens (default from config)"),
      }),
      handler: async (input) => {
        const { query, episode_id, budget } = input;

        const ctx = await service.previewContext(
          query,
          episode_id || "",
          budget,
        );

        const lines = [
          `**Context Retrieval Preview**`,
          `Method: ${ctx.method}`,
          `Memories: ${ctx.memories.length}`,
          `People: ${ctx.traversal.persons.length}`,
          `Tasks: ${ctx.traversal.tasks.length}`,
          `Concepts: ${ctx.concepts.length}`,
          `Patterns: ${ctx.patterns.length}`,
          `Tokens: ${ctx.totalTokens}`,
          ``,
        ];

        if (ctx.contextText) {
          lines.push("---", ctx.contextText);
        } else {
          lines.push("_No context retrieved._");
        }

        return textResult(lines.join("\n"));
      },
    }),

    // ── kernel_chat_concepts ───────────────────────
    defineTool({
      name: "kernel_chat_concepts",
      description:
        "List extracted concepts from chat conversations, ordered by gravity (cross-conversation importance).",
      schema: z.object({
        min_gravity: z
          .number()
          .optional()
          .describe("Minimum gravity threshold (default: 0)"),
        limit: z
          .number()
          .optional()
          .describe("Max concepts to return (default: 50)"),
      }),
      handler: async (input) => {
        const { min_gravity, limit } = input;

        const ks = service.getKnowledgeService();
        const concepts = await ks.getConcepts(min_gravity || 0, limit || 50);

        if (concepts.length === 0) {
          return textResult(
            "No concepts found. Chat conversations will build the concept graph over time.",
          );
        }

        const lines = concepts.map(
          (c) =>
            `- **${c.label}** — gravity: ${c.gravity.toFixed(1)}, mentions: ${c.mention_count}, last: ${c.last_seen}`,
        );

        return textResult(
          `Concepts (${concepts.length}):\n\n${lines.join("\n")}`,
        );
      },
    }),

    // ── kernel_chat_analyze ────────────────────────
    defineToolNoInput({
      name: "kernel_chat_analyze",
      description:
        "Run analytics on the concept graph. Shows top concepts by importance and community structure.",
      handler: async () => {
        const ks = service.getKnowledgeService();
        if (!ks.available) {
          return errorResult(
            "Concept analytics requires Neo4j to be connected.",
          );
        }

        const analytics = await ks.runConceptAnalytics();
        const lines = [
          `**Concept Graph Analytics**`,
          `Connected groups: ${analytics.communities}`,
          ``,
          `**Top Concepts:**`,
        ];

        for (const c of analytics.topConcepts) {
          lines.push(
            `- ${c.label} (gravity: ${c.gravity.toFixed(1)}, mentions: ${c.mention_count})`,
          );
        }

        return textResult(lines.join("\n"));
      },
    }),

    // ── kernel_chat_patterns ───────────────────────
    defineToolNoInput({
      name: "kernel_chat_patterns",
      description:
        "View detected temporal and behavioral patterns from chat conversations.",
      handler: async () => {
        const ks = service.getKnowledgeService();
        if (!ks.available) {
          return errorResult(
            "Pattern detection requires Neo4j to be connected.",
          );
        }

        const now = new Date();
        const patterns = await ks.getTemporalPatterns(
          now.getHours(),
          now.getDay(),
        );

        if (patterns.length === 0) {
          return textResult(
            "No patterns detected yet. The system learns patterns as you chat over time.",
          );
        }

        const lines = patterns.map(
          (p) =>
            `- [${p.type}] ${p.description} (confidence: ${p.confidence.toFixed(2)}, hour: ${p.hour_of_day ?? "any"}, day: ${p.day_of_week ?? "any"})`,
        );

        return textResult(
          `Detected Patterns (${patterns.length}):\n\n${lines.join("\n")}`,
        );
      },
    }),
  ];
}
