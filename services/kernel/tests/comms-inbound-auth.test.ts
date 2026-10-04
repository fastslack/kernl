/**
 * POST /api/comms/inbound takes email from outside the kernel, so it fails
 * closed: disabled (503) until COMMS_INBOUND_TOKEN is set, and then the token
 * is accepted only in the X-Inbound-Token header — never as a `?token=` query,
 * which would land in access logs.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { registerEmailRoutes, inboundTokenMatches } from "../assets/extensions/people/comms/_module/email-routes.js";

const ingested: unknown[] = [];
const server = new KernelHttpServer({
  config: {
    dashboard: { port: 0, bind: "127.0.0.1" },
    auth: { token: "" },
    cors: { allowedOrigins: [] },
  } as unknown as KernelConfig,
});
registerEmailRoutes(server, {} as never, {
  ingestInboundRaw: (input: unknown) => {
    ingested.push(input);
    return { comm: { id: "c1" }, isNew: true };
  },
} as never);

let base = "";
const saved = process.env.COMMS_INBOUND_TOKEN;

beforeAll(async () => {
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await server.stop();
  if (saved === undefined) delete process.env.COMMS_INBOUND_TOKEN;
  else process.env.COMMS_INBOUND_TOKEN = saved;
});
afterEach(() => { ingested.length = 0; });

const post = (query = "", headers: Record<string, string> = {}) =>
  fetch(`${base}/api/comms/inbound${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ from: "alice@example.com", subject: "hi" }),
  });

describe("POST /api/comms/inbound", () => {
  it("is disabled until COMMS_INBOUND_TOKEN is set", async () => {
    delete process.env.COMMS_INBOUND_TOKEN;
    const r = await post();
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "Inbound email is disabled until COMMS_INBOUND_TOKEN is set" });
    expect(ingested).toEqual([]);
  });

  it("accepts the token in the X-Inbound-Token header", async () => {
    process.env.COMMS_INBOUND_TOKEN = "s3cret";
    const r = await post("", { "X-Inbound-Token": "s3cret" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, comm_id: "c1", is_new: true });
    expect(ingested).toHaveLength(1);
  });

  it("rejects a missing or wrong header, and the ?token= query", async () => {
    process.env.COMMS_INBOUND_TOKEN = "s3cret";
    for (const r of [
      await post(),
      await post("", { "X-Inbound-Token": "s3creX" }),
      await post("", { "X-Inbound-Token": "s3cret-longer" }),
      await post("?token=s3cret"),
    ]) {
      expect(r.status).toBe(401);
    }
    expect(ingested).toEqual([]);
  });

  it("compares tokens of any length without throwing", () => {
    expect(inboundTokenMatches("abc", "abc")).toBe(true);
    expect(inboundTokenMatches("abd", "abc")).toBe(false);
    expect(inboundTokenMatches("", "abc")).toBe(false);
    expect(inboundTokenMatches("abcd", "abc")).toBe(false);
  });
});
