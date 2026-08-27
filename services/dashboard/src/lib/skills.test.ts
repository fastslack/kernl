/**
 * An attach that did not happen must not report that it did.
 *
 * `saveAgentSkills` used to `await updateAgent(id, {skills})` and return. The
 * kernel's `agents.update` answered `{success: true, agent}` while dropping
 * the column — its handler built an explicit key list without `skills` on it
 * — so nothing threw, and SkillsTab.persist() took "did not throw" as proof:
 * it set `attached`, moved `seenJson`, dispatched `change`, and the badge,
 * the row and the token estimate all moved for a skill the agent never got.
 * Since the old attach-only panel was deleted, this is the only attach
 * surface there is.
 *
 * The kernel side is fixed, but a dashboard talking to an older kernel is the
 * normal case (the two ship separately), so the check is what keeps the lie
 * from coming back. These tests are written against the RESPONSE, not the
 * network: what has to be proved is that a row disagreeing with what was sent
 * raises, and that a row agreeing with it does not.
 */

import { describe, it, expect, mock } from "bun:test";

// Must precede the static import below — skills.ts binds `updateAgent` at
// load time, same reason as stores/agent-detail.test.ts.
let updateAgentImpl: (id: string, body: Record<string, unknown>) => Promise<unknown> =
  async () => ({});
mock.module("./api.js", () => ({
  updateAgent: (id: string, body: Record<string, unknown>) => updateAgentImpl(id, body),
}));

import {
  saveAgentSkills,
  sameSlugList,
  parseAttachedSkills,
  toggleAgentSkill,
  invalidateAgentsCache,
} from "./skills.js";

/** A writer that saved what it was told, answering in the RPC's shape. */
function honest() {
  return async (_id: string, body: Record<string, unknown>) => ({
    success: true,
    agent: { id: "a1", skills_json: JSON.stringify(body.skills) },
  });
}

/** A writer that accepts the call and drops the column — the bug, verbatim. */
function drops(existing: string[]) {
  return async () => ({
    success: true,
    agent: { id: "a1", skills_json: JSON.stringify(existing) },
  });
}

describe("sameSlugList", () => {
  it("accepts an identical list", () => {
    expect(sameSlugList(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("rejects a different length", () => {
    expect(sameSlugList(["a"], ["a", "b"])).toBe(false);
  });

  it("treats order as part of the value — it is the column verbatim", () => {
    expect(sameSlugList(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("accepts two empty lists", () => {
    expect(sameSlugList([], [])).toBe(true);
  });
});

describe("saveAgentSkills", () => {
  it("resolves when the row that came back carries what was sent", async () => {
    updateAgentImpl = honest();
    await saveAgentSkills("a1", ["release-notes"]);
  });

  it("throws when the kernel silently kept the old list (regression)", async () => {
    updateAgentImpl = drops([]);
    await expect(saveAgentSkills("a1", ["release-notes"])).rejects.toThrow(/Not saved: skills/);
  });

  it("names what actually came back, so the user can see nothing moved", async () => {
    updateAgentImpl = drops(["already-there"]);
    await expect(saveAgentSkills("a1", ["already-there", "new-one"])).rejects.toThrow(
      /already-there/,
    );
  });

  it("catches a dropped DETACH as well as a dropped attach", async () => {
    updateAgentImpl = drops(["still-attached"]);
    await expect(saveAgentSkills("a1", [])).rejects.toThrow(/still-attached/);
  });

  it("reads the row out of the WebSocket bridge's extra envelope", async () => {
    // ws.ts resolves an RPC with `payload.data ?? payload`, so the same body
    // arrives one level deeper on the transport the dashboard normally uses.
    updateAgentImpl = async (_id, body) => ({
      data: { success: true, agent: { id: "a1", skills_json: JSON.stringify(body.skills) } },
    });
    await saveAgentSkills("a1", ["deep"]);
  });

  it("still catches a dropped write through that same envelope", async () => {
    updateAgentImpl = async () => ({
      data: { success: true, agent: { id: "a1", skills_json: "[]" } },
    });
    await expect(saveAgentSkills("a1", ["deep"])).rejects.toThrow(/Not saved: skills/);
  });

  it("takes the write on trust only when there is no row to check against", async () => {
    // Not every transport answers with the agent. A check that cannot run
    // must not invent a verdict either way.
    updateAgentImpl = async () => ({ success: true });
    await saveAgentSkills("a1", ["unverifiable"]);
  });

  it("lets a transport failure through unchanged", async () => {
    updateAgentImpl = async () => {
      throw new Error("HTTP 500");
    };
    await expect(saveAgentSkills("a1", ["x"])).rejects.toThrow("HTTP 500");
  });
});

describe("toggleAgentSkill", () => {
  it("returns the resulting list when the write is verified", async () => {
    invalidateAgentsCache();
    updateAgentImpl = honest();
    const next = await toggleAgentSkill({ id: "a1", name: "A", skills_json: '["a"]' }, "b");
    expect(next).toEqual(["a", "b"]);
  });

  it("does not hand back a list the kernel refused to save", async () => {
    invalidateAgentsCache();
    updateAgentImpl = drops(["a"]);
    await expect(
      toggleAgentSkill({ id: "a1", name: "A", skills_json: '["a"]' }, "b"),
    ).rejects.toThrow(/Not saved: skills/);
  });
});

describe("parseAttachedSkills", () => {
  it("tolerates a column that is not a JSON array", () => {
    expect(parseAttachedSkills({ skills_json: "not json" })).toEqual([]);
    expect(parseAttachedSkills({ skills_json: '{"a":1}' })).toEqual([]);
    expect(parseAttachedSkills(null)).toEqual([]);
  });
});
