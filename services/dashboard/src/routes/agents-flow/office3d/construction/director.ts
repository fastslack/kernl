/**
 * Construction director — decides WHEN a new office gets built and in which
 * phase its construction is. Pure state, no Three.js: the scene stage
 * (stage.ts) reads `active()` every frame and draws accordingly.
 *
 * Lifecycle of an office created while the page is open:
 *   pending  — hidden from the floor while its team is still being created
 *              (the Chief's chat adds agents one by one). Its lot reads free.
 *   ready    — the creator said it's done (markReady), or the team stopped
 *              changing for `stableMs`. Waits in a queue: one build at a time.
 *   building — runs TIMELINE, then the office is shown for good.
 *
 * Offices that already existed when the page opened are primed and never
 * animate. An office the kernel never gave a lot is shown at once, unanimated.
 */

export type Phase =
  | 'truck-in'   // construction truck drives in and parks at the stairs
  | 'walk-in'    // the crew walks from the truck to the lot
  | 'build'      // walls rise, then furniture pops in
  | 'walk-out'   // the crew walks back to the truck
  | 'car-in'     // the truck drives off while the agents' car drives in
  | 'agents';    // the agents step out of the car (they walk on to their desks on their own)

export const TIMELINE: ReadonlyArray<{ phase: Phase; duration: number }> = [
  { phase: 'truck-in', duration: 3 },
  { phase: 'walk-in', duration: 3.5 },
  { phase: 'build', duration: 7 },
  { phase: 'walk-out', duration: 3 },
  { phase: 'car-in', duration: 3 },
  { phase: 'agents', duration: 2.5 },
];

export function totalDuration(): number {
  return TIMELINE.reduce((s, p) => s + p.duration, 0);
}

export interface ObservedOffice {
  id: string;
  /** Agents in the office (the top agent excluded). */
  agentCount: number;
  /** Whether the kernel has stored a lot for it. */
  hasLot: boolean;
}

export interface ActiveBuild {
  flowId: string;
  phase: Phase;
  /** 0..1 through the current phase. */
  progress: number;
  /** Seconds since the build started. */
  elapsed: number;
}

type JobState = 'pending' | 'ready' | 'building';

interface Job {
  flowId: string;
  state: JobState;
  agentCount: number;
  hasLot: boolean;
  /** Last time (ms) the team size changed. */
  changedAt: number;
  explicitReady: boolean;
  elapsed: number;
  phaseIdx: number;
  /** Per-build phase lengths (the crew's walk depends on how far the lot is). */
  durations: number[];
}

export function createConstructionDirector(opts: { stableMs?: number } = {}) {
  const stableMs = opts.stableMs ?? 8000;
  const known = new Set<string>();
  /** Offices the creator finished before their first observation reached us. */
  const preReady = new Set<string>();
  const jobs = new Map<string, Job>();
  const queue: string[] = [];
  let current: Job | null = null;
  let primed = false;
  const phaseListeners: Array<(flowId: string, phase: Phase | 'done') => void> = [];
  const changeListeners: Array<() => void> = [];

  const emitPhase = (flowId: string, phase: Phase | 'done') => {
    for (const l of phaseListeners) { try { l(flowId, phase); } catch (err) { console.error('[construction] listener', err); } }
  };
  const emitChange = () => {
    for (const l of changeListeners) { try { l(); } catch (err) { console.error('[construction] listener', err); } }
  };

  function finish(job: Job): void {
    jobs.delete(job.flowId);
    const qi = queue.indexOf(job.flowId);
    if (qi >= 0) queue.splice(qi, 1);
    if (current === job) current = null;
    emitPhase(job.flowId, 'done');
  }

  function startNext(): void {
    while (!current && queue.length > 0) {
      const id = queue.shift()!;
      const job = jobs.get(id);
      if (!job) continue;
      job.state = 'building';
      job.elapsed = 0;
      job.phaseIdx = 0;
      current = job;
      emitChange();
      emitPhase(id, TIMELINE[0].phase);
    }
  }

  function promote(job: Job, now: number): void {
    if (job.state !== 'pending' || job.agentCount <= 0) return;
    const settled = job.explicitReady || now - job.changedAt >= stableMs;
    if (!settled) return;
    if (!job.hasLot) {
      // Nowhere to build: show it at once, as the floor always did.
      finish(job);
      emitChange();
      return;
    }
    job.state = 'ready';
    queue.push(job.flowId);
  }

  return {
    /** The offices on the floor when the page opened — never animated. */
    prime(flowIds: Iterable<string>): void {
      for (const id of flowIds) known.add(id);
      primed = true;
    },

    get primed(): boolean { return primed; },

    /** Feed the current office list. New ids become pending; vanished ones are dropped. */
    observe(offices: ObservedOffice[], now: number): void {
      if (!primed) return;
      const present = new Set(offices.map(o => o.id));
      let changed = false;
      for (const job of [...jobs.values()]) {
        if (!present.has(job.flowId)) { finish(job); changed = true; }
      }
      for (const o of offices) {
        if (known.has(o.id)) continue;
        known.add(o.id);
        jobs.set(o.id, {
          flowId: o.id, state: 'pending', agentCount: o.agentCount, hasLot: o.hasLot,
          changedAt: now, explicitReady: preReady.delete(o.id), elapsed: 0, phaseIdx: 0,
          durations: TIMELINE.map(p => p.duration),
        });
        changed = true;
      }
      for (const o of offices) {
        const job = jobs.get(o.id);
        if (!job || job.state !== 'pending') continue;
        if (job.agentCount !== o.agentCount || job.hasLot !== o.hasLot) {
          job.agentCount = o.agentCount;
          job.hasLot = o.hasLot;
          job.changedAt = now;
        }
      }
      if (changed) emitChange();
    },

    /** Build an office that is already on the floor again (the console demo). */
    replay(flowId: string, agentCount: number): void {
      if (jobs.has(flowId)) return;
      known.add(flowId);
      jobs.set(flowId, {
        flowId, state: 'ready', agentCount, hasLot: true, changedAt: 0, explicitReady: true,
        elapsed: 0, phaseIdx: 0, durations: TIMELINE.map(p => p.duration),
      });
      queue.push(flowId);
      emitChange();
    },

    /** Override phase lengths for one build — only phases not started yet take effect. */
    setDurations(flowId: string, durations: Partial<Record<Phase, number>>): void {
      const job = jobs.get(flowId);
      if (!job) return;
      TIMELINE.forEach((p, i) => {
        const v = durations[p.phase];
        if (v !== undefined && v > 0 && i > job.phaseIdx) job.durations[i] = v;
      });
    },

    /** The wizard or the Chief's chat finished creating this office. */
    markReady(flowId: string): void {
      const job = jobs.get(flowId);
      if (job) job.explicitReady = true;
      else if (!known.has(flowId)) preReady.add(flowId);
    },

    tick(dt: number, now: number): void {
      for (const job of jobs.values()) promote(job, now);
      startNext();
      const job = current;
      if (!job) return;
      job.elapsed += dt;
      let phaseStart = 0;
      for (let i = 0; i < job.phaseIdx; i++) phaseStart += job.durations[i];
      while (job.phaseIdx < TIMELINE.length && job.elapsed >= phaseStart + job.durations[job.phaseIdx]) {
        phaseStart += job.durations[job.phaseIdx];
        job.phaseIdx++;
        if (job.phaseIdx < TIMELINE.length) emitPhase(job.flowId, TIMELINE[job.phaseIdx].phase);
      }
      if (job.phaseIdx >= TIMELINE.length) {
        finish(job);
        emitChange();
        startNext();
      }
    },

    /** Finish every build in flight and every queued one: offices appear done. */
    skip(): void {
      const toFinish = [...jobs.values()].filter(j => j.state !== 'pending');
      if (toFinish.length === 0) return;
      for (const job of toFinish) finish(job);
      emitChange();
    },

    active(): ActiveBuild | null {
      const job = current;
      if (!job) return null;
      let phaseStart = 0;
      for (let i = 0; i < job.phaseIdx; i++) phaseStart += job.durations[i];
      const idx = Math.min(job.phaseIdx, TIMELINE.length - 1);
      return {
        flowId: job.flowId,
        phase: TIMELINE[idx].phase,
        progress: Math.max(0, Math.min(1, (job.elapsed - phaseStart) / job.durations[idx])),
        elapsed: job.elapsed,
      };
    },

    /** Offices not on the floor yet: pending, or queued behind another build. */
    hiddenFlowIds(): Set<string> {
      const out = new Set<string>();
      for (const job of jobs.values()) if (job.state !== 'building') out.add(job.flowId);
      return out;
    },

    /** Something that changes which offices are drawn happened. */
    onChange(cb: () => void): void { changeListeners.push(cb); },
    onPhase(cb: (flowId: string, phase: Phase | 'done') => void): void { phaseListeners.push(cb); },
  };
}

export type ConstructionDirector = ReturnType<typeof createConstructionDirector>;
