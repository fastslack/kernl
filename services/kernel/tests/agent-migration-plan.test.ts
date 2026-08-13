/**
 * Planning for `scripts/agents-use-claude-code.ts`.
 *
 * Moving agents onto the Claude Code executor is the way to run them on a
 * Claude subscription with no API key at all. Two things make a blind
 * "switch everything" wrong:
 *
 *  1. Most agents on a stock kernel are not LLM agents. 31 of the 42 on the
 *     instance this was written against carry a `builtin_handler`
 *     (gsync:calendar, cinema:directory-sync …) and run plain code with
 *     max_iterations 1. Handing those to the SDK spends subscription turns on
 *     work that never asks a model anything.
 *
 *  2. `max_iterations` means different things per executor. The native loop
 *     spends one iteration per LLM round with all tools batched; the SDK
 *     spends a turn per tool call. An agent at 15 — a sane native default —
 *     dies against the SDK partway through, which is exactly what happened to
 *     the first migrated agent.
 */

import { describe, it, expect } from "bun:test";
import { planAgentMigration } from "../scripts/agents-use-claude-code.js";

const agent = (over: Record<string, unknown> = {}) => ({
  id: "id-" + (over.name ?? "x"),
  name: "Agent",
  executor_type: "native",
  builtin_handler: "",
  max_iterations: 15,
  ...over,
});

describe("planAgentMigration", () => {
  it("plans both changes for a native LLM agent with a native-sized budget", () => {
    const { migrate } = planAgentMigration([agent({ name: "Nadia" })], { minTurns: 40 });
    expect(migrate).toHaveLength(1);
    expect(migrate[0]).toMatchObject({
      name: "Nadia",
      setExecutor: true,
      setMaxIterations: 40,
    });
  });

  it("never touches an agent backed by a builtin handler", () => {
    const { migrate, skipped } = planAgentMigration(
      [agent({ name: "Google Calendar Sync", builtin_handler: "gsync:calendar", max_iterations: 1 })],
      { minTurns: 40 },
    );
    expect(migrate).toEqual([]);
    expect(skipped[0]!.reason).toContain("builtin");
  });

  it("leaves an already-migrated agent with a sufficient budget alone", () => {
    const { migrate, skipped } = planAgentMigration(
      [agent({ name: "Done", executor_type: "claude_code", max_iterations: 60 })],
      { minTurns: 40 },
    );
    expect(migrate).toEqual([]);
    expect(skipped[0]!.reason).toContain("already");
  });

  it("raises the budget of an agent already on the SDK but starved of turns", () => {
    const { migrate } = planAgentMigration(
      [agent({ name: "Starved", executor_type: "claude_code", max_iterations: 15 })],
      { minTurns: 40 },
    );
    expect(migrate[0]).toMatchObject({ setExecutor: false, setMaxIterations: 40 });
  });

  it("never lowers a budget that is already generous", () => {
    const { migrate } = planAgentMigration(
      [agent({ name: "Generous", max_iterations: 120 })],
      { minTurns: 40 },
    );
    expect(migrate[0]).toMatchObject({ setExecutor: true, setMaxIterations: null });
  });

  it("keeps the two groups disjoint and complete", () => {
    const agents = [
      agent({ name: "a" }),
      agent({ name: "b", builtin_handler: "gsync:gmail" }),
      agent({ name: "c", executor_type: "claude_code", max_iterations: 60 }),
    ];
    const { migrate, skipped } = planAgentMigration(agents, { minTurns: 40 });
    expect(migrate.length + skipped.length).toBe(agents.length);
    const names = [...migrate.map((m) => m.name), ...skipped.map((s) => s.name)].sort();
    expect(names).toEqual(["a", "b", "c"]);
  });
});
