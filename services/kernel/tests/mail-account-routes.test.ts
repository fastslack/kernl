/**
 * Route-level proof that a secret never crosses the wire, for every account
 * route that returns an account (or a list of them): POST /api/email-accounts
 * (create), POST /api/email-accounts/update, and GET /api/dashboard/comms/accounts.
 * Fix round 1, item 2.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { EventBus } from "../src/core/event-bus.js";
import { registerEmailRoutes } from "../assets/extensions/people/comms/_module/email-routes.js";
import { registerCommsDashboardRoutes } from "../assets/extensions/people/comms/_module/dashboard-routes.js";
import { makeCommsDb } from "./mail-test-db.js";

const KEY = "b".repeat(64);
const imapCfg = (pass: string) => ({
  imap_host: "imap.x.com", imap_port: 993, imap_secure: true,
  smtp_host: "smtp.x.com", smtp_port: 465, smtp_secure: true,
  user: "maria@x.com", pass, from: "maria@x.com",
});

let db: ReturnType<typeof makeCommsDb>["db"];
let service: ReturnType<typeof makeCommsDb>["service"];
const server = new KernelHttpServer({
  config: {
    dashboard: { port: 0, bind: "127.0.0.1" },
    auth: { token: "" },
    cors: { allowedOrigins: [] },
  } as unknown as KernelConfig,
});

// Routes are registered once against a `service` reference that gets
// re-pointed at a fresh in-memory DB before each test.
beforeEach(() => {
  ({ db, service } = makeCommsDb());
  service.setProviderContext({ encryptionKey: KEY });
});

registerEmailRoutes(server, {} as never, {
  addAccount: (input: unknown) => service.addAccount(input as never),
  updateAccount: (id: string, changes: unknown) => service.updateAccount(id, changes as never),
  maskAccount: (a: unknown) => service.maskAccount(a as never),
} as never);
registerCommsDashboardRoutes(server, {} as never, {
  listAccountsForDisplay: () => service.listAccountsForDisplay(),
} as never, new EventBus());

let base = "";
beforeAll(async () => {
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await server.stop();
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/email-accounts (create) never returns the real secret", () => {
  it("masks an IMAP password", async () => {
    const r = await post("/api/email-accounts", {
      label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: imapCfg("s3cr3t"),
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain("s3cr3t");
    expect(JSON.parse(text).provider_config).toContain("••••••••");
  });

  it("masks a Resend api_key", async () => {
    const r = await post("/api/email-accounts", {
      label: "r", email: "news@x.com", provider: "resend", provider_config: { api_key: "re_123" },
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain("re_123");
    expect(JSON.parse(text).provider_config).toContain("••••••••");
  });
});

describe("POST /api/email-accounts/update never returns the real secret", () => {
  it("masks the IMAP password on the update response, even when the caller sends the plaintext back", async () => {
    const acc = service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: imapCfg("s3cr3t") });
    const r = await post("/api/email-accounts/update", {
      id: acc.id,
      provider_config: JSON.stringify({ ...imapCfg("s3cr3t"), imap_port: 143 }),
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain("s3cr3t");
    expect(JSON.parse(text).provider_config).toContain("••••••••");
  });

  it("masks a Resend api_key on the update response", async () => {
    const acc = service.addAccount({ label: "r", email: "news@x.com", provider: "resend", provider_config: { api_key: "re_123" } });
    const r = await post("/api/email-accounts/update", {
      id: acc.id,
      provider_config: JSON.stringify({ api_key: "re_123" }),
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain("re_123");
    expect(JSON.parse(text).provider_config).toContain("••••••••");
  });
});

describe("GET /api/dashboard/comms/accounts never returns the real secret", () => {
  it("masks both an IMAP password and a Resend api_key", async () => {
    service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: imapCfg("s3cr3t") });
    service.addAccount({ label: "r", email: "news@x.com", provider: "resend", provider_config: { api_key: "re_123" } });
    const r = await fetch(`${base}/api/dashboard/comms/accounts`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("re_123");
  });
});
