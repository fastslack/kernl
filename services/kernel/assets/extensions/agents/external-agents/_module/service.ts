import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { Notifier } from "../../../../../src/core/notify/notifier.js";
import { randomBytes } from "node:crypto";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";
import type {
  ExternalAgent,
  AgentMessage,
  AgentMetric,
  AgentAlert,
  AgentReport,
  AgentPlatform,
  AgentStatus,
} from "./types.js";

export class ExternalAgentService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
    private notifier: Notifier,
  ) {}

  // ── Agent CRUD ──────────────────────────────────────

  registerAgent(input: {
    name: string;
    description?: string;
    platform: AgentPlatform;
    platform_id: string;
    capabilities?: string[];
    config?: Record<string, unknown>;
  }): ExternalAgent {
    const now = isoNow();
    const apiKey = this.generateApiKey();

    const agent: ExternalAgent = {
      id: newId(),
      name: input.name,
      description: input.description ?? "",
      platform: input.platform,
      platform_id: input.platform_id,
      capabilities: JSON.stringify(input.capabilities ?? []),
      api_key: apiKey,
      last_seen_at: null,
      status: "unknown",
      config: JSON.stringify(input.config ?? {}),
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO external_agents (id, name, description, platform, platform_id,
         capabilities, api_key, last_seen_at, status, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id, agent.name, agent.description, agent.platform,
        agent.platform_id, agent.capabilities, agent.api_key,
        agent.last_seen_at, agent.status, agent.config,
        agent.created_at, agent.updated_at,
      );

    this.events.emit("data.changed", { module: "external-agents", action: "agent_registered" });
    log.info(`External agent registered: ${agent.name} (${agent.platform})`);

    return agent;
  }

  getAgent(id: string): ExternalAgent | undefined {
    return this.db
      .prepare("SELECT * FROM external_agents WHERE id = ?")
      .get(id) as ExternalAgent | undefined;
  }

  getAgentByApiKey(apiKey: string): ExternalAgent | undefined {
    return this.db
      .prepare("SELECT * FROM external_agents WHERE api_key = ?")
      .get(apiKey) as ExternalAgent | undefined;
  }

  getAgentByPlatformId(platform: AgentPlatform, platformId: string): ExternalAgent | undefined {
    return this.db
      .prepare("SELECT * FROM external_agents WHERE platform = ? AND platform_id = ?")
      .get(platform, platformId) as ExternalAgent | undefined;
  }

  listAgents(filters?: { platform?: AgentPlatform; status?: AgentStatus }): ExternalAgent[] {
    let sql = "SELECT * FROM external_agents WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.platform) {
      sql += " AND platform = ?";
      params.push(filters.platform);
    }
    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }

    sql += " ORDER BY name ASC";
    return this.db.prepare(sql).all(...params) as ExternalAgent[];
  }

  updateAgent(
    id: string,
    changes: Partial<{
      name: string;
      description: string;
      platform_id: string;
      capabilities: string[];
      status: AgentStatus;
      config: Record<string, unknown>;
    }>,
  ): ExternalAgent | undefined {
    const agent = this.getAgent(id);
    if (!agent) return undefined;

    const sets: string[] = [];
    const params: unknown[] = [];

    if (changes.name !== undefined) { sets.push("name = ?"); params.push(changes.name); }
    if (changes.description !== undefined) { sets.push("description = ?"); params.push(changes.description); }
    if (changes.platform_id !== undefined) { sets.push("platform_id = ?"); params.push(changes.platform_id); }
    if (changes.capabilities !== undefined) { sets.push("capabilities = ?"); params.push(JSON.stringify(changes.capabilities)); }
    if (changes.status !== undefined) { sets.push("status = ?"); params.push(changes.status); }
    if (changes.config !== undefined) { sets.push("config = ?"); params.push(JSON.stringify(changes.config)); }

    if (sets.length === 0) return agent;

    sets.push("updated_at = ?");
    params.push(isoNow());
    params.push(id);

    this.db.prepare(`UPDATE external_agents SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    this.events.emit("data.changed", { module: "external-agents", action: "agent_updated" });

    return this.getAgent(id);
  }

  deleteAgent(id: string): boolean {
    const result = this.db.prepare("DELETE FROM external_agents WHERE id = ?").run(id);
    if (result.changes > 0) {
      this.events.emit("data.changed", { module: "external-agents", action: "agent_deleted" });
      return true;
    }
    return false;
  }

  regenerateApiKey(id: string): string | null {
    const agent = this.getAgent(id);
    if (!agent) return null;

    const newKey = this.generateApiKey();
    this.db
      .prepare("UPDATE external_agents SET api_key = ?, updated_at = ? WHERE id = ?")
      .run(newKey, isoNow(), id);

    return newKey;
  }

  // ── Agent Heartbeat ─────────────────────────────────

  heartbeat(agentId: string): void {
    const now = isoNow();
    this.db
      .prepare("UPDATE external_agents SET last_seen_at = ?, status = 'online', updated_at = ? WHERE id = ?")
      .run(now, now, agentId);
  }

  markOffline(agentId: string): void {
    const now = isoNow();
    this.db
      .prepare("UPDATE external_agents SET status = 'offline', updated_at = ? WHERE id = ?")
      .run(now, agentId);
  }

  // ── Message Logging ─────────────────────────────────

  logMessage(input: {
    agent_id: string;
    direction: "inbound" | "outbound";
    message_type: AgentMessage["message_type"];
    content: string;
    metadata?: Record<string, unknown>;
  }): AgentMessage {
    const now = isoNow();
    const msg: AgentMessage = {
      id: newId(),
      agent_id: input.agent_id,
      direction: input.direction,
      message_type: input.message_type,
      content: input.content,
      metadata: JSON.stringify(input.metadata ?? {}),
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO external_agent_messages (id, agent_id, direction, message_type, content, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(msg.id, msg.agent_id, msg.direction, msg.message_type, msg.content, msg.metadata, msg.created_at);

    // Update last_seen_at for inbound messages
    if (input.direction === "inbound") {
      this.heartbeat(input.agent_id);
    }

    return msg;
  }

  getMessages(agentId: string, limit: number = 50): AgentMessage[] {
    return this.db
      .prepare(
        `SELECT * FROM external_agent_messages WHERE agent_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, limit) as AgentMessage[];
  }

  // ── Metrics ─────────────────────────────────────────

  recordMetric(input: {
    agent_id: string;
    metric_name: string;
    metric_value: number;
    unit?: string;
    recorded_at?: string;
  }): AgentMetric {
    const now = isoNow();
    const metric: AgentMetric = {
      id: newId(),
      agent_id: input.agent_id,
      metric_name: input.metric_name,
      metric_value: input.metric_value,
      unit: input.unit ?? "",
      recorded_at: input.recorded_at ?? now,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_metrics (id, agent_id, metric_name, metric_value, unit, recorded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        metric.id, metric.agent_id, metric.metric_name,
        metric.metric_value, metric.unit, metric.recorded_at, metric.created_at,
      );

    this.heartbeat(input.agent_id);
    return metric;
  }

  getMetrics(
    agentId: string,
    metricName?: string,
    since?: string,
    limit: number = 100,
  ): AgentMetric[] {
    let sql = "SELECT * FROM agent_metrics WHERE agent_id = ?";
    const params: unknown[] = [agentId];

    if (metricName) {
      sql += " AND metric_name = ?";
      params.push(metricName);
    }
    if (since) {
      sql += " AND recorded_at >= ?";
      params.push(since);
    }

    sql += " ORDER BY recorded_at DESC LIMIT ?";
    params.push(limit);

    return this.db.prepare(sql).all(...params) as AgentMetric[];
  }

  getLatestMetrics(agentId: string): Record<string, AgentMetric> {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_metrics m1
         WHERE agent_id = ?
         AND recorded_at = (
           SELECT MAX(m2.recorded_at) FROM agent_metrics m2
           WHERE m2.agent_id = m1.agent_id AND m2.metric_name = m1.metric_name
         )`,
      )
      .all(agentId) as AgentMetric[];

    const result: Record<string, AgentMetric> = {};
    for (const m of rows) {
      result[m.metric_name] = m;
    }
    return result;
  }

  // ── Alerts ──────────────────────────────────────────

  async createAlert(input: {
    agent_id: string;
    severity: "info" | "warning" | "critical";
    title: string;
    message?: string;
  }): Promise<AgentAlert> {
    const now = isoNow();
    const alert: AgentAlert = {
      id: newId(),
      agent_id: input.agent_id,
      severity: input.severity,
      title: input.title,
      message: input.message ?? "",
      acknowledged: 0,
      acknowledged_at: null,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_alerts (id, agent_id, severity, title, message, acknowledged, acknowledged_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        alert.id, alert.agent_id, alert.severity,
        alert.title, alert.message, alert.acknowledged,
        alert.acknowledged_at, alert.created_at,
      );

    // Get agent info for notification
    const agent = this.getAgent(input.agent_id);
    const agentName = agent?.name ?? "Unknown Agent";

    // Send notification for warnings and critical alerts
    if (input.severity !== "info") {
      const icon = input.severity === "critical" ? "🚨" : "⚠️";
      await this.notifier.send({
        title: `${icon} ${agentName}: ${input.title}`,
        body: input.message,
        priority: input.severity === "critical" ? "high" : "normal",
      });
    }

    this.events.emit("agent.alert", {
      agent_id: input.agent_id,
      agent_name: agentName,
      severity: input.severity,
      title: input.title,
    });

    this.heartbeat(input.agent_id);
    return alert;
  }

  getAlerts(filters?: {
    agent_id?: string;
    severity?: string;
    acknowledged?: boolean;
    limit?: number;
  }): AgentAlert[] {
    let sql = "SELECT * FROM agent_alerts WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.agent_id) {
      sql += " AND agent_id = ?";
      params.push(filters.agent_id);
    }
    if (filters?.severity) {
      sql += " AND severity = ?";
      params.push(filters.severity);
    }
    if (filters?.acknowledged !== undefined) {
      sql += " AND acknowledged = ?";
      params.push(filters.acknowledged ? 1 : 0);
    }

    sql += " ORDER BY created_at DESC";

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    return this.db.prepare(sql).all(...params) as AgentAlert[];
  }

  acknowledgeAlert(id: string): boolean {
    const now = isoNow();
    const result = this.db
      .prepare("UPDATE agent_alerts SET acknowledged = 1, acknowledged_at = ? WHERE id = ?")
      .run(now, id);

    return result.changes > 0;
  }

  // ── Report Processing ───────────────────────────────

  async processReport(report: AgentReport): Promise<void> {
    const agent = this.getAgent(report.agent_id);
    if (!agent) {
      log.warn(`Report from unknown agent: ${report.agent_id}`);
      return;
    }

    // Log the report
    this.logMessage({
      agent_id: report.agent_id,
      direction: "inbound",
      message_type: "report",
      content: JSON.stringify(report),
      metadata: { type: report.type },
    });

    // Process based on type
    switch (report.type) {
      case "metrics":
        if (report.metrics) {
          for (const m of report.metrics) {
            this.recordMetric({
              agent_id: report.agent_id,
              metric_name: m.name,
              metric_value: m.value,
              unit: m.unit,
              recorded_at: report.timestamp,
            });
          }
        }
        break;

      case "alert":
        await this.createAlert({
          agent_id: report.agent_id,
          severity: report.severity ?? "info",
          title: report.title ?? "Alert",
          message: report.message,
        });
        break;

      case "status":
        // Just update last_seen (already done by logMessage)
        log.debug(`Status report from ${agent.name}: ${report.message}`);
        break;

      case "log":
        log.info(`[${agent.name}] ${report.message}`);
        break;
    }
  }

  // ── Summary ─────────────────────────────────────────

  getSummary(): {
    total: number;
    online: number;
    offline: number;
    unknown: number;
    error: number;
    unacknowledgedAlerts: number;
  } {
    const agents = this.listAgents();
    const alerts = this.getAlerts({ acknowledged: false });

    return {
      total: agents.length,
      online: agents.filter((a) => a.status === "online").length,
      offline: agents.filter((a) => a.status === "offline").length,
      unknown: agents.filter((a) => a.status === "unknown").length,
      error: agents.filter((a) => a.status === "error").length,
      unacknowledgedAlerts: alerts.length,
    };
  }

  // ── Helpers ─────────────────────────────────────────

  private generateApiKey(): string {
    // Cryptographically secure: these keys are the sole credential for the
    // external-agent report/heartbeat/config endpoints. Math.random() is a
    // predictable PRNG and must never mint secrets.
    return "mtwk_" + randomBytes(24).toString("hex");
  }
}
