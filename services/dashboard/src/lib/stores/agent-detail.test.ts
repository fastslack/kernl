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

import { describe, it, expect } from "bun:test";
import { mergeAgent } from "./agent-detail.js";

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
