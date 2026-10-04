import { describe, it, expect, beforeEach } from "bun:test";
import { isEncrypted } from "@kernl/extension-sdk";
import { makeCommsDb } from "./mail-test-db.js";
import { MASKED_SECRET, type CommsService } from "../assets/extensions/people/comms/_module/service.js";

const KEY = "a".repeat(64);
const imapCfg = (pass: string) => ({
  imap_host: "imap.x.com", imap_port: 993, imap_secure: true,
  smtp_host: "smtp.x.com", smtp_port: 465, smtp_secure: true,
  user: "maria@x.com", pass, from: "maria@x.com",
});

let service: CommsService;
let db: ReturnType<typeof makeCommsDb>["db"];
beforeEach(() => {
  ({ db, service } = makeCommsDb());
  service.setProviderContext({ encryptionKey: KEY });
});

const storedPass = (id: string) =>
  JSON.parse((db.prepare("SELECT provider_config FROM email_accounts WHERE id = ?").get(id) as { provider_config: string }).provider_config).pass;

describe("IMAP password at rest", () => {
  it("is encrypted in the DB and decrypted for the provider", () => {
    const acc = service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: imapCfg("s3cr3t") });
    expect(storedPass(acc.id)).not.toBe("s3cr3t");
    expect(isEncrypted(storedPass(acc.id))).toBe(true);
    expect(service.openImapConfig(service.getAccount(acc.id)!).pass).toBe("s3cr3t");
  });

  it("an old plaintext row keeps working and is sealed on the next save", () => {
    const acc = service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: imapCfg("x") });
    db.prepare("UPDATE email_accounts SET provider_config = ? WHERE id = ?").run(JSON.stringify(imapCfg("legacy")), acc.id);
    expect(service.openImapConfig(service.getAccount(acc.id)!).pass).toBe("legacy");

    service.updateAccount(acc.id, { provider_config: JSON.stringify(imapCfg("legacy")) });
    expect(isEncrypted(storedPass(acc.id))).toBe(true);
    expect(service.openImapConfig(service.getAccount(acc.id)!).pass).toBe("legacy");
  });

  it("without an encryption key it stores plaintext, as before", () => {
    service.setProviderContext({ encryptionKey: "" });
    const acc = service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: imapCfg("plain") });
    expect(storedPass(acc.id)).toBe("plain");
  });
});

describe("a sealed password that no longer opens (I4)", () => {
  const OTHER_KEY = "c".repeat(64);

  it("sealed with one key, opened with another → needs_attention, no provider, never sent", async () => {
    const acc = service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: imapCfg("s3cr3t") });
    const sealed = storedPass(acc.id);
    expect(service.getProvider(acc.id)).not.toBeNull();

    service.setProviderContext({ encryptionKey: OTHER_KEY });
    const reg = service.registerAccountProvider(acc.id);
    expect(reg.ok).toBe(false);
    expect(reg.reason).toBe("Stored mail password can't be opened (encryption key changed) — reconnect this mailbox");
    expect(service.getProvider(acc.id)).toBeNull();
    expect(service.openImapConfig(service.getAccount(acc.id)!).pass).not.toBe(sealed);
    expect(service.listAccountsForDisplay().find((a) => a.id === acc.id)!.status).toBe("needs_attention");

    const test = await service.testAccount(acc.id);
    expect(test.ok).toBe(false);
    expect(JSON.stringify(test)).not.toContain(sealed);
  });

  it("wins over read_only: a receive-only account whose password is unreadable needs attention", () => {
    const acc = service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: { ...imapCfg("s3cr3t"), read_only: true } });
    service.setProviderContext({ encryptionKey: OTHER_KEY });
    service.registerAccountProvider(acc.id); // what module init does on the next start
    expect(service.listAccountsForDisplay().find((a) => a.id === acc.id)!.status).toBe("needs_attention");
  });

  it("a legacy plaintext password still works under any key", () => {
    const acc = service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: imapCfg("x") });
    db.prepare("UPDATE email_accounts SET provider_config = ? WHERE id = ?").run(JSON.stringify(imapCfg("legacy-pass")), acc.id);
    service.setProviderContext({ encryptionKey: OTHER_KEY });
    expect(service.openImapConfig(service.getAccount(acc.id)!).pass).toBe("legacy-pass");
    expect(service.registerAccountProvider(acc.id).ok).toBe(true);
  });
});

describe("updateAccount keeps read_only (M9)", () => {
  it("carries read_only over when the incoming config omits it", () => {
    const acc = service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: { ...imapCfg("p"), read_only: true } });
    service.updateAccount(acc.id, { provider_config: JSON.stringify({ ...imapCfg(MASKED_SECRET), imap_port: 143 }) });
    const cfg = JSON.parse(service.getAccount(acc.id)!.provider_config);
    expect(cfg.read_only).toBe(true);
    expect(cfg.imap_port).toBe(143);
  });

  it("an explicit read_only: false still clears it", () => {
    const acc = service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: { ...imapCfg("p"), read_only: true } });
    service.updateAccount(acc.id, { provider_config: JSON.stringify({ ...imapCfg(MASKED_SECRET), read_only: false }) });
    expect(JSON.parse(service.getAccount(acc.id)!.provider_config).read_only).toBe(false);
  });
});

describe("listAccountsForDisplay", () => {
  it("masks pass and api_key and never returns them", () => {
    service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: imapCfg("s3cr3t") });
    service.addAccount({ label: "r", email: "news@x.com", provider: "resend", provider_config: { api_key: "re_123" } });
    const text = JSON.stringify(service.listAccountsForDisplay());
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("re_123");
    for (const a of service.listAccountsForDisplay()) {
      const cfg = JSON.parse(a.provider_config);
      expect(cfg.pass ?? cfg.api_key).toBe(MASKED_SECRET);
    }
  });

  it("reports ok / read_only / needs_attention", () => {
    const ok = service.addAccount({ label: "a", email: "a@x.com", provider: "imap_smtp", provider_config: imapCfg("p") });
    const ro = service.addAccount({ label: "b", email: "b@x.com", provider: "imap_smtp", provider_config: { ...imapCfg("p"), read_only: true } });
    const bad = service.addAccount({ label: "c", email: "c@x.com", provider: "imap_smtp", provider_config: { ...imapCfg("p"), imap_host: "" } });
    const byId = Object.fromEntries(service.listAccountsForDisplay().map((a) => [a.id, a.status]));
    expect(byId[ok.id]).toBe("ok");
    expect(byId[ro.id]).toBe("read_only");
    expect(byId[bad.id]).toBe("needs_attention");
  });

  it("downgrades an ok account to needs_attention once a re-registration fails (Fix round 1, item 4)", () => {
    const acc = service.addAccount({ label: "a", email: "a@x.com", provider: "imap_smtp", provider_config: imapCfg("p") });
    expect(service.listAccountsForDisplay().find((a) => a.id === acc.id)!.status).toBe("ok");

    service.updateAccount(acc.id, { provider_config: JSON.stringify({ ...imapCfg("p"), imap_host: "" }) });
    expect(service.listAccountsForDisplay().find((a) => a.id === acc.id)!.status).toBe("needs_attention");
  });
});

describe("saving a config that came back masked (Review Focus 4)", () => {
  it("keeps the stored pass when the edit form sends the mask or an empty pass", () => {
    const acc = service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: imapCfg("s3cr3t") });
    service.updateAccount(acc.id, { provider_config: JSON.stringify({ ...imapCfg(MASKED_SECRET), imap_port: 143 }) });
    let cfg = service.openImapConfig(service.getAccount(acc.id)!);
    expect(cfg.pass).toBe("s3cr3t");
    expect(cfg.imap_port).toBe(143);

    service.updateAccount(acc.id, { provider_config: JSON.stringify(imapCfg("")) });
    cfg = service.openImapConfig(service.getAccount(acc.id)!);
    expect(cfg.pass).toBe("s3cr3t");
  });

  it("keeps a Resend api_key the same way", () => {
    const acc = service.addAccount({ label: "r", email: "news@x.com", provider: "resend", provider_config: { api_key: "re_123" } });
    service.updateAccount(acc.id, { provider_config: JSON.stringify({ api_key: MASKED_SECRET }) });
    expect(JSON.parse(service.getAccount(acc.id)!.provider_config).api_key).toBe("re_123");
  });

  it("drops the masked placeholder instead of storing it as the secret when nothing was stored before (Fix round 1, item 3)", () => {
    const acc = service.addAccount({ label: "r", email: "news@x.com", provider: "resend", provider_config: {} });
    service.updateAccount(acc.id, { provider_config: JSON.stringify({ api_key: MASKED_SECRET }) });
    const cfg = JSON.parse(service.getAccount(acc.id)!.provider_config);
    expect(cfg.api_key).toBeUndefined();
  });
});

describe("maskAccount (Fix round 1, item 2 — create/update route mask bypass)", () => {
  it("never returns the real IMAP pass or Resend api_key, even right after addAccount", () => {
    const imapAcc = service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: imapCfg("s3cr3t") });
    const resendAcc = service.addAccount({ label: "r", email: "news@x.com", provider: "resend", provider_config: { api_key: "re_123" } });

    const maskedImap = service.maskAccount(service.getAccount(imapAcc.id)!);
    const maskedResend = service.maskAccount(service.getAccount(resendAcc.id)!);

    expect(JSON.stringify(maskedImap)).not.toContain("s3cr3t");
    expect(JSON.parse(maskedImap.provider_config).pass).toBe(MASKED_SECRET);
    expect(JSON.stringify(maskedResend)).not.toContain("re_123");
    expect(JSON.parse(maskedResend.provider_config).api_key).toBe(MASKED_SECRET);
  });

  it("never returns the real secret right after updateAccount either", () => {
    const acc = service.addAccount({ label: "x", email: "maria@x.com", provider: "imap_smtp", provider_config: imapCfg("s3cr3t") });
    const updated = service.updateAccount(acc.id, { provider_config: JSON.stringify({ ...imapCfg(MASKED_SECRET), imap_port: 143 }) })!;
    const masked = service.maskAccount(updated);
    expect(JSON.stringify(masked)).not.toContain("s3cr3t");
    expect(JSON.parse(masked.provider_config).pass).toBe(MASKED_SECRET);
  });
});
