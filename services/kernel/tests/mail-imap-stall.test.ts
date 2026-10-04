/**
 * A mail server that accepts the connection and then goes quiet must fail the
 * check, not take the process down. Everything runs against loopback servers.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { ImapSmtpProvider, type ImapSmtpConfig } from "../assets/extensions/people/comms/_module/providers/imap-smtp-provider.js";
import { classifyMailError } from "../assets/extensions/people/comms/_module/mail-errors.js";

const servers: Server[] = [];
const sockets: Socket[] = [];

async function listen(onConnection: (s: Socket) => void): Promise<number> {
  const server = createServer((s) => { sockets.push(s); s.on("error", () => {}); onConnection(s); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

/** A port on loopback with nothing listening: SMTP fails fast with ECONNREFUSED. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const cfg = (imapPort: number, smtpPort: number): ImapSmtpConfig => ({
  imap_host: "127.0.0.1", imap_port: imapPort, imap_secure: false,
  smtp_host: "127.0.0.1", smtp_port: smtpPort, smtp_secure: false,
  user: "maria@x.com", pass: "s3cr3t", from: "maria@x.com",
});

/** Let any late socket timeouts fire inside the test, where a crash would show. */
const settle = () => new Promise((r) => setTimeout(r, 250));

describe("ImapSmtpProvider.verify against a stalled IMAP server", () => {
  it("a server that accepts TCP and never greets → imap: false with a timeout error", async () => {
    const imapPort = await listen(() => {});
    const smtpPort = await closedPort();
    const result = await new ImapSmtpProvider(cfg(imapPort, smtpPort), "maria@x.com").verify({ timeoutMs: 300 });
    await settle();
    expect(result.imap).toBe(false);
    expect(result.imapError).toBeDefined();
    expect(classifyMailError(result.imapError, "password")).toBe("timeout");
    expect(result.error ?? "").not.toContain("s3cr3t");
  });

  it("a server that greets and never answers LOGIN → imap: false, process keeps running", async () => {
    const imapPort = await listen((s) => s.write("* OK IMAP4rev1 ready\r\n"));
    const smtpPort = await closedPort();
    const result = await new ImapSmtpProvider(cfg(imapPort, smtpPort), "maria@x.com").verify({ timeoutMs: 300 });
    await settle();
    expect(result.imap).toBe(false);
    expect(result.imapError).toBeDefined();
    expect(result.error ?? "").not.toContain("s3cr3t");
  });
});

describe("ImapSmtpProvider.verify with skipSmtpOnImapFailure (T5-a)", () => {
  it("does not open an SMTP connection once IMAP has failed", async () => {
    const imapPort = await listen(() => {});
    let smtpConnections = 0;
    const smtpPort = await listen(() => { smtpConnections++; });
    const result = await new ImapSmtpProvider(cfg(imapPort, smtpPort), "maria@x.com").verify({ timeoutMs: 300, skipSmtpOnImapFailure: true });
    expect(result.imap).toBe(false);
    expect(result.smtp).toBe(false);
    expect(result.smtpError).toBeUndefined();
    expect(smtpConnections).toBe(0);
  });
});

describe("ImapSmtpProvider search/fetch against a stalled IMAP server", () => {
  // A dropped-packet server (firewall, fail2ban ban) used to hang the inbox
  // fetcher forever, stalling every account queued behind it.
  it("searchInbox rejects instead of waiting forever on a silent server", async () => {
    const imapPort = await listen(() => {});
    const p = new ImapSmtpProvider(cfg(imapPort, await closedPort()), "maria@x.com", { opTimeoutMs: 300 });
    await expect(p.searchInbox("", 20)).rejects.toBeDefined();
    await settle();
  });

  it("fetchEmail rejects when the server greets and then goes quiet", async () => {
    const imapPort = await listen((s) => s.write("* OK IMAP4rev1 ready\r\n"));
    const p = new ImapSmtpProvider(cfg(imapPort, await closedPort()), "maria@x.com", { opTimeoutMs: 300 });
    await expect(p.fetchEmail("1")).rejects.toBeDefined();
    await settle();
  });
});
