/**
 * agent-advanced builds its own provider map at boot, and adapters read their
 * keys when built. On a NVIDIA-only install connected after boot, auto-eval
 * kept trying a logged-out Claude Code while the agents themselves already ran
 * on NVIDIA. The extension now hands its services a fresh map on
 * `llm.providers.changed`; this pins that the eval service grades on whatever
 * map it was given last.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { AgentEvalService } from "../assets/extensions/agents/agent-advanced/_module/eval-service.js";
import * as providerHealth from "../src/core/llm/provider-health.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";
import type { KernelConfig } from "../src/core/config.js";

const GRADE = JSON.stringify({ score: 4, outcome: "success", lesson: "ok", issues: "", confidence: 0.9 });

function nvidia(available: boolean, calls: string[]): ChatLlmProvider {
  return {
    name: "nvidia",
    available: () => available,
    async chatCompletion() {
      calls.push("nvidia");
      return { content: GRADE, model: "m", tokens_used: 10 };
    },
  };
}

const config = {
  language: "en",
  agents: { defaultModelChain: [{ provider: "nvidia", model: "" }] },
} as unknown as KernelConfig;

const run = {
  goal: "g", result: "r", steps_count: 1, tools_used: [], status: "failed" as const,
};

beforeEach(() => providerHealth._resetForTests());

describe("AgentEvalService — providers connected after boot", () => {
  it("grades on the map it was handed last", async () => {
    const calls: string[] = [];
    const svc = new AgentEvalService();
    svc.setConfig(config);

    // Boot: NVIDIA has no key yet, Claude is not connected at all.
    svc.setProviders(new Map([["nvidia", nvidia(false, calls)]]), "claude", "");
    expect(await svc.evaluate(run)).toBeNull();
    expect(calls).toEqual([]);

    // NVIDIA connected: the extension rebuilds and hands over the new map.
    svc.setProviders(new Map([["nvidia", nvidia(true, calls)]]), "claude", "");
    const graded = await svc.evaluate(run);
    expect(calls).toEqual(["nvidia"]);
    expect(graded?.score).toBe(4);
  });
});
