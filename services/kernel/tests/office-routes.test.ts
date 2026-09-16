/**
 * GET /api/offices/templates — the "Nueva oficina" gallery cards.
 *
 * Follows the fetch-based server pattern from
 * tests/agent-skill-suggestions-route.test.ts: stand up a real
 * KernelHttpServer on an ephemeral port and register the routes under test
 * directly (registerOfficeRoutes needs no db/service, unlike the full agents
 * router). Task 5 will extend this file with POST /api/offices/draft tests.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { registerOfficeRoutes } from "../src/modules/agents/routes/office-routes.js";
import type { ExtensionOfficeSource } from "../src/modules/agents/office-templates.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";

async function startServer(
  officeSources?: () => Promise<ExtensionOfficeSource[]>,
): Promise<{ base: string; stop: () => Promise<void> }> {
  const cfg = {
    dashboard: { port: 0, bind: "127.0.0.1" },
    auth: { token: "" },
    cors: { allowedOrigins: [] },
  } as unknown as KernelConfig;
  const server = new KernelHttpServer({ config: cfg });
  registerOfficeRoutes(server, { defaultLanguage: "es", officeSources });

  const started = await server.start();
  expect(started).toBe(true);
  const addr = server.nodeServer!.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { base: `http://127.0.0.1:${port}`, stop: () => server.stop() };
}

describe("GET /api/offices/templates", () => {
  let stop: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    delete process.env.KERNEL_ALLOW_UNSANDBOXED_AGENTS;
  });

  it("localizes builtin names per ?language, and falls back to defaultLanguage otherwise", async () => {
    const started = await startServer();
    stop = started.stop;

    const en = await fetch(`${started.base}/api/offices/templates?language=en`);
    expect(en.status).toBe(200);
    const enBody = await en.json() as { templates: Array<{ id: string; name: string }> };
    expect(enBody.templates.find((t) => t.id === "builtin:builder")?.name).toBe("Builder");

    const es = await fetch(`${started.base}/api/offices/templates?language=es`);
    const esBody = await es.json() as { templates: Array<{ id: string; name: string }> };
    expect(esBody.templates.find((t) => t.id === "builtin:builder")?.name).toBe("Constructora");

    // No ?language at all — falls back to defaultLanguage ("es" above).
    const none = await fetch(`${started.base}/api/offices/templates`);
    const noneBody = await none.json() as { templates: Array<{ id: string; name: string }> };
    expect(noneBody.templates.find((t) => t.id === "builtin:builder")?.name).toBe("Constructora");

    // An invalid value also falls back to defaultLanguage.
    const invalid = await fetch(`${started.base}/api/offices/templates?language=fr`);
    const invalidBody = await invalid.json() as { templates: Array<{ id: string; name: string }> };
    expect(invalidBody.templates.find((t) => t.id === "builtin:builder")?.name).toBe("Constructora");
  });

  it("still answers 200 with only the builtin templates when officeSources throws", async () => {
    const started = await startServer(() => {
      throw new Error("extensions module unavailable");
    });
    stop = started.stop;

    const res = await fetch(`${started.base}/api/offices/templates?language=en`);
    expect(res.status).toBe(200);
    const body = await res.json() as { templates: Array<{ id: string }> };
    expect(body.templates.map((t) => t.id)).toEqual(["builtin:blank", "builtin:builder", "builtin:research"]);
  });

  it("adds an ext:<slug> card for each extension office source", async () => {
    const started = await startServer(() =>
      Promise.resolve([
        { slug: "devops", name: "DevOps Office", description: "Ops", installed: true, enabled: true, entitlement: null },
      ]),
    );
    stop = started.stop;

    const res = await fetch(`${started.base}/api/offices/templates?language=en`);
    expect(res.status).toBe(200);
    const body = await res.json() as { templates: Array<{ id: string; source: string }> };
    expect(body.templates.map((t) => t.id)).toEqual([
      "builtin:blank", "builtin:builder", "builtin:research", "ext:devops",
    ]);
    expect(body.templates[3].source).toBe("extension");
  });

  it("reflects KERNEL_ALLOW_UNSANDBOXED_AGENTS in host_allowed", async () => {
    const started = await startServer();
    stop = started.stop;

    delete process.env.KERNEL_ALLOW_UNSANDBOXED_AGENTS;
    const off = await fetch(`${started.base}/api/offices/templates`);
    expect((await off.json() as { host_allowed: boolean }).host_allowed).toBe(false);

    process.env.KERNEL_ALLOW_UNSANDBOXED_AGENTS = "1";
    const on = await fetch(`${started.base}/api/offices/templates`);
    expect((await on.json() as { host_allowed: boolean }).host_allowed).toBe(true);
  });
});

describe("POST /api/offices/draft", () => {
  let stop: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
  });

  it("rejects an empty description with 400, without calling the model", async () => {
    const started = await startServer();
    stop = started.stop;

    const res = await fetch(`${started.base}/api/offices/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "   " }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("description is required");
  });

  it("rejects a description longer than 2000 characters with 400", async () => {
    const started = await startServer();
    stop = started.stop;

    const res = await fetch(`${started.base}/api/offices/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "x".repeat(2001) }),
    });
    expect(res.status).toBe(400);
  });
});
