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
 * The agent row a successful write handed back, wherever it put it.
 *
 * Both writers return one: `agents.update` (rpc-actions.ts) and
 * `PUT /api/agents/:id` (api-routes.ts) each answer
 * `{ success: true, agent: <row> }`. The WebSocket bridge resolves an RPC with
 * `payload.data ?? payload` (ws.ts:231), so the same body can arrive one level
 * deeper — hence both shapes, rather than guessing which transport ran.
 *
 * Returns null when there is no row to reconcile against, which is a real
 * answer and not a failure: the caller keeps its optimistic value and says
 * nothing it cannot back up.
 */
export function agentFromResponse(res: unknown): Row | null {
  if (!res || typeof res !== "object") return null;
  const top = (res as Record<string, unknown>).agent;
  if (top && typeof top === "object" && !Array.isArray(top)) return top as Row;
  const data = (res as Record<string, unknown>).data;
  if (data && typeof data === "object") {
    const nested = (data as Record<string, unknown>).agent;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Row;
  }
  return null;
}

/**
 * Is the value that came back the value that was sent?
 *
 * Deliberately loose about representation, strict about meaning. The column is
 * TEXT and the control is a number input, so `12` and `"12"` are the same
 * answer; `active` is a boolean going out and `1` coming back. What must NOT
 * pass is a field that was ignored — the value the row already had.
 */
export function sameValue(sent: unknown, saved: unknown): boolean {
  if (sent === saved) return true;
  if (typeof sent === "boolean") return saved === (sent ? 1 : 0);
  if (sent === null || sent === undefined || saved === null || saved === undefined) return false;
  if (typeof sent === "object" || typeof saved === "object") return false;
  return String(sent) === String(saved);
}

/**
 * The keys a write claimed to accept and did not.
 *
 * This is the check that makes "saved" mean something. Without it `patch()`
 * read "the call did not throw" as "the value landed" — and against a kernel
 * that silently drops a column (which is exactly what both agent writers did
 * with `model_chain` and `executor_type` before this branch, one by omitting
 * it and one by double-encoding it) the panel would report a save that never
 * happened. Which is the same lie this whole task exists to remove.
 */
export function driftedKeys(sent: Record<string, unknown>, saved: Row): string[] {
  return Object.keys(sent).filter((k) => k in saved && !sameValue(sent[k], saved[k]));
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

export interface AgentDetailStoreOptions {
  /**
   * Raised with the merged agent after a write that actually landed.
   *
   * The drawer is not the only surface showing this agent: the 3D world
   * paints its node from its own `agents` array. While nothing inside the
   * drawer wrote, nothing had to tell it. The runtime controls do write, so
   * without this the world keeps painting the old provider until its next
   * full refetch. Raised only on success — a rolled-back write must repaint
   * nothing.
   */
  onPatched?: (agent: Row) => void;
}

export function createAgentDetailStore(agentId: string, opts: AgentDetailStoreOptions = {}) {
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
   * Optimistic write, reconciled against what the server actually saved.
   *
   * The field shows its new value immediately. If the call fails the previous
   * value comes back and `error` carries the reason. If the call succeeds the
   * optimistic value is NOT taken on trust: the row that comes back is
   * authoritative, and any field that came back different from what was sent
   * is reported on that field exactly like a failure — because it is one. No
   * toast; the state belongs on the control that was touched.
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

    let landed = false;
    try {
      // updateAgent(id, body) → rpcOrCall('agents.update', {id, ...body}) con
      // fallback a PUT /api/agents/:id (lib/api.ts:314). El body viaja tal cual,
      // así que un patch parcial actualiza solo las columnas que manda.
      const res = await updateAgent(agentId, fields);
      const saved = agentFromResponse(res);

      if (!saved) {
        // Nothing to reconcile against. The optimistic value stands, which is
        // the old behaviour — kept only for a transport that answers without a
        // row, never as the normal path.
        landed = true;
      } else {
        const drifted = driftedKeys(fields, saved);
        store.update((s) => {
          const agent = { ...(s.agent ?? {}) };
          // Take the server's value for every key this write sent, plus any
          // key no other write is still in flight for (so `updated_at` and
          // friends refresh). A key inside another patch's `saving` set is
          // left alone: that row predates the sibling's value and would undo
          // it — the same reason the rollback is per-key.
          for (const [k, v] of Object.entries(saved)) {
            if (k in fields || !s.saving.has(k)) agent[k] = v;
          }
          return {
            ...s,
            agent,
            error: drifted.length
              ? `Not saved: ${drifted.join(", ")} — the kernel answered with a different value.`
              : s.error,
          };
        });
        landed = drifted.length === 0;
      }
    } catch (e) {
      store.update((s) => ({ ...s, agent: rollbackFields(s.agent, prevValues), error: String(e) }));
    } finally {
      let merged: Row | null = null;
      store.update((s) => {
        const saving = new Set(s.saving);
        for (const k of keys) saving.delete(k);
        merged = s.agent;
        return { ...s, saving };
      });
      // Outside the updater: a subscriber that writes back into this store
      // from inside `update()` would re-enter it mid-notification.
      if (landed && merged && opts.onPatched) opts.onPatched(merged);
    }
  }

  return { subscribe: store.subscribe, reload, seed, patch };
}
