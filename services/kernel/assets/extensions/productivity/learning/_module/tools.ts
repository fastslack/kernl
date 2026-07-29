import { z } from "zod";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { LearningService } from "./service.js";

export function learningTools(svc: LearningService): ToolDefinition[] {
  return [
    // ── Resources ─────────────────────────────────────────────────────────────
    {
      name: "kernel_learning_add",
      description: "Add a book, article, course, paper, podcast or video to track",
      inputSchema: z.object({
        title: z.string(),
        type: z.enum(["book", "article", "course", "paper", "podcast", "video", "other"]).optional().default("book"),
        author: z.string().optional(),
        url: z.string().optional(),
        isbn: z.string().optional(),
        source: z.string().optional().describe("e.g. Audible, Coursera, arXiv"),
        status: z.enum(["wishlist", "in_progress", "completed", "abandoned", "paused"]).optional().default("wishlist"),
        priority: z.enum(["low", "medium", "high"]).optional().default("medium"),
        total_pages: z.number().optional(),
        total_hours: z.number().optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        try {
          const r = svc.addResource(args as any);
          return textResult(`Added to learning list: **${r.title}** (${r.type}) — status: ${r.status}`);
        } catch (e) {
          return errorResult(String(e));
        }
      },
    },
    {
      name: "kernel_learning_update",
      description: "Update progress or status of a learning resource",
      inputSchema: z.object({
        id: z.string(),
        status: z.enum(["wishlist", "in_progress", "completed", "abandoned", "paused"]).optional(),
        current_page: z.number().optional(),
        spent_hours: z.number().optional(),
        rating: z.number().min(1).max(5).optional(),
        notes: z.string().optional(),
        summary: z.string().optional(),
        tags: z.array(z.string()).optional(),
        started_at: z.string().optional(),
        completed_at: z.string().optional(),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as { id: string; [key: string]: unknown };
        const r = svc.updateResource(id, changes as any);
        if (!r) return errorResult("Resource not found");
        return textResult(`Updated: **${r.title}** — status: ${r.status}`);
      },
    },
    {
      name: "kernel_learning_list",
      description: "List learning resources with optional filters",
      inputSchema: z.object({
        type: z.enum(["book", "article", "course", "paper", "podcast", "video", "other"]).optional(),
        status: z.enum(["wishlist", "in_progress", "completed", "abandoned", "paused"]).optional(),
        search: z.string().optional(),
        limit: z.number().optional().default(50),
      }),
      handler: async (args) => {
        const resources = svc.listResources(args as any);
        if (!resources.length) return textResult("No learning resources found.");
        const lines = resources.map(r => {
          const progress = r.total_pages > 0
            ? ` (${r.current_page}/${r.total_pages} pages)`
            : r.total_hours > 0 ? ` (${r.spent_hours}/${r.total_hours}h)` : "";
          return `- **${r.title}** by ${r.author || "—"} [${r.type}] [${r.status}]${progress}`;
        });
        return textResult(`## Learning Resources (${resources.length})\n${lines.join("\n")}`);
      },
    },
    {
      name: "kernel_learning_current",
      description: "Get currently in-progress learning resources",
      inputSchema: z.object({}),
      handler: async () => {
        const resources = svc.getCurrentlyReading();
        if (!resources.length) return textResult("Nothing currently in progress.");
        const lines = resources.map(r => {
          const progress = r.total_pages > 0
            ? ` — page ${r.current_page}/${r.total_pages} (${Math.round(r.current_page / r.total_pages * 100)}%)`
            : r.total_hours > 0 ? ` — ${r.spent_hours}/${r.total_hours}h` : "";
          return `- **${r.title}** [${r.type}]${progress}`;
        });
        return textResult(`## Currently Learning\n${lines.join("\n")}`);
      },
    },
    {
      name: "kernel_learning_stats",
      description: "Get learning statistics (totals, due flashcards, highlights)",
      inputSchema: z.object({}),
      handler: async () => {
        const stats = svc.getStats();
        const statusLines = Object.entries(stats.by_status).map(([k, v]) => `  - ${k}: ${v}`);
        const typeLines = Object.entries(stats.by_type).map(([k, v]) => `  - ${k}: ${v}`);
        return textResult([
          `## Learning Stats`,
          `- Total resources: ${stats.total}`,
          `- Flashcards due: ${stats.due_cards} (across ${stats.decks} decks)`,
          `- Highlights: ${stats.highlights}`,
          `\n**By Status:**\n${statusLines.join("\n")}`,
          `\n**By Type:**\n${typeLines.join("\n")}`,
        ].join("\n"));
      },
    },

    // ── Highlights ─────────────────────────────────────────────────────────────
    {
      name: "kernel_learning_add_highlight",
      description: "Save a highlight, note, or quote from a resource",
      inputSchema: z.object({
        resource_id: z.string(),
        content: z.string(),
        location: z.string().optional().describe("Page number, chapter, or timestamp"),
        type: z.enum(["highlight", "note", "quote", "action_item", "question"]).optional().default("highlight"),
      }),
      handler: async (args) => {
        try {
          const h = svc.addHighlight(args as any);
          return textResult(`Highlight saved (${h.type})${h.location ? ` at ${h.location}` : ""}`);
        } catch (e) {
          return errorResult(String(e));
        }
      },
    },
    {
      name: "kernel_learning_highlights",
      description: "List all highlights/notes for a resource",
      inputSchema: z.object({ resource_id: z.string() }),
      handler: async (args) => {
        const { resource_id } = args as { resource_id: string };
        const highlights = svc.listHighlights(resource_id);
        if (!highlights.length) return textResult("No highlights yet.");
        const lines = highlights.map(h =>
          `[${h.type}${h.location ? ` @${h.location}` : ""}] ${h.content}`
        );
        return textResult(`## Highlights (${highlights.length})\n${lines.join("\n\n")}`);
      },
    },

    // ── Flashcards ─────────────────────────────────────────────────────────────
    {
      name: "kernel_learning_add_card",
      description: "Add a flashcard for spaced repetition review",
      inputSchema: z.object({
        front: z.string().describe("Question or front of card"),
        back: z.string().describe("Answer or back of card"),
        deck: z.string().optional().default("general"),
        resource_id: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
      handler: async (args) => {
        try {
          const card = svc.addFlashcard(args as any);
          return textResult(`Flashcard added to deck **${card.deck}** — due: ${card.next_review}`);
        } catch (e) {
          return errorResult(String(e));
        }
      },
    },
    {
      name: "kernel_learning_due_cards",
      description: "Get flashcards due for review today",
      inputSchema: z.object({
        deck: z.string().optional(),
        limit: z.number().optional().default(20),
      }),
      handler: async (args) => {
        const { deck, limit } = args as { deck?: string; limit?: number };
        const cards = svc.getDueCards(deck, limit ?? 20);
        if (!cards.length) return textResult("No cards due for review!");
        const lines = cards.map(c =>
          `[${c.deck}] **Q**: ${c.front}\n  **A**: ${c.back} (rep: ${c.repetitions}, interval: ${c.interval_days}d)`
        );
        return textResult(`## Due Cards (${cards.length})\n${lines.join("\n\n")}`);
      },
    },
    {
      name: "kernel_learning_review_card",
      description: "Review a flashcard with a quality score (SM-2 spaced repetition)",
      inputSchema: z.object({
        card_id: z.string(),
        quality: z.number().min(0).max(5).describe("0=blackout, 1=wrong, 2=wrong but familiar, 3=correct with effort, 4=correct, 5=perfect"),
      }),
      handler: async (args) => {
        const { card_id, quality } = args as { card_id: string; quality: number };
        const card = svc.reviewCard(card_id, quality);
        if (!card) return errorResult("Card not found");
        return textResult(
          `Card reviewed (quality: ${quality}/5)\n- Next review: **${card.next_review}** (in ${card.interval_days} days)\n- Ease factor: ${card.ease_factor.toFixed(2)}`
        );
      },
    },
    {
      name: "kernel_learning_decks",
      description: "List flashcard decks with due card counts",
      inputSchema: z.object({}),
      handler: async () => {
        const decks = svc.listDecks();
        if (!decks.length) return textResult("No flashcard decks yet.");
        const lines = decks.map(d => `- **${d.deck}**: ${d.total} cards, ${d.due} due`);
        return textResult(`## Flashcard Decks\n${lines.join("\n")}`);
      },
    },

    // ── Goals ─────────────────────────────────────────────────────────────────
    {
      name: "kernel_learning_add_goal",
      description: "Add a learning goal or curriculum",
      inputSchema: z.object({
        title: z.string(),
        description: z.string().optional(),
        target_date: z.string().optional(),
      }),
      handler: async (args) => {
        try {
          const goal = svc.addGoal(args as any);
          return textResult(`Learning goal added: **${goal.title}** (\`${goal.id}\`)`);
        } catch (e) {
          return errorResult(String(e));
        }
      },
    },
    {
      name: "kernel_learning_goals",
      description: "List all learning goals",
      inputSchema: z.object({}),
      handler: async () => {
        const goals = svc.listGoals();
        if (!goals.length) return textResult("No learning goals set.");
        const lines = goals.map(g =>
          `- **${g.title}** [${g.status}]${g.target_date ? ` — target: ${g.target_date}` : ""}`
        );
        return textResult(`## Learning Goals\n${lines.join("\n")}`);
      },
    },
    {
      name: "kernel_learning_add_to_goal",
      description: "Add a resource to a learning goal",
      inputSchema: z.object({
        goal_id: z.string(),
        resource_id: z.string(),
        order: z.number().optional().default(0),
      }),
      handler: async (args) => {
        const { goal_id, resource_id, order } = args as { goal_id: string; resource_id: string; order?: number };
        try {
          svc.addResourceToGoal(goal_id, resource_id, order);
          return textResult(`Resource added to goal.`);
        } catch (e) {
          return errorResult(String(e));
        }
      },
    },
  ];
}
