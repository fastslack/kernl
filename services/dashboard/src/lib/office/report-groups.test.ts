import { describe, it, expect } from 'bun:test';
import { groupReports, reportKey, plainPreview } from './report-groups.js';

const r = (agentId: string, text: string, ts: number, runId?: string) => ({
  agentId, agentName: agentId.toUpperCase(), text, color: '#fff', ts, status: 'failed', runId,
});

describe('groupReports', () => {
  it('folds the same failure of the same agent into one group, newest first', () => {
    const groups = groupReports([
      r('imap', 'Stale run cleaned up on startup', 100, 'a'),
      r('imap', 'Stale run cleaned up on startup', 300, 'b'),
      r('scout', 'Reached maximum number of turns (15)', 200, 'c'),
      r('imap', 'Stale run cleaned up on startup', 50, 'd'),
    ]);
    expect(groups.map((g) => [g.agentId, g.count, g.latestTs])).toEqual([
      ['imap', 3, 300],
      ['scout', 1, 200],
    ]);
    expect(groups[0].reports.map((x) => x.runId)).toEqual(['b', 'a', 'd']);
  });

  it('treats ids, numbers and timestamps in the message as the same failure', () => {
    const groups = groupReports([
      r('x', 'Run 61756db5-d2bc-45d6-9fa5-10a5581b7112 failed after 15 turns at 2026-10-02T21:32:00Z', 1),
      r('x', 'Run 28a2a054-2144-4670-a4c0-e1a89bf3dff0 failed after 40 turns at 2026-10-03T01:02:00Z', 2),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
  });

  it('keeps different failures of one agent apart, and the same text of two agents apart', () => {
    expect(groupReports([r('x', 'Timeout', 1), r('x', 'Auth rejected', 2)])).toHaveLength(2);
    expect(groupReports([r('x', 'Timeout', 1), r('y', 'Timeout', 2)])).toHaveLength(2);
  });
});

describe('reportKey', () => {
  it('is the run id, or agent + time when there is none', () => {
    expect(reportKey(r('x', 't', 5, 'run-1'))).toBe('run-1');
    expect(reportKey(r('x', 't', 5))).toBe('x-5');
  });
});

describe('plainPreview', () => {
  it('drops markdown and JSON noise and trims to length', () => {
    expect(plainPreview('**ROOT_CAUSE:** `max_iterations` | {"a":1} too   low', 200)).toBe('ROOT_CAUSE: max_iterations too low');
    expect(plainPreview('a'.repeat(10), 4)).toBe('aaaa…');
  });
});
