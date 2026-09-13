import type { SqliteDb } from "../../../core/db/sqlite.js";
import { newId, isoNow } from "../../../core/helpers.js";
import type { Agent, AgentConversation, AgentConversationSubscription } from "../types.js";

/**
 * Conversation subscriptions — which agents wake on which thread.
 * Owns `agent_conversation_subscriptions`; `AgentService` delegates to it and
 * injects the two readers this aggregate needs to validate a subscription.
 */
export class AgentSubscriptionsService {
  constructor(
    private db: SqliteDb,
    private getAgent: (id: string) => Agent | undefined,
    private getConversation: (id: string) => AgentConversation | undefined,
  ) {}

  /**
   * Subscribe an agent to a conversation. Idempotent — re-subscribing
   * updates mode/filter_role and reactivates if previously cancelled.
   */
  subscribeAgentToConversation(input: {
    agent_id: string;
    conversation_id: string;
    mode?: "responder" | "observer";
    filter_role?: string;
  }): AgentConversationSubscription | null {
    const agent = this.getAgent(input.agent_id);
    if (!agent) return null;
    const convo = this.getConversation(input.conversation_id);
    if (!convo) return null;

    const mode = input.mode ?? "responder";
    const filterRole = input.filter_role ?? "";

    const existing = this.db
      .prepare(
        `SELECT * FROM agent_conversation_subscriptions
         WHERE agent_id = ? AND conversation_id = ?`,
      )
      .get(input.agent_id, input.conversation_id) as AgentConversationSubscription | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE agent_conversation_subscriptions
           SET mode = ?, filter_role = ?, active = 1
           WHERE id = ?`,
        )
        .run(mode, filterRole, existing.id);
      return this.getSubscription(existing.id) ?? null;
    }

    const sub: AgentConversationSubscription = {
      id: newId(),
      agent_id: input.agent_id,
      conversation_id: input.conversation_id,
      mode,
      filter_role: filterRole,
      active: 1,
      last_fired_at: null,
      created_at: isoNow(),
    };
    this.db
      .prepare(
        `INSERT INTO agent_conversation_subscriptions
          (id, agent_id, conversation_id, mode, filter_role, active, last_fired_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sub.id, sub.agent_id, sub.conversation_id, sub.mode, sub.filter_role, sub.active, sub.last_fired_at, sub.created_at);
    return sub;
  }

  unsubscribeAgentFromConversation(agentId: string, conversationId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_conversation_subscriptions SET active = 0
         WHERE agent_id = ? AND conversation_id = ?`,
      )
      .run(agentId, conversationId) as { changes: number };
    return result.changes > 0;
  }

  getSubscription(id: string): AgentConversationSubscription | undefined {
    return this.db
      .prepare("SELECT * FROM agent_conversation_subscriptions WHERE id = ?")
      .get(id) as AgentConversationSubscription | undefined;
  }

  listSubscriptionsForConversation(conversationId: string): AgentConversationSubscription[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_conversation_subscriptions
         WHERE conversation_id = ? AND active = 1`,
      )
      .all(conversationId) as AgentConversationSubscription[];
  }

  listSubscriptionsForAgent(agentId: string): AgentConversationSubscription[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_conversation_subscriptions
         WHERE agent_id = ? AND active = 1
         ORDER BY created_at DESC`,
      )
      .all(agentId) as AgentConversationSubscription[];
  }

  markSubscriptionFired(id: string): void {
    this.db
      .prepare("UPDATE agent_conversation_subscriptions SET last_fired_at = ? WHERE id = ?")
      .run(isoNow(), id);
  }
}
