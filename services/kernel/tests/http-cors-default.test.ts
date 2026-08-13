/**
 * CORS defaults for the kernel HTTP API.
 *
 * The dashboard is always served from the kernel's own origin (directly when
 * DASHBOARD_ENABLED=true, or via the nginx sibling that proxies /api on the
 * same host), so same-origin needs no CORS header at all. Emitting a wildcard
 * by default let any page the user happened to have open read the API's
 * responses cross-origin — with the eval stack's unauthenticated mode that was
 * a drive-by read of the whole kernel.
 *
 * Rule under test: send `Access-Control-Allow-Origin` ONLY for an origin the
 * operator explicitly allow-listed via CORS_ALLOWED_ORIGINS.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";

function makeServer(allowedOrigins: string[]): KernelHttpServer {
  const cfg = {
    dashboard: { port: 0, bind: "127.0.0.1" },
    auth: { token: "" },
    cors: { allowedOrigins },
  } as unknown as KernelConfig;

  const server = new KernelHttpServer({ config: cfg });
  server.get("/api/ping", (req, res) => {
    server.json(res, 200, { pong: true }, req);
  });
  return server;
}

async function listen(server: KernelHttpServer): Promise<number> {
  const started = await server.start();
  expect(started).toBe(true);
  const addr = server.nodeServer!.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

describe("CORS with no configured origins", () => {
  const server = makeServer([]);
  afterAll(async () => { await server.stop(); });

  it("sends no Access-Control-Allow-Origin to a cross-origin caller", async () => {
    const port = await listen(server);
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sends no Access-Control-Allow-Origin on a preflight", async () => {
    const port = await listen(server);
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CORS with an allow-list", () => {
  const server = makeServer(["https://good.example"]);
  afterAll(async () => { await server.stop(); });

  it("echoes an allow-listed origin", async () => {
    const port = await listen(server);
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      headers: { Origin: "https://good.example" },
    });
    expect(r.headers.get("access-control-allow-origin")).toBe("https://good.example");
  });

  it("sends no Access-Control-Allow-Origin for an origin outside the allow-list", async () => {
    const port = await listen(server);
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});
