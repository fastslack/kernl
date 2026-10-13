// src/lib/panels/client.ts
import { apiFetch } from '$lib/api.js';
import type { PanelSpec } from './types.js';

const base = (flowId: string) => `/api/panels/${encodeURIComponent(flowId)}`;

export async function fetchPanel(flowId: string): Promise<{ spec: PanelSpec; updatedAt: string } | null> {
  try { return (await apiFetch(base(flowId))) as { spec: PanelSpec; updatedAt: string }; }
  catch { return null; }
}

export async function readSource(flowId: string, source: string, opts: { select?: string; since?: string; key?: string } = {}):
  Promise<{ version: string; data?: unknown; unchanged?: true }> {
  const q = new URLSearchParams();
  if (opts.select) q.set('select', opts.select);
  if (opts.since) q.set('since', opts.since);
  if (opts.key) q.set('key', opts.key);
  return (await apiFetch(`${base(flowId)}/sources/${encodeURIComponent(source)}?${q}`)) as { version: string; data?: unknown; unchanged?: true };
}

export async function runAction(flowId: string, action: string, values: Record<string, unknown>): Promise<{ ok: boolean; result: string }> {
  return (await apiFetch(`${base(flowId)}/actions/${encodeURIComponent(action)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }),
  })) as { ok: boolean; result: string };
}

export async function fetchAudit(flowId: string): Promise<Array<{ action: string; ok: boolean; result: string; at: string; values: unknown }>> {
  const r = (await apiFetch(`${base(flowId)}/audit?limit=50`)) as { items: Array<{ action: string; ok: boolean; result: string; at: string; values: unknown }> };
  return r.items;
}

/** Poll a source while a view is open; calls onData only when the version moves. Returns a stop function. */
export function pollSource(
  flowId: string, source: string, opts: { select?: string; key?: string },
  onData: (data: unknown, version: string) => void, onError: (msg: string) => void, everyMs = 5000,
): () => void {
  let version: string | undefined;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await readSource(flowId, source, { ...opts, since: version });
      if (!r.unchanged) { version = r.version; onData(r.data, r.version); }
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    if (!stopped) timer = setTimeout(tick, everyMs);
  };
  let timer: ReturnType<typeof setTimeout> = setTimeout(tick, 0);
  return () => { stopped = true; clearTimeout(timer); };
}
