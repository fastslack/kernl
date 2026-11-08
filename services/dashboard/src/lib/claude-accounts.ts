/**
 * Claude Code subscription accounts, client side: the shapes the kernel's
 * /api/llm/claude-code/accounts routes answer with and the pure helpers the
 * accounts list uses to say, in one short phrase, what state each is in.
 */

import type { CatalogProvider } from "./llm-connect.js";

export interface ClaudeLimit {
  /** "*" = the whole account; otherwise the model the limit applies to. */
  model: string;
  until: string;
  detail: string;
}

export interface ClaudeAccount {
  id: string;
  label: string;
  connected: boolean;
  primary: boolean;
  identity: { email?: string; organizationName?: string } | null;
  down: boolean;
  limits: ClaudeLimit[];
}

export type AccountState =
  | { kind: 'disconnected' }
  | { kind: 'down' }
  | { kind: 'limited'; model: string | null; until: string }
  | { kind: 'ok' };

/** The family name of a model id ("claude-opus-5-5" -> "Opus"); the id itself when it has none. */
export function modelFamily(model: string): string {
  const m = /(opus|sonnet|haiku|fable)/i.exec(model);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : model;
}

/** "15:00" for today, "lun 15:00" for any other day. Local time. */
export function formatUntil(iso: string, now: number, locale: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  const day = d.toLocaleDateString(locale, { weekday: 'short' }).replace(/\.$/, '');
  return `${day} ${time}`;
}

/**
 * What to tell the operator about an account. Not connected beats everything
 * (nothing else matters yet), a dead session beats a limit (it is the one that
 * needs an action), and a whole-account limit beats a model one. Limits that
 * ended since the last poll are ignored.
 */
export function accountState(a: ClaudeAccount, now: number): AccountState {
  if (!a.connected) return { kind: 'disconnected' };
  if (a.down) return { kind: 'down' };
  const live = a.limits.filter((l) => Date.parse(l.until) > now);
  if (live.length) {
    const whole = live.find((l) => l.model === '*');
    if (whole) return { kind: 'limited', model: null, until: whole.until };
    const first = [...live].sort((x, y) => Date.parse(x.until) - Date.parse(y.until))[0];
    return { kind: 'limited', model: modelFamily(first.model), until: first.until };
  }
  return { kind: 'ok' };
}

/** The row's title: the label, else the email, else "Account N". */
export function accountTitle(a: ClaudeAccount): { name: string; unnamed: boolean } {
  const label = a.label.trim();
  if (label) return { name: label, unnamed: false };
  const email = a.identity?.email?.trim();
  if (email) return { name: email, unnamed: false };
  return { name: '', unnamed: true };
}

/** The muted second part: email and organization, without repeating the email already used as the title. */
export function accountDetail(a: ClaudeAccount): string {
  const email = a.identity?.email?.trim() ?? '';
  const org = a.identity?.organizationName?.trim() ?? '';
  const showEmail = a.label.trim() ? email : '';
  return [showEmail, org].filter(Boolean).join(' · ');
}

/** Whether the catalog lists Claude Code as connected; decides if the accounts are worth asking for. */
export function isClaudeConnected(providers: CatalogProvider[]): boolean {
  return providers.some((p) => p.slug === "claude-code" && p.connected);
}

/** Email and organization for a row whose name is not the email (always shown, unlike accountDetail). */
export function accountIdent(a: ClaudeAccount): string {
  return [a.identity?.email?.trim(), a.identity?.organizationName?.trim()].filter(Boolean).join(" · ");
}

/** A line of "Tus conexiones": a provider, or one more Claude Code account below the Claude Code row. */
export interface ConnectionLine {
  key: string;
  provider: CatalogProvider;
  /** The Claude Code account this line stands for (null for every other provider). */
  account: ClaudeAccount | null;
  /** Position in the accounts list, which is the rotation order. */
  index: number;
  /** An account row of its own, as opposed to the Claude Code provider row (which is the primary account). */
  extra: boolean;
  /** 2+ accounts: the primary row shows its chip and the account menu. */
  multi: boolean;
}

/**
 * The connection rows with the Claude Code accounts folded in: the existing
 * Claude Code row stands for the primary account (accounts[0]) and every other
 * account follows right below it. With no accounts (old kernel, or none listed)
 * or no connected Claude Code row the list is exactly what it was.
 */
export function withClaudeAccounts(rows: CatalogProvider[], accounts: ClaudeAccount[]): ConnectionLine[] {
  const multi = accounts.length > 1;
  const out: ConnectionLine[] = [];
  for (const provider of rows) {
    if (provider.slug !== "claude-code" || accounts.length === 0) {
      out.push({ key: provider.slug, provider, account: null, index: -1, extra: false, multi: false });
      continue;
    }
    out.push({ key: provider.slug, provider, account: accounts[0], index: 0, extra: false, multi });
    accounts.slice(1).forEach((account, i) => {
      out.push({ key: `claude-code:${account.id}`, provider, account, index: i + 1, extra: true, multi });
    });
  }
  return out;
}
