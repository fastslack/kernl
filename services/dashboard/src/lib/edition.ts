/** Client for the personal/business edition (kernel: /api/edition). */
import { apiFetchRaw, readApiError } from '$lib/api.js';

export type Audience = 'personal' | 'business';
export type EditionMode = Audience;

export interface EditionStatus { mode: EditionMode | null; legacy: boolean; parked: number }
export interface EditionSummary extends EditionStatus {
  activated: string[];
  deactivated: string[];
  failed: Array<{ id: string; error: string }>;
}

export async function fetchEdition(): Promise<EditionStatus> {
  const r = await apiFetchRaw('/api/edition', {});
  if (!r.ok) throw new Error((await readApiError(r)) || `HTTP ${r.status}`);
  return r.json();
}

/** `addOnly` makes the choice never turn anything off (Settings always sends it). */
export async function setEdition(mode: EditionMode, opts: { addOnly?: boolean } = {}): Promise<EditionSummary> {
  const r = await apiFetchRaw('/api/edition', { method: 'POST', body: JSON.stringify({ mode, ...opts }) });
  if (!r.ok) throw new Error((await readApiError(r)) || `HTTP ${r.status}`);
  return r.json();
}

/** Absent or empty audience means the extension is for both editions. */
export function audienceOfManifest(m: { audience?: Audience[] } | null | undefined): Audience[] {
  return m?.audience && m.audience.length > 0 ? m.audience : ['personal', 'business'];
}
