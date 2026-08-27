/**
 * One agent object, not two half-rows.
 *
 * The drawer used to read `provider` from the world's agent list and
 * `max_iterations` from GET /api/agents/:id, inside the same visual grid
 * (AgentWorld3D.svelte:8943-8946). Two sources with different refresh
 * profiles, which is survivable while everything is read-only and is not once
 * fields become editable.
 *
 * Precedence between the two is by recency, not by source: `mergeAgent`'s
 * second argument wins, and the store picks which row goes there. The detail
 * row is what a fresh fetch just returned; the list row is what the surface
 * just handed over after a Pause, a Resume or a rename. Whichever spoke last
 * is the one that is right.
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

import {
  mergeAgent,
  rollbackFields,
  createAgentDetailStore,
  agentFromResponse,
  sameValue,
  driftedKeys,
} from "./agent-detail.js";

describe("mergeAgent", () => {
  it("prefers the newer row when both carry a field", () => {
    const out = mergeAgent({ id: "a", model: "stale" }, { id: "a", model: "fresh" });
    expect(out!.model).toBe("fresh");
  });

  it("keeps fields only the older row carries", () => {
    const out = mergeAgent({ id: "a", flow_id: "f1" }, { id: "a", model: "opus" });
    expect(out!.flow_id).toBe("f1");
  });

  it("does not let an undefined field in the newer row blank an older value", () => {
    const out = mergeAgent({ id: "a", model: "opus" }, { id: "a", model: undefined });
    expect(out!.model).toBe("opus");
  });

  it("keeps an intentional empty string from the newer row", () => {
    const out = mergeAgent({ id: "a", model: "opus" }, { id: "a", model: "" });
    expect(out!.model).toBe("");
  });

  it("works with only an older row", () => {
    expect(mergeAgent({ id: "a", model: "opus" }, null)!.model).toBe("opus");
  });

  it("works with only a newer row", () => {
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

describe("createAgentDetailStore: a Pause after the detail landed", () => {
  it("lets the seeded list row win over the detail row's stale `active`", async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      ({
        json: async () => ({ agent: { id: "a", active: 1, model: "opus" } }),
      }) as unknown as Response) as unknown as typeof fetch;

    try {
      const store = createAgentDetailStore("a");
      store.seed({ id: "a", active: 1 });
      await store.reload();
      expect(get(store).agent!.active).toBe(1);

      // The surface paused the agent and handed its updated row back. The
      // detail row still says `active: 1` — it was read before the pause —
      // and must not win. This is the exact freeze that kept reload() off.
      store.seed({ id: "a", active: 0 });

      expect(get(store).agent!.active).toBe(0);
      // …without losing what only the detail row carried.
      expect(get(store).agent!.model).toBe("opus");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("createAgentDetailStore: a write during the opening fetch", () => {
  it("does not let the arriving detail row revert it", async () => {
    const originalFetch = global.fetch;
    let releaseFetch!: () => void;
    const gate = new Promise<void>((r) => { releaseFetch = r; });
    global.fetch = (async () => {
      await gate;
      return {
        json: async () => ({ agent: { id: "a", model: "before-the-edit", max_errors: 3 } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    updateAgentImpl = async (_id, body) => ({ agent: { id: "a", ...body } });

    try {
      const store = createAgentDetailStore("a");
      store.seed({ id: "a", model: "before-the-edit" });

      const loading = store.reload();
      // The user edits the model while the drawer is still loading.
      await store.patch({ model: "after-the-edit" });
      releaseFetch();
      await loading;

      expect(get(store).agent!.model).toBe("after-the-edit");
      // The rest of the row that only the fetch carries still arrives.
      expect(get(store).agent!.max_errors).toBe(3);
    } finally {
      global.fetch = originalFetch;
      updateAgentImpl = async () => ({});
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

describe("createAgentDetailStore: onPatched", () => {
  it("hands the merged agent to the mounting surface after a write lands", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const store = createAgentDetailStore("a", { onPatched: (agent) => seen.push(agent) });
    store.seed({ id: "a", provider: "claude_code", model: "sonnet", model_chain: "" });

    updateAgentImpl = async () => ({});
    await store.patch({ provider: "openai", model: "gpt-5", model_chain: "" });

    expect(seen.length).toBe(1);
    expect(seen[0].provider).toBe("openai");
    // The whole row, not just the patched keys — the world repaints from it.
    expect(seen[0].id).toBe("a");
  });

  it("stays silent when the write failed and the field rolled back", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const store = createAgentDetailStore("a", { onPatched: (agent) => seen.push(agent) });
    store.seed({ id: "a", provider: "claude_code" });

    updateAgentImpl = async () => { throw new Error("boom"); };
    await store.patch({ provider: "openai" });

    expect(seen).toEqual([]);
    expect(get(store).agent!.provider).toBe("claude_code");
  });
});

/**
 * Reconciling a write against what came back.
 *
 * The bug this exists to catch is not hypothetical — it is the one this
 * feature shipped on top of. `agents.update` did not read `model_chain` or
 * `executor_type` at all, and `PUT /api/agents/:id` read `model_chain` and
 * then `JSON.stringify`d a string that was already JSON, so the column got a
 * double-encoded value that `readChain` parses back to a string and discards.
 * Both answered `{ success: true }`. A `patch()` that treats "did not throw"
 * as "landed" reports a save in both cases.
 *
 * Every one of those would have been caught here, with no browser involved.
 */

describe("agentFromResponse", () => {
  it("finds the row the HTTP writer returns", () => {
    expect(agentFromResponse({ success: true, agent: { id: "a" } })).toEqual({ id: "a" });
  });

  it("finds it one level deeper, where the WS bridge can leave it", () => {
    expect(agentFromResponse({ data: { success: true, agent: { id: "a" } } })).toEqual({ id: "a" });
  });

  it("returns null when there is no row to reconcile against", () => {
    expect(agentFromResponse({ success: true })).toBeNull();
    expect(agentFromResponse(null)).toBeNull();
    expect(agentFromResponse("ok")).toBeNull();
    expect(agentFromResponse({ agent: [] })).toBeNull();
  });
});

describe("sameValue", () => {
  it("ignores representation: a number column read back as text is the same answer", () => {
    expect(sameValue(12, "12")).toBe(true);
    expect(sameValue("300000", 300000)).toBe(true);
  });

  it("knows a boolean goes out and 0/1 comes back", () => {
    expect(sameValue(true, 1)).toBe(true);
    expect(sameValue(false, 0)).toBe(true);
    expect(sameValue(true, 0)).toBe(false);
  });

  it("does not let a dropped field pass as saved", () => {
    expect(sameValue('[{"provider":"openai","model":"gpt-5"}]', "")).toBe(false);
    expect(sameValue("claude_code", "native")).toBe(false);
    expect(sameValue("x", undefined)).toBe(false);
  });
});

describe("driftedKeys", () => {
  it("names the fields the kernel silently dropped", () => {
    const sent = { provider: "openai", model: "gpt-5", model_chain: '[{"provider":"openai"}]' };
    const saved = { provider: "openai", model: "gpt-5", model_chain: "" };
    expect(driftedKeys(sent, saved)).toEqual(["model_chain"]);
  });

  it("catches the double-encoded chain, which is not the string that was sent", () => {
    const chain = '[{"provider":"openai","model":"gpt-5"}]';
    expect(driftedKeys({ model_chain: chain }, { model_chain: JSON.stringify(chain) }))
      .toEqual(["model_chain"]);
  });

  it("is empty when everything came back as sent", () => {
    expect(driftedKeys({ max_iterations: 12 }, { max_iterations: 12, updated_at: "now" })).toEqual([]);
  });

  it("says nothing about a key the row does not carry", () => {
    expect(driftedKeys({ skills: ["a"] }, { id: "a" })).toEqual([]);
  });
});

describe("createAgentDetailStore: patch() reconciles against the response", () => {
  it("reports a silently dropped field instead of showing the value that was asked for", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const store = createAgentDetailStore("a", { onPatched: (agent) => seen.push(agent) });
    store.seed({ id: "a", provider: "claude_code", model: "sonnet", model_chain: "" });

    // Exactly what `agents.update` did before this branch: accepts provider and
    // model, ignores model_chain, answers success either way.
    updateAgentImpl = async (_id, body) => ({
      success: true,
      agent: { id: "a", provider: body.provider, model: body.model, model_chain: "" },
    });

    await store.patch({
      provider: "openai",
      model: "gpt-5",
      model_chain: '[{"provider":"openai","model":"gpt-5"},{"provider":"grok","model":""}]',
    });

    const state = get(store);
    expect(state.error).toContain("model_chain");
    expect(state.error).toContain("Not saved");
    // The panel shows what the kernel holds, never what the user hoped for.
    expect(state.agent!.model_chain).toBe("");
    // The keys that did land are the server's values.
    expect(state.agent!.provider).toBe("openai");
    // And nothing repaints the world as if the write had succeeded.
    expect(seen).toEqual([]);
  });

  it("takes the server row as authoritative when everything landed", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const store = createAgentDetailStore("a", { onPatched: (agent) => seen.push(agent) });
    store.seed({ id: "a", provider: "claude_code", model: "sonnet", updated_at: "old" });

    updateAgentImpl = async (_id, body) => ({
      success: true,
      agent: { id: "a", provider: body.provider, model: body.model, updated_at: "new" },
    });

    await store.patch({ provider: "openai", model: "gpt-5" });

    const state = get(store);
    expect(state.error).toBe("");
    expect(state.agent!.provider).toBe("openai");
    // A field nobody sent, refreshed from the row that came back.
    expect(state.agent!.updated_at).toBe("new");
    expect(seen.length).toBe(1);
  });

  it("normalises through the transport that nests the body one level deeper", async () => {
    const store = createAgentDetailStore("a");
    store.seed({ id: "a", max_iterations: 5 });
    updateAgentImpl = async () => ({ data: { success: true, agent: { id: "a", max_iterations: 12 } } });

    await store.patch({ max_iterations: 12 });

    expect(get(store).agent!.max_iterations).toBe(12);
    expect(get(store).error).toBe("");
  });

  it("does not let the reconciled row undo a sibling write still in flight", async () => {
    const store = createAgentDetailStore("a");
    store.seed({ id: "a", provider: "old-provider", model: "old-model" });

    updateAgentImpl = async (_id, body) => {
      if ("model" in body) {
        // Slow: still in flight while `provider`'s response is reconciled, and
        // its response row therefore predates it.
        await new Promise((r) => setTimeout(r, 20));
        return { success: true, agent: { id: "a", provider: "new-provider", model: "new-model" } };
      }
      return { success: true, agent: { id: "a", provider: "new-provider", model: "old-model" } };
    };

    const modelPatch = store.patch({ model: "new-model" });
    const providerPatch = store.patch({ provider: "new-provider" });
    await Promise.all([modelPatch, providerPatch]);

    const state = get(store);
    expect(state.agent!.provider).toBe("new-provider");
    expect(state.agent!.model).toBe("new-model");
    expect(state.error).toBe("");
  });

  it("keeps the optimistic value when the response carries no row at all", async () => {
    const store = createAgentDetailStore("a");
    store.seed({ id: "a", provider: "claude_code" });
    updateAgentImpl = async () => ({ success: true });

    await store.patch({ provider: "openai" });

    expect(get(store).agent!.provider).toBe("openai");
    expect(get(store).error).toBe("");
  });
});
