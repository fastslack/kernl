/** Kernl's own bug reports: typed calls to /api/kernl/bugs and two pure helpers. */
export type BugStatus = 'new' | 'published' | 'fixed' | 'dismissed';
export interface KernlBug {
  id: string; fingerprint: string; title: string; area: string; diagnosis: string; repro: string;
  context: Record<string, unknown>; source: 'chief' | 'operator'; run_id: string; agent_id: string;
  occurrences: number; status: BugStatus; issue_url: string;
  created_at: string; last_seen_at: string; published_at: string | null;
}

/** A report handed to the Kernl fixer (kernel: kernl-bugs-fix.ts). */
export type FixStatus = 'preparing' | 'running' | 'committing' | 'ready' | 'no_changes' | 'failed' | 'discarded';
export interface KernlFix {
  bug_id: string; status: FixStatus; branch: string; worktree: string; base_sha: string;
  run_id: string; commit_sha: string; files: Array<{ status: string; path: string }>; summary: string; error: string;
  started_at: string; finished_at: string | null;
}
export interface FixPreflight { ok: boolean; reasons: string[] }
export const FIX_ACTIVE: ReadonlySet<FixStatus> = new Set(['preparing', 'running', 'committing']);

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
  /** Reports plus the fix status of each one that has a fix. */
  overview: () => call<{ bugs: KernlBug[]; fixes?: Record<string, FixStatus> }>('GET', '/api/kernl/bugs')
    .then((r) => ({ bugs: r.bugs, fixes: r.fixes ?? {} })),
  fixPreflight: () => call<FixPreflight>('GET', '/api/kernl/bugs/fix/preflight'),
  fix: (id: string) => call<{ fix: KernlFix | null }>('GET', `/api/kernl/bugs/${encodeURIComponent(id)}/fix`).then((r) => r.fix),
  startFix: (id: string) => call<{ fix: KernlFix }>('POST', `/api/kernl/bugs/${encodeURIComponent(id)}/fix`).then((r) => r.fix),
  fixDiff: (id: string) => call<{ diff: string }>('GET', `/api/kernl/bugs/${encodeURIComponent(id)}/fix/diff`).then((r) => r.diff),
  discardFix: (id: string) => call<{ fix: KernlFix }>('DELETE', `/api/kernl/bugs/${encodeURIComponent(id)}/fix`).then((r) => r.fix),
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

/** The list's filter: `open` (new + published) is the default — fixed and dismissed are decided. */
export type BugFilter = 'open' | 'fixed' | 'dismissed' | 'all';

function inFilter(s: BugStatus, f: BugFilter): boolean {
  return f === 'all' || (f === 'open' ? s === 'new' || s === 'published' : s === f);
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Sorted reports for a filter and a search over title, area and diagnosis.
 * `keepId` stays listed whatever the filter: a report marked fixed while open
 * must not vanish from under the operator's cursor.
 */
export function filterBugs(list: KernlBug[], f: BugFilter, query: string, keepId: string | null = null): KernlBug[] {
  const q = fold(query.trim());
  return sortBugs(list).filter((b) =>
    b.id === keepId ||
    (inFilter(b.status, f) && (!q || fold(`${b.title} ${b.area} ${b.diagnosis}`).includes(q))));
}

export function bugCounts(list: KernlBug[]): Record<BugFilter, number> {
  const n = (f: BugFilter) => list.filter((b) => inFilter(b.status, f)).length;
  return { open: n('open'), fixed: n('fixed'), dismissed: n('dismissed'), all: list.length };
}

/** What a row's copy button puts on the clipboard. */
export function bugClipboardText(b: KernlBug): string {
  return [b.title, b.area ? `Area: ${b.area}` : '', b.diagnosis ? `\n${b.diagnosis}` : ''].filter(Boolean).join('\n');
}
