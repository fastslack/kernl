/**
 * The chief's office lists what agents report. Failures repeat: a kernel
 * restart files "Stale run cleaned up on startup" once per interrupted run,
 * and 26 cards of the same line hide the one failure that matters. These
 * helpers fold identical failures of one agent into a group the operator can
 * read, send to a fixer, or dismiss in one go.
 */
import type { OfficeReport } from '../../routes/agents-flow/world-types.js';

export interface ReportGroup {
  key: string;
  agentId: string;
  agentName: string;
  color: string;
  /** The newest report's text — what the group card shows. */
  text: string;
  count: number;
  latestTs: number;
  /** Newest first. */
  reports: OfficeReport[];
}

/** Stable identity of one report, as the office lists have always keyed it. */
export function reportKey(r: Pick<OfficeReport, 'runId' | 'agentId' | 'ts'>): string {
  return r.runId ?? `${r.agentId}-${r.ts}`;
}

/** What makes two failures "the same": their first line, ids and numbers blanked. */
function signature(text: string): string {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').trim().toLowerCase();
  return first
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '#')
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

export function groupReports(reports: OfficeReport[]): ReportGroup[] {
  const groups = new Map<string, ReportGroup>();
  for (const r of [...reports].sort((a, b) => b.ts - a.ts)) {
    const key = `${r.agentId}\u0000${signature(r.text)}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.reports.push(r);
    } else {
      groups.set(key, {
        key, agentId: r.agentId, agentName: r.agentName, color: r.color,
        text: r.text, count: 1, latestTs: r.ts, reports: [r],
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.latestTs - a.latestTs);
}

/** A report as one line of plain text: no markdown marks, tables or JSON blobs. */
export function plainPreview(text: string, max: number): string {
  const s = text
    .replace(/[#*`]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
