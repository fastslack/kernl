import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { EventBus } from "../../../core/event-bus.js";
import { newId, isoNow } from "../../../core/helpers.js";
import type {
  AgentConversation,
  AgentMessage,
  AgentMessageRole,
  AgentDebateCooldown,
} from "../types.js";

const TOPIC_STOPWORDS = new Set<string>([
  "the", "and", "for", "are", "but", "not", "you", "with", "this", "that",
  "from", "have", "has", "was", "were", "been", "being", "will", "shall",
  "should", "could", "would", "can", "may", "our", "your", "their", "they",
  "them", "there", "here", "into", "onto", "upon", "than", "then", "these",
  "those", "some", "any", "all", "who", "what", "when", "where", "why", "how",
  "para", "por", "con", "sin", "del", "los", "las", "una", "uno", "que", "como",
  "pero", "este", "esta", "esto", "esos", "esas", "cuando", "donde", "quien",
  "sobre", "entre", "desde", "hasta", "muy", "más", "menos",
]);

/**
 * Inter-agent threads: conversations, their messages, and the debate cooldown
 * register keyed on the same topic hash. Owns `agent_conversations`,
 * `agent_messages` and `agent_debate_cooldowns`; `AgentService` delegates to it.
 */
export class AgentConversationsService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
  ) {}

  /**
   * Normalise a free-form topic into a stable hash used to dedup conversations
   * and lock debate cooldowns. Keep it simple (lowercase + strip punctuation +
   * collapse whitespace + clip). Good enough until we bolt on embeddings.
   */
  static computeTopicHash(topic: string): string {
    const normalised = (topic || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 3 && !TOPIC_STOPWORDS.has(w))
      .slice(0, 16)
      .sort()
      .join("-");
    return normalised.slice(0, 200);
  }

  createConversation(input: {
    kind: "chat" | "meeting" | "debate";
    topic: string;
    participants: string[];
    initiator_agent_id: string;
    parent_conversation_id?: string;
    meta?: Record<string, unknown>;
  }): AgentConversation {
    const now = isoNow();
    const convo: AgentConversation = {
      id: newId(),
      kind: input.kind,
      topic: input.topic.slice(0, 500),
      topic_hash: AgentConversationsService.computeTopicHash(input.topic),
      participants: JSON.stringify([...new Set(input.participants)]),
      initiator_agent_id: input.initiator_agent_id,
      parent_conversation_id: input.parent_conversation_id ?? "",
      status: "open",
      meta: JSON.stringify(input.meta ?? {}),
      created_at: now,
      updated_at: now,
      closed_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO agent_conversations
          (id, kind, topic, topic_hash, participants, initiator_agent_id,
           parent_conversation_id, status, meta, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        convo.id, convo.kind, convo.topic, convo.topic_hash, convo.participants,
        convo.initiator_agent_id, convo.parent_conversation_id, convo.status,
        convo.meta, convo.created_at, convo.updated_at, convo.closed_at,
      );
    this.events.emit("agent:conversation:opened", {
      conversation_id: convo.id, kind: convo.kind, topic: convo.topic,
      participants: JSON.parse(convo.participants), initiator: convo.initiator_agent_id,
    });
    return convo;
  }

  getConversation(id: string): AgentConversation | undefined {
    if (!id) return undefined;
    return this.db
      .prepare("SELECT * FROM agent_conversations WHERE id = ?")
      .get(id) as AgentConversation | undefined;
  }

  /**
   * Find an open chat with the given participant set (order-insensitive) and
   * matching topic_hash. If none, create one. Used by postToColleague to keep
   * related back-and-forth mail in a single thread.
   */
  findOrCreateChatConversation(input: {
    topic: string;
    participants: string[];
    initiator_agent_id: string;
  }): AgentConversation {
    const hash = AgentConversationsService.computeTopicHash(input.topic);
    const participantsSorted = [...new Set(input.participants)].sort();
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_conversations
          WHERE kind = 'chat' AND status = 'open' AND topic_hash = ?
          ORDER BY created_at DESC
          LIMIT 20`,
      )
      .all(hash) as AgentConversation[];
    for (const row of rows) {
      const current = this.parseParticipants(row).slice().sort();
      if (current.length === participantsSorted.length &&
          current.every((id, i) => id === participantsSorted[i])) {
        return row;
      }
    }
    return this.createConversation({
      kind: "chat",
      topic: input.topic,
      participants: input.participants,
      initiator_agent_id: input.initiator_agent_id,
    });
  }

  listConversations(opts?: {
    agent_id?: string;
    kind?: "chat" | "meeting" | "debate";
    status?: "open" | "closed";
    /** Hide rows whose meta.archived is truthy. Default true so the dashboard
     *  doesn't keep re-surfacing meetings the user already dismissed. */
    excludeArchived?: boolean;
    limit?: number;
  }): AgentConversation[] {
    let sql = "SELECT * FROM agent_conversations WHERE 1=1";
    const params: unknown[] = [];
    if (opts?.kind) { sql += " AND kind = ?"; params.push(opts.kind); }
    if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts?.agent_id) {
      // participants is a JSON array of IDs — LIKE match is safe because IDs
      // are UUIDs and never appear as substrings of one another.
      sql += " AND participants LIKE ?";
      params.push(`%"${opts.agent_id}"%`);
    }
    // Default to excluding archived. The dashboard can opt back in by
    // passing excludeArchived=false explicitly.
    const excludeArchived = opts?.excludeArchived !== false;
    if (excludeArchived) {
      // SQLite has no native JSON ops at this version, so a substring filter
      // on the serialized meta column is good enough for a flag.
      sql += " AND meta NOT LIKE ?";
      params.push('%"archived":true%');
    }
    sql += " ORDER BY updated_at DESC";
    sql += ` LIMIT ${Math.max(1, Math.min(opts?.limit ?? 50, 500))}`;
    return this.db.prepare(sql).all(...params) as AgentConversation[];
  }

  closeConversation(id: string): void {
    const now = isoNow();
    this.db
      .prepare("UPDATE agent_conversations SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
    this.events.emit("agent:conversation:closed", { conversation_id: id });
  }

  /**
   * Mark a conversation as archived (soft hide). Re-merges into the existing
   * meta JSON so other meta keys aren't blown away. Idempotent. Returns true
   * if the row existed and was updated.
   */
  archiveConversation(id: string): boolean {
    const convo = this.getConversation(id);
    if (!convo) return false;
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(convo.meta || "{}"); } catch { meta = {}; }
    meta.archived = true;
    meta.archived_at = isoNow();
    this.db
      .prepare("UPDATE agent_conversations SET meta = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(meta), isoNow(), id);
    this.events.emit("agent:conversation:archived", { conversation_id: id });
    return true;
  }

  /**
   * Bulk-archive every closed conversation matching the filters. Used by the
   * dashboard's "clear all read" button to clean out the meeting history in
   * one shot.
   */
  archiveClosedConversations(opts?: { kind?: "chat" | "meeting" | "debate" }): number {
    let sql = "SELECT id, meta FROM agent_conversations WHERE status = 'closed' AND meta NOT LIKE ?";
    const params: unknown[] = ['%"archived":true%'];
    if (opts?.kind) { sql += " AND kind = ?"; params.push(opts.kind); }
    const rows = this.db.prepare(sql).all(...params) as Array<{ id: string; meta: string }>;
    let count = 0;
    for (const r of rows) {
      if (this.archiveConversation(r.id)) count++;
    }
    return count;
  }

  parseParticipants(convo: AgentConversation): string[] {
    try {
      const raw = JSON.parse(convo.participants || "[]");
      return Array.isArray(raw) ? raw.filter((x: unknown): x is string => typeof x === "string") : [];
    } catch { return []; }
  }

  addParticipant(conversationId: string, agentId: string): void {
    const convo = this.getConversation(conversationId);
    if (!convo) return;
    const current = this.parseParticipants(convo);
    if (current.includes(agentId)) return;
    current.push(agentId);
    this.db
      .prepare("UPDATE agent_conversations SET participants = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(current), isoNow(), conversationId);
  }

  postMessage(input: {
    conversation_id: string;
    from_agent_id: string;
    to_agent_id?: string;
    role?: AgentMessageRole;
    in_reply_to?: string;
    body: string;
    tokens?: number;
    run_id?: string;
    meta?: Record<string, unknown>;
  }): AgentMessage {
    const msg: AgentMessage = {
      id: newId(),
      conversation_id: input.conversation_id,
      from_agent_id: input.from_agent_id,
      to_agent_id: input.to_agent_id ?? "",
      role: input.role ?? "stmt",
      in_reply_to: input.in_reply_to ?? "",
      body: input.body,
      tokens: input.tokens ?? 0,
      run_id: input.run_id ?? "",
      meta: JSON.stringify(input.meta ?? {}),
      created_at: isoNow(),
    };
    this.db
      .prepare(
        `INSERT INTO agent_messages
          (id, conversation_id, from_agent_id, to_agent_id, role, in_reply_to,
           body, tokens, run_id, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id, msg.conversation_id, msg.from_agent_id, msg.to_agent_id, msg.role,
        msg.in_reply_to, msg.body, msg.tokens, msg.run_id, msg.meta, msg.created_at,
      );
    this.db
      .prepare("UPDATE agent_conversations SET updated_at = ? WHERE id = ?")
      .run(msg.created_at, msg.conversation_id);
    this.events.emit("agent:conversation:message_posted", {
      conversation_id: msg.conversation_id,
      message_id: msg.id,
      from_agent_id: msg.from_agent_id,
      to_agent_id: msg.to_agent_id,
      role: msg.role,
      in_reply_to: msg.in_reply_to,
    });
    return msg;
  }

  getMessage(id: string): AgentMessage | undefined {
    if (!id) return undefined;
    return this.db
      .prepare("SELECT * FROM agent_messages WHERE id = ?")
      .get(id) as AgentMessage | undefined;
  }

  listMessages(conversationId: string, opts?: {
    limit?: number;
    role?: AgentMessageRole;
  }): AgentMessage[] {
    let sql = "SELECT * FROM agent_messages WHERE conversation_id = ?";
    const params: unknown[] = [conversationId];
    if (opts?.role) { sql += " AND role = ?"; params.push(opts.role); }
    sql += " ORDER BY created_at ASC";
    sql += ` LIMIT ${Math.max(1, Math.min(opts?.limit ?? 200, 1000))}`;
    return this.db.prepare(sql).all(...params) as AgentMessage[];
  }

  /**
   * Return {distinctCounterSenders, counterMessages} for a conversation.
   * Used by the debate orchestrator to decide whether to auto-open a debate.
   */
  getCounterStats(conversationId: string): {
    distinct_senders: string[];
    counters: AgentMessage[];
  } {
    const counters = this.db
      .prepare(
        `SELECT * FROM agent_messages
          WHERE conversation_id = ? AND role = 'counter'
          ORDER BY created_at ASC`,
      )
      .all(conversationId) as AgentMessage[];
    const distinct = Array.from(new Set(counters.map(m => m.from_agent_id)));
    return { distinct_senders: distinct, counters };
  }

  // ── Debate cooldown register ─────────────────────────

  getDebateCooldown(topicHash: string): AgentDebateCooldown | undefined {
    if (!topicHash) return undefined;
    return this.db
      .prepare("SELECT * FROM agent_debate_cooldowns WHERE topic_hash = ?")
      .get(topicHash) as AgentDebateCooldown | undefined;
  }

  recordDebateCooldown(topicHash: string, debateConvId: string): void {
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO agent_debate_cooldowns (topic_hash, debate_conv_id, opened_at, closed_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(topic_hash) DO UPDATE SET
           debate_conv_id = excluded.debate_conv_id,
           opened_at = excluded.opened_at,
           closed_at = NULL`,
      )
      .run(topicHash, debateConvId, now);
  }

  countRecentAutoDebates(sinceIsoTimestamp: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM agent_debate_cooldowns WHERE opened_at >= ?")
      .get(sinceIsoTimestamp) as { c: number } | undefined;
    return row?.c ?? 0;
  }
}
