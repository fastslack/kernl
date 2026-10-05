import { describe, it, expect } from 'bun:test';
import { createDemolitionDirector, DEMOLITION_TIMELINE } from './demolition.js';

const total = DEMOLITION_TIMELINE.reduce((s, p) => s + p.duration, 0);
const always = () => true;

function run(d: ReturnType<typeof createDemolitionDirector>, seconds: number, canStart = always, step = 0.1) {
  for (let s = 0; s < seconds; s += step) d.tick(step, canStart);
}

describe('demolition director', () => {
  it('waits for the office to be on the floor before starting', () => {
    const d = createDemolitionDirector();
    d.request('a');
    run(d, 2, () => false);
    expect(d.active()).toBeNull();
    expect(d.pending()).toEqual(['a']);
    d.tick(0.1, always);
    expect(d.active()).toEqual({ flowId: 'a', phase: 'truck-in', progress: 0 });
  });

  it('runs every phase in order and reports done', () => {
    const d = createDemolitionDirector();
    const seen: string[] = [];
    d.onPhase((id, phase) => seen.push(`${id}:${phase}`));
    d.request('a');
    run(d, total + 1);
    expect(seen).toEqual([...DEMOLITION_TIMELINE.map(p => `a:${p.phase}`), 'a:done']);
    expect(d.active()).toBeNull();
    expect(d.pending()).toEqual([]);
  });

  it('blows offices up one at a time', () => {
    const d = createDemolitionDirector();
    d.request('a');
    d.request('b');
    d.request('a'); // already queued
    run(d, 1);
    expect(d.active()?.flowId).toBe('a');
    expect(d.pending()).toEqual(['a', 'b']);
    run(d, total + 0.5);
    expect(d.active()?.flowId).toBe('b');
  });

  it('skip reports every demolition done', () => {
    const d = createDemolitionDirector();
    const done: string[] = [];
    d.onPhase((id, phase) => { if (phase === 'done') done.push(id); });
    d.request('a');
    d.request('b');
    run(d, 1);
    d.skip();
    expect(done).toEqual(['a', 'b']);
    expect(d.pending()).toEqual([]);
  });

  it('setDurations only stretches phases not started yet', () => {
    const d = createDemolitionDirector();
    d.request('a');
    d.tick(0.1, always);
    d.setDurations('a', { 'truck-in': 99, 'walk-in': 10 });
    run(d, 3.1);
    expect(d.active()?.phase).toBe('walk-in');
    run(d, 9);
    expect(d.active()?.phase).toBe('walk-in');
  });
});
