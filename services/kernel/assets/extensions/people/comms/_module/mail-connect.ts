/**
 * Connect a mailbox from an address and a password: find its servers, prove
 * the credentials work, and only then save the account. A failed test leaves
 * nothing behind; a mailbox that can read but not send is saved receive-only.
 */
import { log } from "@kernl/extension-sdk";
import type { CommsService } from "./service.js";
import type { EmailAccountView } from "./types.js";
import type { Discovery } from "./mail-discovery.js";
import type { ServerEndpoint } from "./mail-providers.js";
import type { ImapSmtpConfig, VerifyOptions, VerifyResult } from "./providers/imap-smtp-provider.js";
import { classifyMailError, errorDetail, type MailErrorCode } from "./mail-errors.js";

export interface ConnectInput {
  email: string;
  password: string;
  overrides?: { imap: ServerEndpoint; smtp: ServerEndpoint; user?: string };
}

export type ConnectResult =
  | { ok: true; account: EmailAccountView; readOnly: boolean; updated: boolean; code?: "smtp_failed"; detail?: string }
  | { ok: false; code: MailErrorCode; detail?: string; discovery?: Discovery };

export interface ConnectDeps {
  comms: Pick<CommsService, "addAccount" | "updateAccount" | "getAccountByEmail" | "listAccountsForDisplay">;
  discover: (email: string) => Promise<Discovery>;
  verify: (cfg: ImapSmtpConfig, opts?: VerifyOptions) => Promise<VerifyResult>;
  pullRecent?: (accountId: string) => Promise<unknown>;
}

export async function connectMailAccount(input: ConnectInput, deps: ConnectDeps): Promise<ConnectResult> {
  const { email } = input;

  const existing = deps.comms.getAccountByEmail(email);
  if (existing && existing.provider !== "imap_smtp") return { ok: false, code: "already_connected" };

  const discovery: Discovery = input.overrides
    ? {
        source: "manual",
        provider: { id: null, name: email.split("@")[1], auth: "password" },
        imap: input.overrides.imap,
        smtp: input.overrides.smtp,
      }
    : await deps.discover(email);

  if (discovery.provider.auth === "oauth_only") return { ok: false, code: "oauth_only", discovery };
  if (discovery.provider.auth === "bridge" && !input.overrides) return { ok: false, code: "bridge", discovery };
  if (!discovery.imap || !discovery.smtp) return { ok: false, code: "unreachable", discovery };

  const pass = discovery.provider.auth === "app_password" ? input.password.replace(/\s+/g, "") : input.password;
  const cfg: ImapSmtpConfig = {
    imap_host: discovery.imap.host,
    imap_port: discovery.imap.port,
    imap_secure: discovery.imap.secure,
    smtp_host: discovery.smtp.host,
    smtp_port: discovery.smtp.port,
    smtp_secure: discovery.smtp.secure,
    user: input.overrides?.user || email,
    pass,
    from: email,
  };

  const result = await deps.verify(cfg, { skipSmtpOnImapFailure: true });
  if (!result.imap) {
    return {
      ok: false,
      code: classifyMailError(result.imapError, discovery.provider.auth, discovery.imap),
      detail: errorDetail(result.imapError, pass),
      discovery,
    };
  }

  const readOnly = !result.smtp;
  const saved: ImapSmtpConfig = { ...cfg, read_only: readOnly };
  let accountId: string;
  let updated = false;
  if (existing) {
    deps.comms.updateAccount(existing.id, { provider_config: JSON.stringify(saved) });
    accountId = existing.id;
    updated = true;
  } else {
    accountId = deps.comms.addAccount({
      label: email, email, type: "personal", provider: "imap_smtp",
      provider_config: saved as unknown as Record<string, unknown>,
    }).id;
  }

  if (deps.pullRecent) {
    void deps.pullRecent(accountId).catch((err) =>
      log.warn(`Comms: first read of ${email} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  const account = deps.comms.listAccountsForDisplay().find((a) => a.id === accountId)!;
  return readOnly
    ? { ok: true, account, readOnly, updated, code: "smtp_failed", detail: errorDetail(result.smtpError, pass) }
    : { ok: true, account, readOnly, updated };
}
