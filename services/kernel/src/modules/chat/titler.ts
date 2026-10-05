/**
 * Names a conversation after what it is about.
 *
 * The first exchange gets autoTitle's 60-char cut at once (so the sidebar is
 * never blank), then this asks the LLM for a 3–6 word subject and replaces
 * it. It asks again at the sixth message, because chats that open with a
 * greeting only reveal their subject later. Only titles the system wrote
 * (`title_auto = 1`) are ever replaced, and a failed call leaves the cut.
 */
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EventBus } from "../../core/event-bus.js";
import type { LlmClient } from "../../core/llm/client.js";
import { log } from "../../core/logger.js";

/** Message counts (after the turn) at which a title is (re)generated. */
export const TITLE_AT = [2, 6] as const;

const SYSTEM = `You name chat conversations. Reply with ONLY a title of 3 to 6 words that says what the conversation is about — its subject, not the greeting. Use the language of the conversation. No quotes, no trailing period, no emoji, no prefix like "Title:".`;

/** Per-message cut so a pasted log can't blow up a call that only needs the gist. */
const MESSAGE_CHARS = 600;
const MAX_MESSAGES = 6;
const MAX_TITLE = 80;

export class ChatTitler {
  private inFlight = new Set<string>();

  constructor(
    private db: SqliteDb,
    private events: EventBus,
    private llm: () => LlmClient,
    private model: string = "",
  ) {}

  /** Fire-and-forget entry point for the chat turn. */
  request(episodeId: string): void {
    this.generate(episodeId).catch((err) =>
      log.debug(`chat.titler: ${episodeId}: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  /** Generate and store a title. Returns it, or null when nothing changed. */
  async generate(episodeId: string): Promise<string | null> {
    if (this.inFlight.has(episodeId)) return null;
    this.inFlight.add(episodeId);
    try {
      const rows = this.db
        .prepare(
          `SELECT role, content FROM chat_messages
           WHERE episode_id = ? AND role IN ('user','assistant')
           ORDER BY created_at LIMIT ?`,
        )
        .all(episodeId, MAX_MESSAGES) as Array<{ role: string; content: string }>;
      if (!rows.some((r) => r.role === "user")) return null;

      const transcript = rows
        .map((r) => `${r.role === "user" ? "User" : "Assistant"}: ${plain(r.content).slice(0, MESSAGE_CHARS)}`)
        .join("\n\n");
      const res = await this.llm().chat({
        system: SYSTEM,
        user: transcript,
        maxTokens: 40,
        temperature: 0.3,
        caller: "chat.title",
        ...(this.model ? { model: this.model } : {}),
      });
      const title = cleanTitle(res.text ?? "");
      if (!title) return null;

      // Re-checked at write time: the user may have renamed it meanwhile.
      const r = this.db
        .prepare("UPDATE chat_episodes SET title = ?, titled_at_count = message_count WHERE id = ? AND title_auto = 1")
        .run(title, episodeId);
      if (r.changes === 0) return null;
      this.events.emit("data.changed", { module: "chat", action: "episode_titled" });
      return title;
    } finally {
      this.inFlight.delete(episodeId);
    }
  }

  /**
   * Titles conversations that predate this: every auto-titled episode with a
   * full exchange that never got an LLM title. One at a time, so a boot with
   * a long history doesn't burst the provider.
   */
  async backfill(): Promise<number> {
    const ids = (
      this.db
        .prepare(
          `SELECT id FROM chat_episodes
           WHERE title_auto = 1 AND titled_at_count = 0 AND message_count >= 2
           ORDER BY updated_at DESC`,
        )
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    let done = 0;
    for (const id of ids) {
      try {
        if (await this.generate(id)) done++;
      } catch (err) {
        log.debug(`chat.titler backfill ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Marked either way: a chat the LLM can't name shouldn't be retried every boot.
      this.db.prepare("UPDATE chat_episodes SET titled_at_count = message_count WHERE id = ?").run(id);
    }
    if (ids.length) log.info(`chat.titler: backfilled ${done}/${ids.length} titles`);
    return done;
  }
}

/** Attachment envelopes store the text under `text`. */
function plain(raw: string): string {
  if (!raw.startsWith("{")) return raw;
  try {
    const p = JSON.parse(raw);
    return typeof p?.text === "string" ? p.text : raw;
  } catch {
    return raw;
  }
}

export function cleanTitle(raw: string): string {
  let t = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  t = t.replace(/^(title|título)\s*:\s*/i, "");
  // Wrapping quotes, bold markers and a closing period come in any order ('"X".', '"X."').
  t = t.replace(/^["'“”«»`*\s]+|["'“”«»`*.。\s]+$/g, "").trim();
  if (t.length > MAX_TITLE) t = t.slice(0, MAX_TITLE - 3).trimEnd() + "...";
  return t;
}
