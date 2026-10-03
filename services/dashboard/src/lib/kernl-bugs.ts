/** Kernl's own bug reports: typed calls to /api/kernl/bugs and two pure helpers. */
export type BugStatus = 'new' | 'published' | 'fixed' | 'dismissed';
export interface KernlBug {
  id: string; fingerprint: string; title: string; area: string; diagnosis: string; repro: string;
  context: Record<string, unknown>; source: 'chief' | 'operator'; run_id: string; agent_id: string;
  occurrences: number; status: BugStatus; issue_url: string;
  created_at: string; last_seen_at: string; published_at: string | null;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((json as { error?: string }).error || `HTTP ${r.status}`);
  return json as T;
}

export const bugsApi = {
  list: () => call<{ bugs: KernlBug[] }>('GET', '/api/kernl/bugs').then((r) => r.bugs),
  get: (id: string) => call<{ bug: KernlBug; issue_preview: { title: string; body: string; labels: string[] } }>('GET', `/api/kernl/bugs/${encodeURIComponent(id)}`),
  reportRun: (runId: string, opts: { askChief: boolean; note?: string }) =>
    call<{ bug: KernlBug; repeat: boolean }>('POST', '/api/kernl/bugs', { run_id: runId, ask_chief: opts.askChief, note: opts.note }),
  update: (id: string, patch: Partial<Pick<KernlBug, 'title' | 'area' | 'diagnosis' | 'repro' | 'status'>>) =>
    call<{ bug: KernlBug }>('PUT', `/api/kernl/bugs/${encodeURIComponent(id)}`, patch).then((r) => r.bug),
  publish: (id: string) => call<{ bug: KernlBug }>('POST', `/api/kernl/bugs/${encodeURIComponent(id)}/publish`).then((r) => r.bug),
  settings: () => call<{ repo: string; token_set: boolean }>('GET', '/api/kernl/bugs/settings'),
  saveSettings: (s: { repo?: string; token?: string }) => call<{ repo: string; token_set: boolean }>('PUT', '/api/kernl/bugs/settings', s),
  testSettings: () => call<{ ok: boolean }>('POST', '/api/kernl/bugs/settings/test').then(() => undefined),
};

const ORDER: Record<BugStatus, number> = { new: 0, published: 1, fixed: 2, dismissed: 3 };
export function sortBugs(list: KernlBug[]): KernlBug[] {
  return [...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.last_seen_at < b.last_seen_at ? 1 : -1));
}
export function statusTone(s: BugStatus): 'warn' | 'info' | 'ok' | 'muted' {
  return s === 'new' ? 'warn' : s === 'published' ? 'info' : s === 'fixed' ? 'ok' : 'muted';
}
