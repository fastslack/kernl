/**
 * Small display formatters shared by the agent surfaces.
 *
 * These lived inside AgentWorld3D.svelte, and TriggeringSection.svelte kept a
 * byte-identical copy of `fmtRelTime` under a comment that admitted as much
 * ("Copies of the 3D world's own formatters"). One definition, both callers.
 */

/** "3m ago" / "in 2h" / "—" when there is no timestamp. */
export function fmtRelTime(iso?: string): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const d = Date.now() - t;
  if (d < 0) {
    const f = -d;
    if (f < 60_000) return `in ${Math.round(f / 1000)}s`;
    if (f < 3_600_000) return `in ${Math.round(f / 60_000)}m`;
    return `in ${Math.round(f / 3_600_000)}h`;
  }
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

/** Token count for panels: "999", "1.2k". Returns "0" for nothing. */
export function fmtTokens(n?: number): string {
  if (!n || n < 1000) return String(n ?? 0);
  return (n / 1000).toFixed(1) + 'k';
}

/** Wall-clock HH:MM:SS in the viewer's locale, or '' when unparseable. */
export function fmtClock(ts: string | undefined): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return ''; }
}

/** Accent colour per run trigger type. */
export function triggerColor(t: string): string {
  switch (t) {
    case 'manual': return '#a78bfa';
    case 'chain': return '#3dd6c8';
    case 'schedule': return '#fbbf24';
    case 'event': return '#f472b6';
    default: return '#8a8fa8';
  }
}

/** Collapse whitespace and clip to `n` chars with an ellipsis. */
export function ellipsize(s: string, n: number): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
