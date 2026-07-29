/**
 * Memory Nudge System
 * Periodically prompts the user/agent to curate memory
 *
 * Inspired by Hermes Agent's "Memory nudges every 10 user turns"
 */

import type { EventBus } from "../../core/event-bus.js";
import type { Notifier } from "../../core/notify/notifier.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { log } from "../../core/logger.js";
import { newId, isoNow } from "../../core/helpers.js";

// ── Types ─────────────────────────────────────────────

export interface NudgeConfig {
  /** Number of interactions before triggering a nudge */
  interactionThreshold: number;
  /** Minimum time between nudges (ms) */
  cooldownMs: number;
  /** Whether to send nudges via notification channels */
  notifyUser: boolean;
  /** Types of nudges to generate */
  nudgeTypes: NudgeType[];
}

export type NudgeType =
  | "memory_curation"      // Ask if there's something to remember
  | "contact_update"       // Suggest updating a stale contact
  | "task_review"          // Review overdue/stale tasks
  | "learning_reflection"  // Reflect on recent conversations
  | "preference_check";    // Confirm or update preferences

export interface Nudge {
  id: string;
  type: NudgeType;
  message: string;
  context?: Record<string, unknown>;
  createdAt: string;
  acknowledged: boolean;
}

export interface NudgeState {
  interactionCount: number;
  lastNudgeAt: string | null;
  pendingNudges: Nudge[];
}

// ── Nudge Messages ────────────────────────────────────

const NUDGE_MESSAGES: Record<NudgeType, string[]> = {
  memory_curation: [
    "We've had several exchanges. Is there anything from our conversation I should remember for next time?",
    "I'd like to make sure I remember what's important. Any key points from today I should note?",
    "Before we continue, is there anything you'd like me to remember about our recent discussion?",
  ],
  contact_update: [
    "I noticed we've been discussing {contactName}. Would you like me to update their contact info or add notes?",
    "It's been a while since {contactName}'s info was updated. Should I make any changes?",
  ],
  task_review: [
    "You have {count} tasks that haven't been updated recently. Would you like to review them?",
    "Some tasks might need attention: {titles}. Should we go through them?",
  ],
  learning_reflection: [
    "I've learned some things about your preferences recently. Want me to summarize what I've picked up?",
    "Based on our conversations, I've noticed some patterns. Should I share my observations?",
  ],
  preference_check: [
    "I want to make sure I'm helping you effectively. Are there any preferences I should adjust?",
    "Is there anything about how I respond that you'd like me to change?",
  ],
};

// ── MemoryNudgeManager ────────────────────────────────

export class MemoryNudgeManager {
  private state: NudgeState = {
    interactionCount: 0,
    lastNudgeAt: null,
    pendingNudges: [],
  };
  private config: NudgeConfig;

  constructor(
    private db: SqliteDb,
    private events: EventBus,
    private notifier: Notifier | null,
    config?: Partial<NudgeConfig>,
  ) {
    this.config = {
      interactionThreshold: config?.interactionThreshold ?? 10,
      cooldownMs: config?.cooldownMs ?? 30 * 60 * 1000, // 30 minutes
      notifyUser: config?.notifyUser ?? false,
      nudgeTypes: config?.nudgeTypes ?? ["memory_curation", "learning_reflection"],
    };

    this.loadState();
    this.setupEventListeners();
  }

  /**
   * Record an interaction and check if nudge is needed
   */
  recordInteraction(userId: string): Nudge | null {
    this.state.interactionCount++;
    this.saveState();

    // Check if we should nudge
    if (this.shouldNudge()) {
      return this.generateNudge(userId);
    }

    return null;
  }

  /**
   * Check if a nudge should be triggered
   */
  private shouldNudge(): boolean {
    // Check interaction threshold
    if (this.state.interactionCount < this.config.interactionThreshold) {
      return false;
    }

    // Check cooldown
    if (this.state.lastNudgeAt) {
      const lastNudge = new Date(this.state.lastNudgeAt).getTime();
      const now = Date.now();
      if (now - lastNudge < this.config.cooldownMs) {
        return false;
      }
    }

    // Don't nudge if there are pending nudges
    if (this.state.pendingNudges.length > 0) {
      return false;
    }

    return true;
  }

  /**
   * Generate a nudge based on current context
   */
  private generateNudge(userId: string): Nudge {
    // Select nudge type based on context
    const type = this.selectNudgeType();
    const message = this.selectMessage(type);
    const context = this.gatherContext(type);

    const nudge: Nudge = {
      id: newId(),
      type,
      message: this.interpolateMessage(message, context),
      context,
      createdAt: isoNow(),
      acknowledged: false,
    };

    // Reset counter and update state
    this.state.interactionCount = 0;
    this.state.lastNudgeAt = nudge.createdAt;
    this.state.pendingNudges.push(nudge);
    this.saveState();

    // Emit event
    this.events.emit("memory:nudge", { nudge, userId });

    log.debug(`Memory nudge generated: ${type}`);

    return nudge;
  }

  /**
   * Select which type of nudge to generate
   */
  private selectNudgeType(): NudgeType {
    const types = this.config.nudgeTypes;
    
    // Simple rotation based on pending nudge count
    const index = this.state.pendingNudges.length % types.length;
    return types[index];
  }

  /**
   * Select a random message for the nudge type
   */
  private selectMessage(type: NudgeType): string {
    const messages = NUDGE_MESSAGES[type];
    return messages[Math.floor(Math.random() * messages.length)];
  }

  /**
   * Gather context for the nudge
   */
  private gatherContext(type: NudgeType): Record<string, unknown> {
    const context: Record<string, unknown> = {};

    try {
      switch (type) {
        case "task_review": {
          const tasks = this.db
            .prepare(
              `SELECT title FROM tasks 
               WHERE status NOT IN ('done') 
               AND updated_at < datetime('now', '-7 days')
               LIMIT 5`
            )
            .all() as Array<{ title: string }>;
          context.count = tasks.length;
          context.titles = tasks.map(t => t.title).join(", ");
          break;
        }
        case "contact_update": {
          const contact = this.db
            .prepare(
              `SELECT name FROM contacts 
               WHERE last_interaction < datetime('now', '-30 days')
               ORDER BY last_interaction DESC
               LIMIT 1`
            )
            .get() as { name: string } | undefined;
          if (contact) {
            context.contactName = contact.name;
          }
          break;
        }
        default:
          break;
      }
    } catch {
      // Tables might not exist
    }

    return context;
  }

  /**
   * Interpolate variables in message template
   */
  private interpolateMessage(template: string, context: Record<string, unknown>): string {
    return template.replace(/\{(\w+)\}/g, (_, key) => {
      return String(context[key] ?? `{${key}}`);
    });
  }

  /**
   * Acknowledge a nudge (user responded)
   */
  acknowledgeNudge(nudgeId: string): void {
    const index = this.state.pendingNudges.findIndex(n => n.id === nudgeId);
    if (index >= 0) {
      this.state.pendingNudges[index].acknowledged = true;
      // Remove acknowledged nudges
      this.state.pendingNudges = this.state.pendingNudges.filter(n => !n.acknowledged);
      this.saveState();
    }
  }

  /**
   * Get pending nudges
   */
  getPendingNudges(): Nudge[] {
    return [...this.state.pendingNudges];
  }

  /**
   * Get the latest pending nudge (if any)
   */
  getLatestNudge(): Nudge | null {
    if (this.state.pendingNudges.length === 0) return null;
    return this.state.pendingNudges[this.state.pendingNudges.length - 1];
  }

  /**
   * Clear all pending nudges
   */
  clearNudges(): void {
    this.state.pendingNudges = [];
    this.saveState();
  }

  /**
   * Get current interaction count
   */
  getInteractionCount(): number {
    return this.state.interactionCount;
  }

  // ── Persistence ─────────────────────────────────────

  private loadState(): void {
    try {
      const row = this.db
        .prepare("SELECT value FROM kv_store WHERE key = 'memory_nudge_state'")
        .get() as { value: string } | undefined;
      
      if (row) {
        this.state = JSON.parse(row.value);
      }
    } catch {
      // Table might not exist or state might be corrupted
      log.debug("Memory nudge state not found, using defaults");
    }
  }

  private saveState(): void {
    try {
      // kv_store is created by agentsMigrations (./migrations.js, v37) via
      // runMigrations() in index.ts's initialize(), before this manager is
      // ever constructed.
      this.db
        .prepare(
          `INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)`
        )
        .run("memory_nudge_state", JSON.stringify(this.state), isoNow());
    } catch (err) {
      log.warn("Failed to save memory nudge state", err);
    }
  }

  // ── Event Listeners ─────────────────────────────────

  private setupEventListeners(): void {
    // Listen for chat messages to count interactions
    this.events.on("chat.message", () => {
      // Don't auto-increment here - let the orchestrator call recordInteraction()
    });

    // Listen for nudge acknowledgments (using typed event)
    this.events.on("memory:nudge:ack", (data) => {
      this.acknowledgeNudge(data.nudgeId);
    });
  }
}

// ── Singleton ─────────────────────────────────────────

let globalNudgeManager: MemoryNudgeManager | null = null;

export function initMemoryNudge(
  db: SqliteDb,
  events: EventBus,
  notifier: Notifier | null,
  config?: Partial<NudgeConfig>,
): MemoryNudgeManager {
  globalNudgeManager = new MemoryNudgeManager(db, events, notifier, config);
  return globalNudgeManager;
}

export function getMemoryNudge(): MemoryNudgeManager | null {
  return globalNudgeManager;
}
