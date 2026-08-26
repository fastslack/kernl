/**
 * One agent object, not two half-rows.
 *
 * The drawer used to read `provider` from the world's agent list and
 * `max_iterations` from GET /api/agents/:id, inside the same visual grid
 * (AgentWorld3D.svelte:8943-8946). Two sources with different refresh
 * profiles, which is survivable while everything is read-only and is not once
 * fields become editable.
 *
 * The detail row wins because it is the one the write path returns.
 */

import { describe, it, expect, mock } from "bun:test";

// Must precede the static import of "./agent-detail.js" below: that module
// imports `updateAgent` from "../api.js" at load time, and the patch-rollback
// test needs to control what updateAgent resolves/rejects with, per call,
// without touching the network.
let updateAgentImpl: (id: string, body: Record<string, unknown>) => Promise<unknown> = async () => ({});
mock.module("../api.js", () => ({
  updateAgent: (id: string, body: Record<string, unknown>) => updateAgentImpl(id, body),
}));

import { mergeAgent, rollbackFields, createAgentDetailStore } from "./agent-detail.js";

describe("mergeAgent", () => {
  it("prefers the detail row when both carry a field", () => {
    const out = mergeAgent({ id: "a", model: "stale" }, { id: "a", model: "fresh" });
    expect(out!.model).toBe("fresh");
  });

  it("keeps list-only fields the detail row does not carry", () => {
    const out = mergeAgent({ id: "a", flow_id: "f1" }, { id: "a", model: "opus" });
    expect(out!.flow_id).toBe("f1");
  });

  it("does not let an undefined detail field blank a list value", () => {
    const out = mergeAgent({ id: "a", model: "opus" }, { id: "a", model: undefined });
    expect(out!.model).toBe("opus");
  });

  it("keeps an intentional empty string from the detail row", () => {
    const out = mergeAgent({ id: "a", model: "opus" }, { id: "a", model: "" });
    expect(out!.model).toBe("");
  });

  it("works with only a list row", () => {
    expect(mergeAgent({ id: "a", model: "opus" }, null)!.model).toBe("opus");
  });

  it("works with only a detail row", () => {
    expect(mergeAgent(null, { id: "a", model: "opus" })!.model).toBe("opus");
  });

  it("returns null when there is nothing to merge", () => {
    expect(mergeAgent(null, null)).toBeNull();
  });
});

/**
 * Reads the current value out of a Svelte store without keeping a live
 * subscription open — `subscribe` calls back synchronously with the current
 * value, so grabbing it and immediately unsubscribing is enough.
 */
function get<T>(store: { subscribe: (fn: (v: T) => void) => () => void }): T {
  let value!: T;
  const unsubscribe = store.subscribe((v) => (value = v));
  unsubscribe();
  return value;
}

describe("createAgentDetailStore: seed() staleness", () => {
  it("keeps a later seed's list-only field instead of the first seed's stale value", async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      ({
        json: async () => ({ agent: { id: "a", model: "opus" } }),
      }) as unknown as Response) as unknown as typeof fetch;

    try {
      const store = createAgentDetailStore("a");

      // First seed carries a list-only field (`status`) alongside the id.
      store.seed({ id: "a", status: "queued" });
      // A detail fetch lands, merged against the *raw* list row, not the
      // already-merged state — this used to be where the bug hid.
      await store.reload();
      expect(get(store).agent!.status).toBe("queued");
      expect(get(store).agent!.model).toBe("opus");

      // The world's list refreshes again with a changed list-only field.
      store.seed({ id: "a", status: "running" });

      expect(get(store).agent!.status).toBe("running");
      // The detail-sourced field must still be intact — merged fresh from
      // the raw detail row, not clobbered by re-seeding.
      expect(get(store).agent!.model).toBe("opus");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("rollbackFields", () => {
  it("restores only the given keys, leaving the rest of the row alone", () => {
    const current = { id: "a", model: "new-model", provider: "new-provider" };
    const out = rollbackFields(current, { model: "old-model" });
    expect(out.model).toBe("old-model");
    expect(out.provider).toBe("new-provider");
  });

  it("falls back to an empty row when current is null", () => {
    expect(rollbackFields(null, { model: "old-model" })).toEqual({ model: "old-model" });
  });
});

describe("createAgentDetailStore: patch() rollback", () => {
  it("does not clobber a sibling field that a second, overlapping patch already applied", async () => {
    const store = createAgentDetailStore("a");
    store.seed({ id: "a", model: "old-model", provider: "old-provider" });

    // `model`'s write fails, but only after `provider`'s write (started
    // right after it, before it resolved) has already succeeded — the
    // overlapping-autosave case the runtime-control fields hit in practice.
    updateAgentImpl = async (_id, body) => {
      if ("model" in body) {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("boom");
      }
      return {};
    };

    const modelPatch = store.patch({ model: "new-model" });
    const providerPatch = store.patch({ provider: "new-provider" });
    await Promise.all([modelPatch, providerPatch]);

    const state = get(store);
    // The failed field rolled back...
    expect(state.agent!.model).toBe("old-model");
    // ...but the sibling field's successful, later value must survive.
    expect(state.agent!.provider).toBe("new-provider");
    expect(state.error).toContain("boom");
  });
});
