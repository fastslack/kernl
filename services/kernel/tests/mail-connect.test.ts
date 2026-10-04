import { describe, it, expect, beforeEach, afterAll, beforeAll } from "bun:test";
import { makeCommsDb } from "./mail-test-db.js";
import { connectMailAccount, type ConnectDeps } from "../assets/extensions/people/comms/_module/mail-connect.js";
import type { Discovery } from "../assets/extensions/people/comms/_module/mail-discovery.js";
import type { ImapSmtpConfig, VerifyResult } from "../assets/extensions/people/comms/_module/providers/imap-smtp-provider.js";
import type { CommsService } from "../assets/extensions/people/comms/_module/service.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { registerEmailRoutes } from "../assets/extensions/people/comms/_module/email-routes.js";

const KEY = "b".repeat(64);
const hosting: Discovery = {
  source: "autoconfig",
  provider: { id: null, name: "Mi Hosting", auth: "password" },
  imap: { host: "imap.estudio.com.ar", port: 993, secure: true },
  smtp: { host: "smtp.estudio.com.ar", port: 465, secure: true },
};
const gmail: Discovery = {
  source: "builtin",
  provider: { id: "gmail", name: "Gmail", auth: "app_password" },
  imap: { host: "imap.gmail.com", port: 993, secure: true },
  smtp: { host: "smtp.gmail.com", port: 465, secure: true },
  helpUrl: "https://myaccount.google.com/apppasswords",
};
const outlook: Discovery = { source: "builtin", provider: { id: "outlook", name: "Outlook", auth: "oauth_only" }, imap: null, smtp: null };
const proton: Discovery = { source: "builtin", provider: { id: "proton", name: "Proton Mail", auth: "bridge" }, imap: null, smtp: null };

let service: CommsService;
let verified: ImapSmtpConfig[];
let verifyOpts: unknown[];
let pulled: string[];

function deps(d: Discovery, result: VerifyResult): ConnectDeps {
  return {
    comms: service,
    discover: async () => d,
    verify: async (cfg, opts) => { verified.push(cfg); verifyOpts.push(opts); return result; },
    pullRecent: async (id) => { pulled.push(id); return 0; },
  };
}
const OK: VerifyResult = { imap: true, smtp: true };

beforeEach(() => {
  ({ service } = makeCommsDb());
  service.setProviderContext({ encryptionKey: KEY });
  verified = [];
  verifyOpts = [];
  pulled = [];
});

describe("connectMailAccount", () => {
  it("tests first, then saves one account with a sealed password and starts the first read", async () => {
    const r = await connectMailAccount({ email: "maria@estudio.com.ar", password: "s3cr3t" }, deps(hosting, OK));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readOnly).toBe(false);
    expect(r.updated).toBe(false);
    expect(verified[0]).toMatchObject({ imap_host: "imap.estudio.com.ar", smtp_host: "smtp.estudio.com.ar", user: "maria@estudio.com.ar", pass: "s3cr3t" });
    expect(r.account.email).toBe("maria@estudio.com.ar");
    expect(r.account.label).toBe("maria@estudio.com.ar");
    expect(r.account.provider).toBe("imap_smtp");
    expect(r.account.is_default).toBe(1);
    expect(JSON.stringify(r)).not.toContain("s3cr3t");
    expect(service.openImapConfig(service.getAccount(r.account.id)!).pass).toBe("s3cr3t");
    expect(pulled).toEqual([r.account.id]);
  });

  it("saves nothing when IMAP fails, and says why", async () => {
    const authErr = Object.assign(new Error("Command failed"), { authenticationFailed: true, responseText: "[AUTHENTICATIONFAILED] Invalid credentials" });
    const r = await connectMailAccount({ email: "maria@estudio.com.ar", password: "bad" },
      deps(hosting, { imap: false, smtp: false, imapError: authErr }));
    expect(r).toMatchObject({ ok: false, code: "auth_failed" });
    expect(service.listAccounts()).toEqual([]);
    expect(pulled).toEqual([]);
  });

  it("asks for an app password when Gmail refuses the normal one", async () => {
    const authErr = Object.assign(new Error("Command failed"), { authenticationFailed: true });
    const r = await connectMailAccount({ email: "maria@gmail.com", password: "normal" },
      deps(gmail, { imap: false, smtp: false, imapError: authErr }));
    expect(r).toMatchObject({ ok: false, code: "app_password_required" });
    if (!r.ok) expect(r.discovery?.helpUrl).toBe("https://myaccount.google.com/apppasswords");
  });

  it("strips the spaces Google shows in app passwords — only for app_password providers (Review Focus 2)", async () => {
    await connectMailAccount({ email: "maria@gmail.com", password: "abcd efgh ijkl mnop" }, deps(gmail, OK));
    expect(verified[0].pass).toBe("abcdefghijklmnop");

    await connectMailAccount({ email: "otra@estudio.com.ar", password: "con espacio" }, deps(hosting, OK));
    expect(verified[1].pass).toBe("con espacio");
  });

  it("does not try to connect Outlook or Proton", async () => {
    expect(await connectMailAccount({ email: "juan@hotmail.com", password: "x" }, deps(outlook, OK))).toMatchObject({ ok: false, code: "oauth_only" });
    expect(await connectMailAccount({ email: "juan@proton.me", password: "x" }, deps(proton, OK))).toMatchObject({ ok: false, code: "bridge" });
    expect(verified).toEqual([]);
  });

  it("saves a receive-only account when SMTP fails but IMAP works", async () => {
    const smtpErr = Object.assign(new Error("Greeting never received"), { code: "ETIMEDOUT" });
    const r = await connectMailAccount({ email: "maria@estudio.com.ar", password: "p" },
      deps(hosting, { imap: true, smtp: false, smtpError: smtpErr }));
    expect(r).toMatchObject({ ok: true, readOnly: true, code: "smtp_failed" });
    if (r.ok) expect(r.account.status).toBe("read_only");
  });

  it("reconnecting the same address updates it instead of duplicating (Review Focus 3)", async () => {
    const first = await connectMailAccount({ email: "maria@estudio.com.ar", password: "old" }, deps(hosting, OK));
    const again = await connectMailAccount({ email: "maria@estudio.com.ar", password: "new" }, deps(hosting, OK));
    expect(again).toMatchObject({ ok: true, updated: true });
    expect(service.listAccounts()).toHaveLength(1);
    if (first.ok) expect(service.openImapConfig(service.getAccount(first.account.id)!).pass).toBe("new");
  });

  it("refuses an address already connected through another provider", async () => {
    service.addAccount({ label: "g", email: "maria@gmail.com", provider: "gmail" });
    const r = await connectMailAccount({ email: "maria@gmail.com", password: "abcdabcdabcdabcd" }, deps(gmail, OK));
    expect(r).toMatchObject({ ok: false, code: "already_connected" });
    expect(verified).toEqual([]);
  });

  it("uses the Advanced overrides instead of discovery", async () => {
    let discovered = false;
    const d = deps(hosting, OK);
    d.discover = async () => { discovered = true; return hosting; };
    await connectMailAccount({
      email: "maria@estudio.com.ar", password: "p",
      overrides: { imap: { host: "mail.otro.com", port: 143, secure: false }, smtp: { host: "mail.otro.com", port: 587, secure: false }, user: "maria" },
    }, d);
    expect(discovered).toBe(false);
    expect(verified[0]).toMatchObject({ imap_host: "mail.otro.com", imap_port: 143, imap_secure: false, smtp_port: 587, user: "maria" });
  });

  it("asks the check not to try SMTP once IMAP has failed (T5-a)", async () => {
    await connectMailAccount({ email: "maria@estudio.com.ar", password: "p" }, deps(hosting, OK));
    expect(verifyOpts[0]).toMatchObject({ skipSmtpOnImapFailure: true });
  });

  it("finds a legacy mixed-case row instead of creating a second account (T5-b)", async () => {
    service.addAccount({ label: "old", email: "Maria@Estudio.com.ar", provider: "imap_smtp", provider_config: {
      imap_host: "imap.estudio.com.ar", smtp_host: "smtp.estudio.com.ar", user: "Maria@Estudio.com.ar", pass: "old" } });
    const r = await connectMailAccount({ email: "maria@estudio.com.ar", password: "new" }, deps(hosting, OK));
    expect(r).toMatchObject({ ok: true, updated: true });
    expect(service.listAccounts()).toHaveLength(1);
  });

  it("classifies a greeting timeout on plain text to 993 as a TLS problem (I2)", async () => {
    const e = Object.assign(new Error("Failed to receive greeting from server in required time. Maybe should use TLS?"), { code: "GREETING_TIMEOUT" });
    const r = await connectMailAccount({
      email: "maria@estudio.com.ar", password: "p",
      overrides: { imap: { host: "mail.otro.com", port: 993, secure: false }, smtp: { host: "mail.otro.com", port: 587, secure: false } },
    }, deps(hosting, { imap: false, smtp: false, imapError: e }));
    expect(r).toMatchObject({ ok: false, code: "tls" });
  });

  it("a failing first read never fails the connect", async () => {
    const d = deps(hosting, OK);
    d.pullRecent = async () => { throw new Error("IMAP busy"); };
    const r = await connectMailAccount({ email: "maria@estudio.com.ar", password: "p" }, d);
    expect(r.ok).toBe(true);
  });
});

describe("POST /api/email-accounts/discover and /connect — input validation", () => {
  const server = new KernelHttpServer({
    config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
  });
  registerEmailRoutes(server, {} as never, makeCommsDb().service);
  let base = "";
  beforeAll(async () => {
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(async () => { await server.stop(); });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("rejects what is not an email", async () => {
    expect((await post("/api/email-accounts/discover", { email: "maria" })).status).toBe(400);
    expect((await post("/api/email-accounts/connect", { email: "maria", password: "x" })).status).toBe(400);
  });

  it("rejects a connect without password", async () => {
    expect((await post("/api/email-accounts/connect", { email: "maria@gmail.com" })).status).toBe(400);
  });

  it("rejects a whitespace-only password (T5-c)", async () => {
    expect((await post("/api/email-accounts/connect", { email: "maria@gmail.com", password: "   " })).status).toBe(400);
  });

  it("normalises the address before discovering (Review Focus 1)", async () => {
    const r = await post("/api/email-accounts/discover", { email: "  Maria@Gmail.COM " });
    expect(r.status).toBe(200);
    expect((await r.json()).provider.id).toBe("gmail");
  });
});
