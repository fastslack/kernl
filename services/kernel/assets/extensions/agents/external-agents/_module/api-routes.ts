import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { ExternalAgentService } from "./service.js";
import { log } from "../../../../../src/core/logger.js";
import type { AgentReport } from "./types.js";

/**
 * Register HTTP API routes for external agents.
 * 
 * Endpoints:
 * - POST /api/agents/report - Submit a report (metrics, alert, status)
 * - POST /api/agents/heartbeat - Send heartbeat
 * - GET /api/agents/config - Get agent configuration
 * 
 * All endpoints require X-Agent-Key header for authentication.
 */
export function registerExternalAgentRoutes(
  server: KernelHttpServer,
  service: ExternalAgentService,
): void {
  // ── Authentication middleware ─────────────────────────
  const authenticate = (headers: Record<string, string | string[] | undefined>) => {
    const apiKey = headers["x-agent-key"];
    if (!apiKey || typeof apiKey !== "string") {
      return null;
    }
    return service.getAgentByApiKey(apiKey);
  };

  // ── POST /api/agents/report ───────────────────────────
  server.post("/api/agents/report", async (req, res) => {
    const agent = authenticate(req.headers);
    if (!agent) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing X-Agent-Key" }));
      return;
    }

    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      const report = JSON.parse(body) as Omit<AgentReport, "agent_id">;
      
      await service.processReport({
        agent_id: agent.id,
        ...report,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, agent_id: agent.id }));
    } catch (err) {
      log.error("Error processing agent report", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid report format" }));
    }
  });

  // ── POST /api/agents/heartbeat ────────────────────────
  server.post("/api/agents/heartbeat", async (req, res) => {
    const agent = authenticate(req.headers);
    if (!agent) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing X-Agent-Key" }));
      return;
    }

    service.heartbeat(agent.id);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      agent_id: agent.id,
      timestamp: new Date().toISOString(),
    }));
  });

  // ── GET /api/agents/config ────────────────────────────
  server.get("/api/agents/config", (req, res) => {
    const agent = authenticate(req.headers);
    if (!agent) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing X-Agent-Key" }));
      return;
    }

    let config: Record<string, unknown> = {};
    try { config = JSON.parse(agent.config) as Record<string, unknown>; } catch { /* corrupted JSON, use empty */ }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      agent_id: agent.id,
      name: agent.name,
      config,
    }));
  });

  // ── POST /api/agents/metrics ──────────────────────────
  server.post("/api/agents/metrics", async (req, res) => {
    const agent = authenticate(req.headers);
    if (!agent) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing X-Agent-Key" }));
      return;
    }

    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      const data = JSON.parse(body) as {
        metrics: Array<{
          name: string;
          value: number;
          unit?: string;
          timestamp?: string;
        }>;
      };

      for (const m of data.metrics) {
        service.recordMetric({
          agent_id: agent.id,
          metric_name: m.name,
          metric_value: m.value,
          unit: m.unit,
          recorded_at: m.timestamp,
        });
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        count: data.metrics.length,
      }));
    } catch (err) {
      log.error("Error processing metrics", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid metrics format" }));
    }
  });

  // ── POST /api/agents/alert ────────────────────────────
  server.post("/api/agents/alert", async (req, res) => {
    const agent = authenticate(req.headers);
    if (!agent) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing X-Agent-Key" }));
      return;
    }

    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      const data = JSON.parse(body) as {
        severity: "info" | "warning" | "critical";
        title: string;
        message?: string;
      };

      const alert = await service.createAlert({
        agent_id: agent.id,
        severity: data.severity,
        title: data.title,
        message: data.message,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        alert_id: alert.id,
      }));
    } catch (err) {
      log.error("Error creating alert", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid alert format" }));
    }
  });

  log.info("External agents API routes registered");
}
