/**
 * Episode Compaction
 * LLM-based summarization of long conversations to prevent context overflow
 *
 * Inspired by OpenFang's session compaction:
 * - threshold: 80 messages → trigger compaction
 * - keep_recent: 20 messages → preserve recent context
 * - max_summary_tokens: 1024 → summary budget
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import { log } from "../../core/logger.js";
import { newId, isoNow } from "../../core/helpers.js";
import { estimateTokens } from "./memory-decay.js";
import type { Message, Episode, ChatMessage } from "./types.js";
import type { ChatLlmProvider } from "../../core/llm/chat-adapters.js";

// ── Types ─────────────────────────────────────────────

export interface CompactionConfig {
  /** Number of messages before triggering compaction */
  threshold: number;
  /** Number of recent messages to preserve */
  keepRecent: number;
  /** Maximum tokens for the summary */
  maxSummaryTokens: number;
  /** Enable automatic compaction */
  autoCompact: boolean;
}

export interface CompactionResult {
  episodeId: string;
  messagesBefore: number;
  messagesAfter: number;
  messagesRemoved: number;
  summaryTokens: number;
  success: boolean;
  error?: string;
}

// ── Default Config ────────────────────────────────────

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  threshold: 80,
  keepRecent: 20,
  maxSummaryTokens: 1024,
  autoCompact: true,
};

// ── Compaction Prompts ────────────────────────────────

const SUMMARIZATION_SYSTEM = `You are a conversation summarizer. Your task is to create a concise summary of a conversation that captures:

1. Key topics discussed
2. Important decisions or conclusions reached
3. Tasks or action items mentioned
4. Key facts or information shared
5. Any preferences or patterns expressed by the user

Format the summary as a structured markdown with sections. Be concise but comprehensive.
Maximum summary length: approximately 800 words.`;

const SUMMARIZATION_PROMPT = `Please summarize the following conversation. Preserve the most important information while condensing repetitive or less relevant exchanges.

CONVERSATION:
{conversation}

SUMMARY:`;

// ── CompactionService ─────────────────────────────────

export class CompactionService {
  private config: CompactionConfig;

  constructor(
    private db: SqliteDb,
    config?: Partial<CompactionConfig>,
  ) {
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  }

  /**
   * Check if an episode needs compaction
   */
  needsCompaction(episodeId: string): boolean {
    const episode = this.db
      .prepare("SELECT message_count FROM chat_episodes WHERE id = ?")
      .get(episodeId) as { message_count: number } | undefined;

    if (!episode) return false;
    return episode.message_count >= this.config.threshold;
  }

  /**
   * Get episodes that need compaction
   */
  getEpisodesNeedingCompaction(): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM chat_episodes 
         WHERE status = 'active' 
         AND message_count >= ?
         ORDER BY message_count DESC`,
      )
      .all(this.config.threshold) as Array<{ id: string }>;

    return rows.map((r) => r.id);
  }

  /**
   * Compact an episode by summarizing old messages
   */
  async compactEpisode(
    episodeId: string,
    provider: ChatLlmProvider,
  ): Promise<CompactionResult> {
    const result: CompactionResult = {
      episodeId,
      messagesBefore: 0,
      messagesAfter: 0,
      messagesRemoved: 0,
      summaryTokens: 0,
      success: false,
    };

    try {
      // Get all messages
      const messages = this.db
        .prepare(
          `SELECT * FROM chat_messages 
           WHERE episode_id = ? 
           ORDER BY created_at ASC`,
        )
        .all(episodeId) as Message[];

      result.messagesBefore = messages.length;

      // Check if compaction is needed
      if (messages.length < this.config.threshold) {
        result.success = true;
        result.messagesAfter = messages.length;
        log.debug(`Episode ${episodeId} doesn't need compaction (${messages.length} < ${this.config.threshold})`);
        return result;
      }

      // Split messages: old (to summarize) and recent (to keep)
      const splitIndex = messages.length - this.config.keepRecent;
      const oldMessages = messages.slice(0, splitIndex);
      const recentMessages = messages.slice(splitIndex);

      // Check if there's an existing summary message
      const existingSummary = oldMessages.find((m) => m.role === "system" && m.content.startsWith("[SUMMARY"));
      const messagesToSummarize = existingSummary
        ? oldMessages.filter((m) => m.id !== existingSummary.id)
        : oldMessages;

      if (messagesToSummarize.length === 0) {
        result.success = true;
        result.messagesAfter = messages.length;
        return result;
      }

      // Build conversation text for summarization
      const conversationText = this.formatConversation(messagesToSummarize);

      // Generate summary using LLM
      const summary = await this.generateSummary(provider, conversationText);
      result.summaryTokens = estimateTokens(summary);

      // Create summary message
      const summaryContent = `[SUMMARY - ${isoNow().split("T")[0]}]\n\n${summary}`;
      const summaryMessageId = newId();
      const now = isoNow();

      // Delete old messages and insert summary
      // Delete old messages (except recent ones)
      const oldIds = messagesToSummarize.map((m) => m.id);
      if (oldIds.length > 0) {
        const placeholders = oldIds.map(() => "?").join(",");
        
        // Delete from FTS first
        this.db
          .prepare(`DELETE FROM chat_messages_fts WHERE message_id IN (${placeholders})`)
          .run(...oldIds);
        
        // Delete messages
        this.db
          .prepare(`DELETE FROM chat_messages WHERE id IN (${placeholders})`)
          .run(...oldIds);
      }

      // Delete existing summary if present
      if (existingSummary) {
        this.db
          .prepare("DELETE FROM chat_messages_fts WHERE message_id = ?")
          .run(existingSummary.id);
        this.db
          .prepare("DELETE FROM chat_messages WHERE id = ?")
          .run(existingSummary.id);
      }

      // Insert new summary message (at the beginning of remaining messages)
      this.db
        .prepare(
          `INSERT INTO chat_messages (id, episode_id, role, content, token_count, context_used, extraction_data, created_at)
           VALUES (?, ?, 'system', ?, ?, '{}', '{}', ?)`,
        )
        .run(summaryMessageId, episodeId, summaryContent, result.summaryTokens, now);

      // Insert into FTS
      this.db
        .prepare("INSERT INTO chat_messages_fts (message_id, content) VALUES (?, ?)")
        .run(summaryMessageId, summaryContent);

      // Update episode counters
      const newMessageCount = 1 + recentMessages.length; // summary + recent
      const newTotalTokens = result.summaryTokens + recentMessages.reduce((sum, m) => sum + m.token_count, 0);
      
      this.db
        .prepare(
          `UPDATE chat_episodes 
           SET message_count = ?, total_tokens = ?, summary = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(newMessageCount, newTotalTokens, summary.slice(0, 500), now, episodeId);

      result.messagesRemoved = messagesToSummarize.length + (existingSummary ? 1 : 0);
      result.messagesAfter = 1 + recentMessages.length;
      result.success = true;

      log.info(
        `Episode ${episodeId} compacted: ${result.messagesBefore} → ${result.messagesAfter} messages`,
      );
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      log.error(`Compaction failed for episode ${episodeId}`, err);
    }

    return result;
  }

  /**
   * Format messages into conversation text for summarization
   */
  private formatConversation(messages: Message[]): string {
    const lines: string[] = [];

    for (const msg of messages) {
      const roleLabel = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "System";
      const timestamp = msg.created_at.split("T")[0];
      
      // Truncate very long messages
      const content = msg.content.length > 1000
        ? msg.content.slice(0, 997) + "..."
        : msg.content;

      lines.push(`[${timestamp}] ${roleLabel}: ${content}`);
    }

    return lines.join("\n\n");
  }

  /**
   * Generate summary using LLM
   */
  private async generateSummary(
    provider: ChatLlmProvider,
    conversationText: string,
  ): Promise<string> {
    // Truncate if too long (keep under ~6000 tokens for input)
    const maxInputChars = 20000;
    const truncatedConversation = conversationText.length > maxInputChars
      ? conversationText.slice(-maxInputChars) // Keep most recent
      : conversationText;

    const prompt = SUMMARIZATION_PROMPT.replace("{conversation}", truncatedConversation);

    const messages: ChatMessage[] = [
      { role: "user", content: prompt },
    ];

    const result = await provider.chatCompletion(messages, {
      system: SUMMARIZATION_SYSTEM,
      max_tokens: this.config.maxSummaryTokens,
      temperature: 0.3, // Lower temperature for more factual summary
    });

    return result.content;
  }

  /**
   * Run automatic compaction on all eligible episodes
   */
  async runAutoCompaction(provider: ChatLlmProvider): Promise<CompactionResult[]> {
    if (!this.config.autoCompact) {
      return [];
    }

    const episodeIds = this.getEpisodesNeedingCompaction();
    const results: CompactionResult[] = [];

    for (const episodeId of episodeIds) {
      const result = await this.compactEpisode(episodeId, provider);
      results.push(result);

      // Add small delay between compactions to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (results.length > 0) {
      const successful = results.filter((r) => r.success).length;
      log.info(`Auto-compaction: ${successful}/${results.length} episodes compacted`);
    }

    return results;
  }

  /**
   * Get compaction statistics for an episode
   */
  getStats(episodeId: string): {
    messageCount: number;
    threshold: number;
    needsCompaction: boolean;
    hasSummary: boolean;
  } | null {
    const episode = this.db
      .prepare("SELECT message_count, summary FROM chat_episodes WHERE id = ?")
      .get(episodeId) as { message_count: number; summary: string } | undefined;

    if (!episode) return null;

    return {
      messageCount: episode.message_count,
      threshold: this.config.threshold,
      needsCompaction: episode.message_count >= this.config.threshold,
      hasSummary: episode.summary.length > 0,
    };
  }
}

// ── Factory ───────────────────────────────────────────

export function createCompactionService(
  db: SqliteDb,
  config?: Partial<CompactionConfig>,
): CompactionService {
  return new CompactionService(db, config);
}
