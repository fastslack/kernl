/**
 * Per-agent skill suggestions, served where the drawer can use them.
 *
 * The same ranking runs in a daily cron that writes a note; this route is the
 * live path. It scores installed skills only — the catalogue join lands in a
 * separate change.
 *
 * tests/agent-api-routes.test.ts deliberately tests the service layer only
 * ("KernelHttpServer is not designed for unit-test isolation"), so it has no
 * fetch-based server scaffolding to reuse. tests/http-cors-default.test.ts
 * does stand up a real KernelHttpServer with `dashboard.port: 0` + `auth.token:
 * ""` and reads the bound port back off `nodeServer!.address()` — that is the
 * pattern reused here, wired to the agents module's own route registration.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { registerAgentRoutes } from "../src/modules/agents/api-routes.js";
import { EventBus } from "../src/core/event-bus.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";

function insertSkill(
  db: InstanceType<typeof Database>,
  opts: { slug: string; name: string; description: string },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO installed_extensions
       (id, slug, name, version, type, status, manifest_json,
        source_json, install_path, granted_permissions_json, settings_json,
        error, installed_at, updated_at, last_loaded_at)
     VALUES (?, ?, ?, '1.0.0', 'skill', 'active', ?,
             '{"type":"local","path":""}', '', '[]', '{}',
             '', ?, ?, NULL)`,
  ).run(crypto.randomUUID(), opts.slug, opts.name, JSON.stringify({ description: opts.description }), now, now);
}

describe("GET /api/agents/:id/skill-suggestions", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;
  let server: KernelHttpServer;
  let base: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "extensions", extensionsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
    const executor = new AgentExecutor();

    const cfg = {
      dashboard: { port: 0, bind: "127.0.0.1" },
      auth: { token: "" },
      cors: { allowedOrigins: [] },
    } as unknown as KernelConfig;
    server = new KernelHttpServer({ config: cfg });
    registerAgentRoutes(server, service, executor, events);

    const started = await server.start();
    expect(started).toBe(true);
    const addr = server.nodeServer!.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
  });

  it("404s for an unknown agent", async () => {
    const res = await fetch(`${base}/api/agents/does-not-exist/skill-suggestions`);
    expect(res.status).toBe(404);
  });

  it("ranks an installed skill that matches the agent's prompt", async () => {
    const agent = service.createAgent({
      name: "SEO Bot",
      system_prompt: "This agent focuses on sitemap generation and meta tag validation for websites.",
    });
    insertSkill(db, {
      slug: "seo-audit",
      name: "SEO Audit",
      description: "Checks sitemap coverage and meta tag hygiene for search engines.",
    });

    const res = await fetch(`${base}/api/agents/${agent.id}/skill-suggestions`);
    expect(res.status).toBe(200);
    const body = await res.json() as { suggestions: Array<{ slug: string; installed: boolean }> };
    expect(body.suggestions[0].slug).toBe("seo-audit");
    expect(body.suggestions[0].installed).toBe(true);
  });

  it("never suggests a skill the agent already carries", async () => {
    const agent = service.createAgent({
      name: "SEO Bot",
      system_prompt: "This agent focuses on sitemap generation and meta tag validation for websites.",
    });
    insertSkill(db, {
      slug: "seo-audit",
      name: "SEO Audit",
      description: "Checks sitemap coverage and meta tag hygiene for search engines.",
    });
    service.updateAgent(agent.id, { skills: ["seo-audit"] });

    const res = await fetch(`${base}/api/agents/${agent.id}/skill-suggestions`);
    const body = await res.json() as { suggestions: Array<{ slug: string }> };
    expect(body.suggestions.map((s) => s.slug)).not.toContain("seo-audit");
  });

  it("returns an empty list, not an error, when nothing is installed", async () => {
    const agent = service.createAgent({ name: "Empty Agent" });

    const res = await fetch(`${base}/api/agents/${agent.id}/skill-suggestions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
  });
});
