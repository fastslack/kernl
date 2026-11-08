import { describe, it, expect } from "bun:test";
import { chainOnly } from "../src/modules/agents/executor.js";

// 05/11: the security office runs on MiniMax and must never fall back to the global chain (Claude Code first).
describe("__model_chain_only__", () => {
  const agent = (variables: unknown) => ({ variables: typeof variables === "string" ? variables : JSON.stringify(variables) }) as never;
  it("an agent that asks for it runs only on its own chain", () => {
    expect(chainOnly(agent({ __model_chain_only__: "true" }), false)).toBe(true);
    expect(chainOnly(agent({ __model_chain_only__: true }), false)).toBe(true);
  });
  it("without it the run decides (the coding path still forces it)", () => {
    expect(chainOnly(agent({}), false)).toBe(false);
    expect(chainOnly(agent({ __model_chain_only__: "false" }), false)).toBe(false);
    expect(chainOnly(agent({}), true)).toBe(true);
    expect(chainOnly(agent("not json"), undefined)).toBe(false);
  });
});
