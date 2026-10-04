/** Client for the one-step mail connection (comms extension). */
export type MailAuth = 'password' | 'app_password' | 'oauth_only' | 'bridge';
export interface ServerEndpoint { host: string; port: number; secure: boolean }
export interface Discovery {
  source: 'builtin' | 'autoconfig' | 'ispdb' | 'mx' | 'guess' | 'manual';
  provider: { id: string | null; name: string; auth: MailAuth };
  imap: ServerEndpoint | null;
  smtp: ServerEndpoint | null;
  helpUrl?: string;
}
export type MailStatus = 'ok' | 'read_only' | 'needs_attention';
export interface MailAccount { id: string; email: string; label: string; provider: string; status: MailStatus }
export type MailErrorCode =
  | 'app_password_required' | 'auth_failed' | 'unreachable' | 'tls' | 'timeout'
  | 'oauth_only' | 'bridge' | 'smtp_failed' | 'already_connected' | 'unknown';
export type ConnectResult =
  | { ok: true; account: MailAccount; readOnly: boolean; updated: boolean; code?: 'smtp_failed'; detail?: string }
  | { ok: false; code: MailErrorCode; detail?: string; discovery?: Discovery };
export interface ConnectBody {
  email: string;
  password: string;
  overrides?: { imap: ServerEndpoint; smtp: ServerEndpoint; user?: string };
}

const json = { 'Content-Type': 'application/json' };

// Neither call throws: a dropped connection or a non-JSON body (a proxy error
// page) comes back as "nothing detected" / an unknown failure, so the card
// always leaves its detecting/testing state.
export async function discoverMail(email: string): Promise<Discovery | null> {
  try {
    const r = await fetch('/api/email-accounts/discover', { method: 'POST', headers: json, body: JSON.stringify({ email }) });
    return r.ok ? ((await r.json()) as Discovery) : null;
  } catch {
    return null;
  }
}

export async function connectMail(body: ConnectBody): Promise<ConnectResult> {
  try {
    const r = await fetch('/api/email-accounts/connect', { method: 'POST', headers: json, body: JSON.stringify(body) });
    if (!r.ok) return { ok: false, code: 'unknown', detail: `HTTP ${r.status}` };
    return (await r.json()) as ConnectResult;
  } catch (err) {
    return { ok: false, code: 'unknown', detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function listMailAccounts(): Promise<MailAccount[]> {
  const r = await fetch('/api/email-accounts');
  if (!r.ok) return [];
  const rows = (await r.json()) as MailAccount[];
  return rows.map(({ id, email, label, provider, status }) => ({ id, email, label, provider, status }));
}

export async function fetchGoogleConfigured(): Promise<{ configured: boolean; authUrl?: string }> {
  try {
    const r = await fetch('/api/email-accounts/google-profile');
    if (!r.ok) return { configured: false };
    const p = (await r.json()) as { configured?: boolean; authUrl?: string };
    return { configured: !!p.configured, authUrl: p.authUrl };
  } catch {
    return { configured: false };
  }
}
