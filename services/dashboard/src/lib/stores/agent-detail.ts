/**
 * The drawer's view of one agent.
 *
 * Owns its data instead of receiving two half-rows from whoever mounted it:
 * the 3D world's agent list and GET /api/agents/:id used to feed the same
 * visual grid with different refresh profiles. Merged here, once.
 *
 * A store rather than props because the 3D world keeps reading the agent
 * (node colour, chain highlight, alert badge) while the drawer edits it. With
 * props every change would have to be pumped up and handed back down; with a
 * store both read the same truth and `patch()` is the only writer.
 */

import { writable } from "svelte/store";
// Ruta relativa, NO `$lib/api.js`: `bun test` no resuelve el alias de SvelteKit
// (verificado: "Cannot find module '$lib/api.js'"), y por eso los cinco módulos
// del repo que tienen test importan siempre relativo. Vite resuelve las dos igual.
import { updateAgent } from "../api.js";

type Row = Record<string, unknown>;

export interface AgentDetailState {
  agent: Row | null;
  runs: unknown[];
  triggers: unknown[];
  schedules: unknown[];
  connections: unknown;
  loading: boolean;
  /** Last write error, shown on the field that failed. */
  error: string;
  /** Fields with a write in flight, so the UI can mark them busy. */
  saving: Set<string>;
}

/**
 * Merge the list row and the detail row into one agent.
 *
 * Not a spread: `{...list, ...detail}` lets an absent detail field overwrite a
 * present list value with `undefined`. An explicit empty string is a real
 * value and must survive; a missing key must not.
 *
 * An explicit `null` in the detail row wins too, same as `""` — deliberate,
 * not overlooked. It cannot happen today (provider/model/flow_id are all
 * `TEXT NOT NULL DEFAULT ''` — services/kernel/src/modules/agents/migrations.ts:27-30),
 * so there is no live case to special-case around.
 */
export function mergeAgent(list: Row | null, detail: Row | null): Row | null {
  if (!list && !detail) return null;
  const out: Row = { ...(list ?? {}) };
  for (const [k, v] of Object.entries(detail ?? {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Roll back just the given keys of `current` to their prior values.
 *
 * Pulled out of `patch()`'s catch branch as a pure function, and kept as the
 * only way that branch touches state: a failed write must undo only the
 * field(s) it touched, never the whole agent. Overlapping patches on
 * different fields are the normal case here (autosave-per-field on adjacent
 * runtime-control inputs), so replacing the whole object on one field's
 * failure would silently clobber a sibling field's already-applied — or
 * still in-flight — value.
 */
export function rollbackFields(current: Row | null, prevValues: Row): Row {
  return { ...(current ?? {}), ...prevValues };
}

export function createAgentDetailStore(agentId: string) {
  const store = writable<AgentDetailState>({
    agent: null,
    runs: [],
    triggers: [],
    schedules: [],
    connections: null,
    loading: true,
    error: "",
    saving: new Set(),
  });

  // Raw rows, kept separately so every merge starts from the source data —
  // never from a previous merge result. Feeding the already-merged `agent`
  // back in as one side would let a stale value from an earlier merge win
  // forever, since the detail side always wins ties.
  let listRow: Row | null = null;
  let detailRow: Row | null = null;

  async function reload(): Promise<void> {
    store.update((s) => ({ ...s, loading: true, error: "" }));
    try {
      const r = await fetch(`/api/agents/${agentId}`);
      const body = await r.json();
      detailRow = (body.agent ?? null) as Row | null;
      store.update((s) => ({
        ...s,
        agent: mergeAgent(listRow, detailRow),
        runs: body.runs ?? [],
        triggers: body.triggers ?? [],
        schedules: body.schedules ?? [],
        connections: body.adhocConnections ?? null,
        loading: false,
      }));
    } catch (e) {
      store.update((s) => ({ ...s, loading: false, error: String(e) }));
    }
  }

  /** Seed the list row the world already has, so the drawer paints instantly. */
  function seed(row: Row): void {
    listRow = row;
    store.update((s) => ({ ...s, agent: mergeAgent(listRow, detailRow) }));
  }

  /**
   * Optimistic write. The field shows its new value immediately; if the PUT
   * fails the previous value comes back and `error` carries the reason. No
   * toast — the state belongs on the control that was touched.
   */
  async function patch(fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    const prevValues: Row = {};

    store.update((s) => {
      const agent = s.agent ?? {};
      for (const k of keys) prevValues[k] = agent[k];
      const saving = new Set(s.saving);
      for (const k of keys) saving.add(k);
      return { ...s, agent: { ...agent, ...fields }, saving, error: "" };
    });

    try {
      // updateAgent(id, body) → rpcOrCall('agents.update', {id, ...body}) con
      // fallback a PUT /api/agents/:id (lib/api.ts:314). El body viaja tal cual,
      // así que un patch parcial actualiza solo las columnas que manda.
      await updateAgent(agentId, fields);
    } catch (e) {
      store.update((s) => ({ ...s, agent: rollbackFields(s.agent, prevValues), error: String(e) }));
    } finally {
      store.update((s) => {
        const saving = new Set(s.saving);
        for (const k of keys) saving.delete(k);
        return { ...s, saving };
      });
    }
  }

  return { subscribe: store.subscribe, reload, seed, patch };
}
