import { describe, it, expect } from 'bun:test';
import { explainFailure } from './failure-explain.js';

describe('explainFailure', () => {
  it('a kernel restart is not the agent failing', () => {
    expect(explainFailure('Stale run cleaned up on startup')).toMatchObject({ kind: 'restart', fix: 'retry' });
  });
  it('reads the step limit out of the max-turns error', () => {
    expect(explainFailure('Claude Code returned an error result: Reached maximum number of turns (15)'))
      .toMatchObject({ kind: 'max_turns', params: { n: '15' }, fix: 'settings' });
  });
  it('an expired Claude Code session points at the AI settings', () => {
    expect(explainFailure('Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed'))
      .toMatchObject({ kind: 'auth', fix: 'llm' });
  });
  it('budget, time and provider failures', () => {
    expect(explainFailure('Token budget exceeded (150000)')).toMatchObject({ kind: 'budget', fix: 'settings' });
    expect(explainFailure('Run timed out after 120000ms')).toMatchObject({ kind: 'timeout', fix: 'settings' });
    expect(explainFailure('Safety abort: too many consecutive errors')).toMatchObject({ kind: 'errors', fix: 'settings' });
    expect(explainFailure('No LLM provider in the chain can run tool calls. Dropped: x.')).toMatchObject({ kind: 'provider', fix: 'llm' });
    expect(explainFailure('429 Too Many Requests: rate limit')).toMatchObject({ kind: 'rate', fix: 'retry' });
  });
  it('says so when there is no error text at all', () => {
    expect(explainFailure('')).toMatchObject({ kind: 'unknown' });
    expect(explainFailure('failed')).toMatchObject({ kind: 'unknown' });
  });
  it('falls back to the error itself', () => {
    expect(explainFailure('ENOENT: no such file /x')).toMatchObject({ kind: 'other', fix: 'retry' });
  });
});

import { summarizeRunContext } from './failure-explain.js';
describe('summarizeRunContext', () => {
  it('keeps the goal line, timing and the last thing it did', () => {
    const ctx = summarizeRunContext(
      { goal: '\n**You have 3 unacknowledged letter(s)** in your inbox.\nMore', trigger_type: 'event', steps_count: 36,
        started_at: '2026-10-03T05:00:00Z', completed_at: '2026-10-03T05:04:12Z', error: 'Reached maximum number of turns (15)' },
      [{ type: 'thought', content: 'Leo el inbox' }, { type: 'tool_call', tool_name: 'mcp__kernel__kernel_agents_inbox' }, { type: 'tool_result' }],
    );
    expect(ctx).toEqual({
      goal: 'You have 3 unacknowledged letter(s) in your inbox.', trigger: 'event', steps: 36,
      durationMs: 252000, lastStep: 'kernel_agents_inbox', error: 'Reached maximum number of turns (15)',
    });
  });
  it('copes with a run that never started', () => {
    expect(summarizeRunContext({ goal: '', steps_count: 0, started_at: null, completed_at: null }, []))
      .toMatchObject({ goal: '', steps: 0, durationMs: null, lastStep: '' });
  });
});

describe('summarizeRunContext · cut-short run', () => {
  it('counts recorded steps when steps_count was never updated', () => {
    expect(summarizeRunContext({ steps_count: 0 }, [{ type: 'tool_call', tool_name: 'a' }, { type: 'tool_result' }]).steps).toBe(2);
  });
});
