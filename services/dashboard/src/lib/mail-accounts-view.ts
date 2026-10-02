/**
 * The email-accounts list as something you can read at a glance: one dense
 * row per mailbox, grouped by domain, with the health that actually matters.
 *
 * An account row's own `status` only says the account record is usable; it
 * stays "ok" while the mailbox fails to sync. Whether mail is arriving lives
 * in /api/emails/sync-status, so health is read from there. Pure — no fetch,
 * no Svelte.
 */

export interface AccountRecord {
  id: string;
  label: string;
  email: string;
  type: string;
  provider: string;
  company?: string;
  is_default: number | boolean;
  provider_config?: string;
}

export interface SyncEntry {
  account_id: string;
  stored: number;
  fetch: {
    state?: string;
    error?: string | null;
    started_at?: string;
    finished_at?: string;
    done?: number;
  } | null;
}

export type HealthState = 'ok' | 'error' | 'syncing' | 'never';

export interface Health {
  state: HealthState;
  /** Two or three words for the row. */
  text: string;
  /** The full story for the tooltip and the expanded row. */
  detail: string;
  /** When it last finished (or started, while syncing). */
  at: string;
}

export interface AccountRow<A extends AccountRecord = AccountRecord> {
  id: string;
  name: string;
  email: string;
  domain: string;
  type: string;
  provider: string;
  company: string;
  isDefault: boolean;
  stored: number;
  unread: number;
  health: Health;
  servers: { imap: string; smtp: string; user: string } | null;
  account: A;
}

export interface AccountGroup<A extends AccountRecord = AccountRecord> {
  domain: string;
  rows: AccountRow<A>[];
  failing: number;
}

export interface AccountSummary {
  total: number;
  healthy: number;
  failing: number;
  syncing: number;
  stored: number;
  unread: number;
}

export type AccountFilter = 'all' | 'problems' | 'personal' | 'work' | 'transactional' | 'marketing';

/** "VPS admin@matware.nl" → "admin": the boilerplate label repeats the email. */
export function displayName(label: string, email: string): string {
  const l = label.trim();
  if (!l || l === email || l.endsWith(email)) return email.split('@')[0] || email;
  return l;
}

function domainOf(email: string): string {
  return (email.split('@')[1] || email).toLowerCase();
}

/** Turns an imapflow/nodemailer error into the few words a row can hold. */
function shortError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('establish connection') || m.includes('timeout') || m.includes('timed out') || m.includes('econnrefused') || m.includes('enotfound')) return "Can't connect";
  if (m.includes('auth') || m.includes('login') || m.includes('credentials') || m.includes('password')) return 'Login rejected';
  if (m.includes('certificate') || m.includes('tls') || m.includes('ssl')) return 'TLS problem';
  return 'Sync failed';
}

function healthOf(s: SyncEntry | undefined): Health {
  const f = s?.fetch ?? null;
  const stored = s?.stored ?? 0;
  if (f?.state === 'error') {
    const err = String(f.error ?? 'Unknown error');
    return { state: 'error', text: shortError(err), detail: err, at: f.finished_at ?? f.started_at ?? '' };
  }
  if (f && f.state && f.state !== 'ok' && f.state !== 'done') {
    return { state: 'syncing', text: 'Syncing…', detail: 'Fetching new mail now.', at: f.started_at ?? '' };
  }
  if (f) return { state: 'ok', text: 'Synced', detail: 'Last sync finished without errors.', at: f.finished_at ?? '' };
  // No fetch record: Gmail syncs through its own pipeline; anything with mail stored is fine.
  if (stored > 0) return { state: 'ok', text: 'Up to date', detail: 'Mail is arriving.', at: '' };
  return { state: 'never', text: 'Not synced yet', detail: 'No sync has run for this mailbox yet.', at: '' };
}

function serversOf(a: AccountRecord): AccountRow['servers'] {
  if (a.provider !== 'imap_smtp') return null;
  try {
    const c = JSON.parse(a.provider_config || '{}');
    const ep = (host: unknown, port: unknown, secure: unknown) =>
      host ? `${host}:${port ?? '?'}${secure ? ' · TLS' : ''}` : '—';
    return {
      imap: ep(c.imap_host, c.imap_port, c.imap_secure),
      smtp: ep(c.smtp_host, c.smtp_port, c.smtp_secure),
      user: String(c.user ?? ''),
    };
  } catch {
    return null;
  }
}

const HEALTH_ORDER: Record<HealthState, number> = { error: 0, never: 1, syncing: 2, ok: 3 };

export function buildAccountView<A extends AccountRecord>(
  accounts: A[],
  sync: SyncEntry[],
  unread: Record<string, number>,
): { groups: AccountGroup<A>[]; summary: AccountSummary } {
  const syncById = new Map(sync.map((s) => [s.account_id, s]));
  const rows: AccountRow<A>[] = accounts.map((a) => {
    const s = syncById.get(a.id);
    return {
      id: a.id,
      name: displayName(a.label, a.email),
      email: a.email,
      domain: domainOf(a.email),
      type: a.type,
      provider: a.provider,
      company: a.company ?? '',
      isDefault: !!a.is_default,
      stored: s?.stored ?? 0,
      unread: unread[a.id] ?? 0,
      health: healthOf(s),
      servers: serversOf(a),
      account: a,
    };
  });

  const byDomain = new Map<string, AccountRow<A>[]>();
  for (const r of rows) byDomain.set(r.domain, [...(byDomain.get(r.domain) ?? []), r]);
  const groups: AccountGroup<A>[] = [...byDomain.entries()].map(([domain, list]) => ({
    domain,
    rows: list.sort((x, y) =>
      HEALTH_ORDER[x.health.state] - HEALTH_ORDER[y.health.state] || x.name.localeCompare(y.name)),
    failing: list.filter((r) => r.health.state === 'error').length,
  }));
  groups.sort((x, y) => {
    const dx = x.rows.some((r) => r.isDefault) ? 0 : 1;
    const dy = y.rows.some((r) => r.isDefault) ? 0 : 1;
    return dx - dy || x.domain.localeCompare(y.domain);
  });

  const summary: AccountSummary = {
    total: rows.length,
    healthy: rows.filter((r) => r.health.state === 'ok').length,
    failing: rows.filter((r) => r.health.state === 'error').length,
    syncing: rows.filter((r) => r.health.state === 'syncing').length,
    stored: rows.reduce((n, r) => n + r.stored, 0),
    unread: rows.reduce((n, r) => n + r.unread, 0),
  };
  return { groups, summary };
}

export function filterGroups<A extends AccountRecord>(groups: AccountGroup<A>[], filter: AccountFilter, query: string): AccountGroup<A>[] {
  const q = query.trim().toLowerCase();
  const keep = (r: AccountRow<A>) =>
    (filter === 'all' || (filter === 'problems' ? r.health.state === 'error' || r.health.state === 'never' : r.type === filter)) &&
    (!q || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q) || r.domain.includes(q));
  return groups
    .map((g) => ({ ...g, rows: g.rows.filter(keep) }))
    .filter((g) => g.rows.length > 0);
}
