/**
 * defineTool's handler is also called directly, without the MCP dispatch in
 * front: by the agent loop (with `__caller_agent_id` injected) and by the WS
 * bridge. It has to accept what those paths send the same way the dispatch
 * would, or migrating a raw tool to it breaks agents.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { defineTool } from "../src/sdk/tool-builder.js";
import { textResult } from "../src/sdk/helpers.js";

const echo = defineTool({
  name: "t_echo",
  description: "echo",
  schema: z.object({ n: z.number(), tags: z.array(z.string()).optional(), flag: z.boolean().optional() }),
  handler: async (input) => textResult(JSON.stringify(input)),
});
const call = async (args: unknown) => {
  const r = await echo.handler(args);
  return { error: r.isError ?? false, value: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
};

describe("defineTool", () => {
  it("applies the dispatch's coercion to what an LLM sent as strings", async () => {
    expect(await call({ n: "5", tags: '["a","b"]', flag: "true" })).toEqual({
      error: false,
      value: { n: 5, tags: ["a", "b"], flag: true },
    });
  });

  it("keeps the kernel-injected __ keys a caller-aware tool reads", async () => {
    expect((await call({ n: 1, __caller_agent_id: "agent-1" })).value).toEqual({ n: 1, __caller_agent_id: "agent-1" });
  });

  it("drops other unknown keys, as the schema says", async () => {
    expect((await call({ n: 1, invented: true })).value).toEqual({ n: 1 });
  });

  it("still reports a genuine schema violation", async () => {
    const r = await call({ n: "soon" });
    expect(r.error).toBe(true);
  });
});
