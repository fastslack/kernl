/**
 * Memory distiller — extracts 5–15 durable facts from an archived chat
 * session and persists them to `chat_distilled_facts`.
 *
 * Inspired by aiden's session-end memory distillation. Idea: most of a
 * conversation is ephemeral (greetings, clarifications, false starts), but
 * a small set of facts/decisions/preferences survive and should be
 * recalled in future sessions. We ask the LLM to pick those out and store
 * them keyed to the episode for later retrieval.
 *
 * Fires on `chat.session_stop` (emitted by `archiveEpisode`). Soft-fails:
 * if the LLM call errors or returns junk, we log and skip — the archive
 * itself is unaffected.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EventBus } from "../../core/event-bus.js";
import type { LlmClient } from "../../core/llm/client.js";
import type { ChatSessionStopPayload } from "../../core/kernel-events.js";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";

export interface DistilledFact {
  id: string;
  episode_id: string;
  category: string;
  fact: string;
  confidence: number;
  created_at: string;
}

const DISTILLATION_SYSTEM = `You distill chat sessions into a small set of durable facts.

Output ONLY a JSON array of {category, fact, confidence} objects. Categories: fact, preference, plan, decision, contact. Each fact:
- one short sentence (max 200 chars)
- self-contained (re-readable in 6 months without the surrounding chat)
- non-trivial (skip greetings, clarifications, transient state)
- confidence in [0,1]

Aim for 5–15 facts. If the conversation has nothing durable worth remembering, return [].
Do NOT wrap in markdown, do NOT add commentary.`;

const DISTILLATION_USER_TEMPLATE = (transcript: string): string =>
  `Distill this chat session.\n\n--- transcript ---\n${transcript}\n--- end transcript ---`;

export class MemoryDistiller {
  /** Minimum messages an episode needs before it's worth distilling. Below this we skip. */
  private static readonly MIN_MESSAGES = 4;
  /** Maximum facts to persist per session — defends against runaway LLM output. */
  private static readonly MAX_FACTS = 25;

  constructor(
    private db: SqliteDb,
    private events: EventBus,
    private llm: LlmClient,
  ) {}

  /** Wire the listener. Idempotent — calling twice does NOT double-listen. */
  attach(): void {
    this.events.on("chat.session_stop", async (payload) => {
      try {
        await this.handleSessionStop(payload);
      } catch (err) {
        log.warn(`MemoryDistiller failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, { module: "chat", description: "Distill durable facts from session transcript" });
  }

  /** Extract + persist facts. Public for tests. Returns the inserted rows. */
  async handleSessionStop(payload: ChatSessionStopPayload): Promise<DistilledFact[]> {
    if (payload.messageCount < MemoryDistiller.MIN_MESSAGES) return [];
    if (!payload.transcript || payload.transcript.trim().length < 200) return [];

    let raw: string;
    try {
      const result = await this.llm.chat({
        system: DISTILLATION_SYSTEM,
        user: DISTILLATION_USER_TEMPLATE(payload.transcript),
        maxTokens: 1024,
        temperature: 0.2,
        json: true,
      });
      raw = result.text ?? "";
    } catch (err) {
      log.debug(`Distiller LLM call failed for episode ${payload.episodeId}: ${err}`);
      return [];
    }

    const cleaned = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      log.warn(`Distiller: episode ${payload.episodeId} returned non-JSON, skipping`);
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const now = isoNow();
    const out: DistilledFact[] = [];
    const insert = this.db.prepare(
      `INSERT INTO chat_distilled_facts
       (id, episode_id, category, fact, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const trx = this.db.transaction((items: DistilledFact[]) => {
      for (const f of items) {
        insert.run(f.id, f.episode_id, f.category, f.fact, f.confidence, f.created_at);
      }
    });

    for (const item of parsed.slice(0, MemoryDistiller.MAX_FACTS)) {
      if (!item || typeof item !== "object") continue;
      const factText = String((item as { fact?: unknown }).fact ?? "").trim().slice(0, 200);
      if (factText.length < 4) continue;
      const category = String((item as { category?: unknown }).category ?? "fact").trim().slice(0, 32) || "fact";
      let confidence = Number((item as { confidence?: unknown }).confidence ?? 0.5);
      if (!Number.isFinite(confidence)) confidence = 0.5;
      confidence = Math.max(0, Math.min(1, confidence));
      out.push({
        id: newId(),
        episode_id: payload.episodeId,
        category,
        fact: factText,
        confidence,
        created_at: now,
      });
    }

    if (out.length === 0) return [];

    trx(out);
    log.info(
      `Distiller: episode ${payload.episodeId} → ${out.length} fact(s) persisted`,
    );
    this.events.emit("data.changed", {
      module: "chat",
      action: "distilled",
      count: out.length,
    }).catch(() => {});
    return out;
  }

  // ── Read API ─────────────────────────────────────────────────────────

  listForEpisode(episodeId: string): DistilledFact[] {
    return this.db
      .prepare(
        `SELECT id, episode_id, category, fact, confidence, created_at
         FROM chat_distilled_facts
         WHERE episode_id = ?
         ORDER BY confidence DESC, created_at ASC`,
      )
      .all(episodeId) as DistilledFact[];
  }

  /**
   * Search facts across all episodes — simple LIKE for now. The dashboard
   * uses this to surface "things Kernl remembers about you" by category.
   */
  search(category: string | null, limit = 50): DistilledFact[] {
    const where = category ? "WHERE category = ?" : "";
    const params = category ? [category, limit] : [limit];
    return this.db
      .prepare(
        `SELECT id, episode_id, category, fact, confidence, created_at
         FROM chat_distilled_facts
         ${where}
         ORDER BY confidence DESC, created_at DESC
         LIMIT ?`,
      )
      .all(...params) as DistilledFact[];
  }

  /**
   * Render the highest-confidence facts as a system-prompt fragment, grouped
   * by category. Returns an empty string when there are no facts so callers
   * can append unconditionally without empty-section noise.
   *
   * This is the bridge between session-end distillation and runtime recall —
   * `chat/service.ts` injects this string into the system prompt of every
   * new chat turn, which is what actually makes the memory useful (vs. just
   * sitting in SQLite for the dashboard to display).
   *
   * `limit` is the cap on how many facts are inlined. Default 12 keeps the
   * prompt overhead under ~600 tokens for typical fact lengths (~40 chars +
   * "- " bullet). Caller can lower it for token-tight contexts.
   *
   * Token cost rule of thumb: each fact ≈ 40-50 tokens including the bullet
   * and category header amortization. 12 facts ≈ 500 tokens worst case.
   */
  formatForPrompt(limit = 12): string {
    if (limit <= 0) return "";
    const facts = this.search(null, limit);
    if (facts.length === 0) return "";

    // Group by category so the model sees structure, not a wall of bullets.
    const byCategory = new Map<string, DistilledFact[]>();
    for (const f of facts) {
      const list = byCategory.get(f.category) ?? [];
      list.push(f);
      byCategory.set(f.category, list);
    }

    const sections: string[] = [];
    // Category order: highest count first, then alphabetical (stable across runs)
    const orderedCategories = [...byCategory.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

    for (const [category, items] of orderedCategories) {
      const lines = items
        .map(f => `- ${f.fact}`)
        .join("\n");
      sections.push(`### ${category}\n${lines}`);
    }

    return [
      "## What you remember about the user",
      "Durable facts distilled from past chat sessions. Use them to give grounded, personalized answers. Never repeat them back verbatim unless asked.",
      "",
      ...sections,
    ].join("\n");
  }
}
