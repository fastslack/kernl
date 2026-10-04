import { describe, it, expect } from 'bun:test';
import { createConstructionDirector, TIMELINE, totalDuration } from './director.js';

const office = (id: string, agentCount: number, hasLot = true) => ({ id, agentCount, hasLot });

function run(d: ReturnType<typeof createConstructionDirector>, seconds: number, now: { t: number }, step = 0.1) {
  for (let s = 0; s < seconds; s += step) {
    now.t += step * 1000;
    d.tick(step, now.t);
  }
}

describe('construction director', () => {
  it('never animates the offices that existed when the page opened', () => {
    const d = createConstructionDirector();
    d.prime(['a', 'b']);
    d.observe([office('a', 3), office('b', 2)], 0);
    expect(d.hiddenFlowIds().size).toBe(0);
    expect(d.active()).toBeNull();
  });

  it('hides a new office until its team stops changing', () => {
    const d = createConstructionDirector({ stableMs: 8000 });
    d.prime([]);
    const now = { t: 0 };
    d.observe([office('n', 1)], now.t);
    expect(d.hiddenFlowIds().has('n')).toBe(true);
    run(d, 4, now);
    d.observe([office('n', 2)], now.t); // another agent arrived — the clock restarts
    run(d, 6, now);
    expect(d.active()).toBeNull();
    run(d, 3, now);
    expect(d.active()?.flowId).toBe('n');
    expect(d.active()?.phase).toBe('truck-in');
  });

  it('starts at once when the creator says it is done', () => {
    const d = createConstructionDirector();
    d.prime([]);
    d.observe([office('n', 4)], 0);
    d.markReady('n');
    d.tick(0.016, 16);
    expect(d.active()?.flowId).toBe('n');
  });

  it('runs the phases in order and ends with the office shown', () => {
    const d = createConstructionDirector();
    d.prime([]);
    const now = { t: 0 };
    d.observe([office('n', 4)], 0);
    d.markReady('n');
    const seen: string[] = [];
    d.onPhase((flowId, phase) => seen.push(phase));
    run(d, totalDuration() + 1, now);
    expect(seen).toEqual([...TIMELINE.map((p) => p.phase), 'done']);
    expect(d.active()).toBeNull();
    expect(d.hiddenFlowIds().size).toBe(0);
  });

  it('builds one office at a time', () => {
    const d = createConstructionDirector();
    d.prime([]);
    const now = { t: 0 };
    d.observe([office('a', 2), office('b', 2)], 0);
    d.markReady('a');
    d.markReady('b');
    d.tick(0.1, 100);
    expect(d.active()?.flowId).toBe('a');
    expect(d.hiddenFlowIds().has('b')).toBe(true);
    run(d, totalDuration() + 0.5, now);
    expect(d.active()?.flowId).toBe('b');
  });

  it('skip finishes everything in flight', () => {
    const d = createConstructionDirector();
    d.prime([]);
    d.observe([office('a', 2), office('b', 2)], 0);
    d.markReady('a');
    d.markReady('b');
    d.tick(0.1, 100);
    d.skip();
    expect(d.active()).toBeNull();
    expect(d.hiddenFlowIds().size).toBe(0);
  });

  it('shows an office with no lot without animating it', () => {
    const d = createConstructionDirector({ stableMs: 1000 });
    d.prime([]);
    const now = { t: 0 };
    d.observe([office('n', 2, false)], 0);
    run(d, 1.5, now);
    expect(d.active()).toBeNull();
    expect(d.hiddenFlowIds().size).toBe(0);
  });

  it('drops an office deleted mid-build', () => {
    const d = createConstructionDirector();
    d.prime([]);
    d.observe([office('n', 2)], 0);
    d.markReady('n');
    d.tick(0.1, 100);
    d.observe([], 200);
    expect(d.active()).toBeNull();
    expect(d.hiddenFlowIds().size).toBe(0);
  });

  it('reports progress inside the current phase', () => {
    const d = createConstructionDirector();
    d.prime([]);
    d.observe([office('n', 2)], 0);
    d.markReady('n');
    const first = TIMELINE[0];
    d.tick(first.duration / 2, 1);
    expect(d.active()!.progress).toBeCloseTo(0.5, 1);
  });

  it('keeps empty offices hidden — nothing to build yet', () => {
    const d = createConstructionDirector({ stableMs: 1000 });
    d.prime([]);
    const now = { t: 0 };
    d.observe([office('n', 0, false)], 0);
    run(d, 3, now);
    expect(d.active()).toBeNull();
  });
});

describe('construction director — per-build timing', () => {
	it('stretches a phase that has not started yet', () => {
		const d = createConstructionDirector();
		d.prime([]);
		d.observe([office('n', 2)], 0);
		d.markReady('n');
		d.tick(0.01, 10);
		d.setDurations('n', { 'walk-in': 10 });
		const now = { t: 10 };
		run(d, TIMELINE[0].duration + 5, now);
		expect(d.active()?.phase).toBe('walk-in');
	});
});

describe('construction director — creator finishes first', () => {
	it('remembers a ready office it has not seen yet', () => {
		const d = createConstructionDirector();
		d.prime([]);
		d.markReady('n');
		d.observe([office('n', 3)], 0);
		d.tick(0.016, 16);
		expect(d.active()?.flowId).toBe('n');
	});
});

describe('construction director — replay', () => {
	it('rebuilds an office that is already on the floor', () => {
		const d = createConstructionDirector();
		d.prime(['a']);
		d.observe([office('a', 3)], 0);
		d.replay('a', 3);
		expect(d.hiddenFlowIds().has('a')).toBe(true);
		d.tick(0.016, 16);
		expect(d.active()?.flowId).toBe('a');
	});
});
