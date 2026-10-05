/**
 * Demolition director — the phases of blowing up a deleted office. Pure
 * state, no Three.js: the demolition stage (demolition-stage.ts) reads
 * `active()` every frame and draws accordingly.
 *
 * The office is already gone in the kernel when this starts; the page keeps
 * a ghost of it on the world's floor until `onDone` fires, then drops it and
 * the lot shows up free.
 */

export type DemolitionPhase =
  | 'truck-in'   // the crew's truck drives in and parks at the stairs
  | 'walk-in'    // the crew walks from the truck to the office
  | 'plant'      // dynamite goes up against every wall
  | 'walk-out'   // the crew hurries out
  | 'countdown'  // the fuses burn
  | 'boom'       // the office blows apart
  | 'dust'       // debris falls, smoke settles, the truck drives off
  ;

export const DEMOLITION_TIMELINE: ReadonlyArray<{ phase: DemolitionPhase; duration: number }> = [
  { phase: 'truck-in', duration: 3 },
  { phase: 'walk-in', duration: 3.5 },
  { phase: 'plant', duration: 4 },
  { phase: 'walk-out', duration: 3 },
  { phase: 'countdown', duration: 2.5 },
  { phase: 'boom', duration: 1.4 },
  { phase: 'dust', duration: 4 },
];

export interface ActiveDemolition {
  flowId: string;
  phase: DemolitionPhase;
  /** 0..1 through the current phase. */
  progress: number;
}

interface Job {
  flowId: string;
  elapsed: number;
  phaseIdx: number;
  durations: number[];
}

export function createDemolitionDirector() {
  /** Requested demolitions, run one at a time in order. */
  const queue: string[] = [];
  let current: Job | null = null;
  const phaseListeners: Array<(flowId: string, phase: DemolitionPhase | 'done') => void> = [];

  const emit = (flowId: string, phase: DemolitionPhase | 'done') => {
    for (const l of phaseListeners) { try { l(flowId, phase); } catch (err) { console.error('[demolition] listener', err); } }
  };

  function finish(): void {
    if (!current) return;
    const id = current.flowId;
    current = null;
    emit(id, 'done');
  }

  return {
    /** Blow this office up once the ones already requested are done. */
    request(flowId: string): void {
      if (current?.flowId === flowId || queue.includes(flowId)) return;
      queue.push(flowId);
    },

    /** Offices requested or being demolished — the page keeps their ghosts. */
    pending(): string[] {
      return [...(current ? [current.flowId] : []), ...queue];
    },

    /**
     * Advance. `canStart(id)` says whether the office is on the floor yet (the
     * world may still be mounting); a queued demolition waits for it.
     */
    tick(dt: number, canStart: (flowId: string) => boolean): void {
      if (!current && queue.length > 0 && canStart(queue[0])) {
        current = { flowId: queue.shift()!, elapsed: 0, phaseIdx: 0, durations: DEMOLITION_TIMELINE.map(p => p.duration) };
        emit(current.flowId, DEMOLITION_TIMELINE[0].phase);
        return;
      }
      const job = current;
      if (!job) return;
      job.elapsed += dt;
      let phaseStart = 0;
      for (let i = 0; i < job.phaseIdx; i++) phaseStart += job.durations[i];
      while (job.phaseIdx < DEMOLITION_TIMELINE.length && job.elapsed >= phaseStart + job.durations[job.phaseIdx]) {
        phaseStart += job.durations[job.phaseIdx];
        job.phaseIdx++;
        if (job.phaseIdx < DEMOLITION_TIMELINE.length) emit(job.flowId, DEMOLITION_TIMELINE[job.phaseIdx].phase);
      }
      if (job.phaseIdx >= DEMOLITION_TIMELINE.length) finish();
    },

    /** Override phase lengths for the running demolition — only phases not started yet take effect. */
    setDurations(flowId: string, durations: Partial<Record<DemolitionPhase, number>>): void {
      const job = current;
      if (!job || job.flowId !== flowId) return;
      DEMOLITION_TIMELINE.forEach((p, i) => {
        const v = durations[p.phase];
        if (v !== undefined && v > 0 && i > job.phaseIdx) job.durations[i] = v;
      });
    },

    /** End everything now: the running one and every queued one report done. */
    skip(): void {
      finish();
      while (queue.length) emit(queue.shift()!, 'done');
    },

    active(): ActiveDemolition | null {
      const job = current;
      if (!job) return null;
      let phaseStart = 0;
      for (let i = 0; i < job.phaseIdx; i++) phaseStart += job.durations[i];
      const idx = Math.min(job.phaseIdx, DEMOLITION_TIMELINE.length - 1);
      return {
        flowId: job.flowId,
        phase: DEMOLITION_TIMELINE[idx].phase,
        progress: Math.max(0, Math.min(1, (job.elapsed - phaseStart) / job.durations[idx])),
      };
    },

    onPhase(cb: (flowId: string, phase: DemolitionPhase | 'done') => void): void { phaseListeners.push(cb); },
  };
}

export type DemolitionDirector = ReturnType<typeof createDemolitionDirector>;
