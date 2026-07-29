/**
 * Approval Gates
 * Workflow for approving sensitive actions before execution
 *
 * Inspired by OpenFang's approval gates for the Browser Hand
 */

import type { Notifier } from "../core/notify/notifier.js";
import type { EventBus } from "../core/event-bus.js";
import { log } from "../core/logger.js";
import { newId, isoNow } from "../core/helpers.js";

// ── Types ─────────────────────────────────────────────

export interface ApprovalGate {
  /** Tool name pattern (exact match or regex) */
  tool: string | RegExp;
  /** Optional condition - if returns false, no approval needed */
  condition?: (args: unknown) => boolean;
  /** Timeout in ms before auto-deny (default: 5 minutes) */
  timeoutMs?: number;
  /** Notification channel to use */
  channel: "telegram" | "mattermost" | "all";
  /** Risk level for display */
  riskLevel: "low" | "medium" | "high" | "critical";
  /** Human-readable reason for the gate */
  reason: string;
}

export interface PendingApproval {
  id: string;
  toolName: string;
  args: unknown;
  userId: string;
  gate: ApprovalGate;
  status: "pending" | "approved" | "denied" | "timeout";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolve: (approved: boolean) => void;
}

export interface ApprovalManagerConfig {
  /** Enable approval workflow */
  enabled: boolean;
  /** Default timeout in ms (5 minutes) */
  defaultTimeoutMs: number;
  /** Auto-approve for trusted users */
  trustedUsers: string[];
}

// ── Default Gates ─────────────────────────────────────

export const DEFAULT_GATES: ApprovalGate[] = [
  {
    tool: "kernel_comms_send",
    channel: "telegram",
    riskLevel: "medium",
    reason: "Sending an email requires approval",
  },
  {
    tool: "kernel_shopping_log_purchase",
    condition: (args) => {
      const a = args as { total_price?: number };
      return (a.total_price ?? 0) > 5000; // > €50
    },
    channel: "telegram",
    riskLevel: "medium",
    reason: "Large purchase requires approval",
  },
  {
    tool: "kernel_events_cancel",
    channel: "telegram",
    riskLevel: "high",
    reason: "Cancelling an event affects all attendees",
  },
  {
    tool: "kernel_crm_delete_contact",
    channel: "telegram",
    riskLevel: "high",
    reason: "Deleting a contact is irreversible",
  },
  {
    tool: /^skill_.*_execute$/,
    channel: "telegram",
    riskLevel: "medium",
    reason: "Executing a skill action",
  },
];

// ── ApprovalManager ───────────────────────────────────

export class ApprovalManager {
  private gates: ApprovalGate[] = [];
  private pending = new Map<string, PendingApproval>();
  private config: ApprovalManagerConfig;

  constructor(
    private notifier: Notifier,
    private events: EventBus,
    config?: Partial<ApprovalManagerConfig>,
  ) {
    this.config = {
      enabled: config?.enabled ?? true,
      defaultTimeoutMs: config?.defaultTimeoutMs ?? 5 * 60 * 1000, // 5 minutes
      trustedUsers: config?.trustedUsers ?? [],
    };

    // Register default gates
    this.gates = [...DEFAULT_GATES];
  }

  /**
   * Add a custom approval gate
   */
  addGate(gate: ApprovalGate): void {
    this.gates.push(gate);
  }

  /**
   * Remove a gate by tool name
   */
  removeGate(tool: string): void {
    this.gates = this.gates.filter((g) => {
      if (typeof g.tool === "string") return g.tool !== tool;
      return true;
    });
  }

  /**
   * Check if a tool requires approval
   */
  findGate(toolName: string, args: unknown): ApprovalGate | null {
    for (const gate of this.gates) {
      const matches = typeof gate.tool === "string"
        ? gate.tool === toolName
        : gate.tool.test(toolName);

      if (!matches) continue;

      // Check condition if present
      if (gate.condition && !gate.condition(args)) {
        continue;
      }

      return gate;
    }
    return null;
  }

  /**
   * Request approval for a tool execution
   * Returns true if approved, false if denied or timed out
   */
  async requestApproval(
    toolName: string,
    args: unknown,
    userId: string,
  ): Promise<boolean> {
    // Check if disabled
    if (!this.config.enabled) return true;

    // Check if trusted user
    if (this.config.trustedUsers.includes(userId)) return true;

    // Find applicable gate
    const gate = this.findGate(toolName, args);
    if (!gate) return true; // No gate = auto-approve

    const id = newId();
    const timeoutMs = gate.timeoutMs ?? this.config.defaultTimeoutMs;

    // Create pending approval
    const approval: PendingApproval = {
      id,
      toolName,
      args,
      userId,
      gate,
      status: "pending",
      createdAt: isoNow(),
      resolve: () => {}, // Will be set below
    };

    // Create promise that resolves on approval/denial
    const promise = new Promise<boolean>((resolve) => {
      approval.resolve = (approved: boolean) => {
        approval.status = approved ? "approved" : "denied";
        approval.resolvedAt = isoNow();
        this.pending.delete(id);
        resolve(approved);
      };
    });

    this.pending.set(id, approval);

    // Send notification
    await this.sendApprovalRequest(approval);

    // Set up timeout
    const timeoutId = setTimeout(() => {
      if (this.pending.has(id)) {
        const a = this.pending.get(id)!;
        a.status = "timeout";
        a.resolvedAt = isoNow();
        a.resolve(false);
        this.pending.delete(id);
        log.info(`Approval ${id} timed out`);
      }
    }, timeoutMs);

    // Wait for resolution
    const result = await promise;
    clearTimeout(timeoutId);

    // Emit event
    this.events.emit("data.changed", {
      module: "security",
      action: result ? "approval_granted" : "approval_denied",
    });

    return result;
  }

  /**
   * Approve a pending request
   */
  approve(approvalId: string, approvedBy?: string): boolean {
    const approval = this.pending.get(approvalId);
    if (!approval) return false;

    approval.resolvedBy = approvedBy;
    approval.resolve(true);
    log.info(`Approval ${approvalId} granted by ${approvedBy ?? "user"}`);
    return true;
  }

  /**
   * Deny a pending request
   */
  deny(approvalId: string, deniedBy?: string): boolean {
    const approval = this.pending.get(approvalId);
    if (!approval) return false;

    approval.resolvedBy = deniedBy;
    approval.resolve(false);
    log.info(`Approval ${approvalId} denied by ${deniedBy ?? "user"}`);
    return true;
  }

  /**
   * Get all pending approvals
   */
  getPending(): PendingApproval[] {
    return Array.from(this.pending.values());
  }

  /**
   * Get a pending approval by ID
   */
  getPendingById(id: string): PendingApproval | undefined {
    return this.pending.get(id);
  }

  /**
   * Send approval request notification
   */
  private async sendApprovalRequest(approval: PendingApproval): Promise<void> {
    const riskEmoji = {
      low: "🟢",
      medium: "🟡",
      high: "🟠",
      critical: "🔴",
    };

    const argsPreview = this.formatArgs(approval.args);
    const timeoutSec = Math.floor((approval.gate.timeoutMs ?? this.config.defaultTimeoutMs) / 1000);

    const message = [
      `${riskEmoji[approval.gate.riskLevel]} **Approval Required**`,
      "",
      `**Tool:** \`${approval.toolName}\``,
      `**Risk:** ${approval.gate.riskLevel}`,
      `**Reason:** ${approval.gate.reason}`,
      "",
      `**Arguments:**`,
      "```",
      argsPreview,
      "```",
      "",
      `⏱️ Auto-deny in ${timeoutSec}s`,
      "",
      `Reply with:`,
      `\`/approve ${approval.id}\` or \`/deny ${approval.id}\``,
    ].join("\n");

    try {
      // Use the unified send() method with proper channel routing
      await this.notifier.send({
        title: `Approval Required: ${approval.toolName}`,
        body: message,
        channel: approval.gate.channel,
        priority: approval.gate.riskLevel === "critical" ? "high" : "normal",
      });
    } catch (err) {
      log.error("Failed to send approval request notification", err);
    }
  }

  /**
   * Format args for display
   */
  private formatArgs(args: unknown): string {
    if (args === null || args === undefined) return "(none)";
    
    try {
      const str = JSON.stringify(args, null, 2);
      // Truncate if too long
      if (str.length > 500) {
        return str.slice(0, 497) + "...";
      }
      return str;
    } catch {
      return String(args);
    }
  }

  /**
   * Handle commands from chat (e.g., "/approve xyz")
   */
  handleCommand(command: string, userId: string): string | null {
    const approveMatch = command.match(/^\/approve\s+([a-f0-9-]+)$/i);
    if (approveMatch) {
      const id = approveMatch[1];
      if (this.approve(id, userId)) {
        return `✅ Approved: ${id}`;
      }
      return `❌ Approval not found or already resolved: ${id}`;
    }

    const denyMatch = command.match(/^\/deny\s+([a-f0-9-]+)$/i);
    if (denyMatch) {
      const id = denyMatch[1];
      if (this.deny(id, userId)) {
        return `❌ Denied: ${id}`;
      }
      return `❌ Approval not found or already resolved: ${id}`;
    }

    if (command === "/pending") {
      const pending = this.getPending();
      if (pending.length === 0) {
        return "No pending approvals.";
      }
      const lines = pending.map((p) => 
        `• \`${p.id.slice(0, 8)}\` — ${p.toolName} (${p.gate.riskLevel})`
      );
      return `**Pending Approvals (${pending.length}):**\n${lines.join("\n")}`;
    }

    return null;
  }
}

// ── Helper Functions ──────────────────────────────────

/**
 * Create default ApprovalManager
 */
export function createApprovalManager(
  notifier: Notifier,
  events: EventBus,
  config?: Partial<ApprovalManagerConfig>,
): ApprovalManager {
  return new ApprovalManager(notifier, events, config);
}

/**
 * Format approval status for display
 */
export function formatApprovalStatus(approval: PendingApproval): string {
  const statusEmoji = {
    pending: "⏳",
    approved: "✅",
    denied: "❌",
    timeout: "⏱️",
  };

  return `${statusEmoji[approval.status]} ${approval.toolName} — ${approval.status}`;
}
