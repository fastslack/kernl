import { describe, it, expect } from "bun:test";
import { storedToDisplay } from "./office-chat-history.js";

describe("storedToDisplay", () => {
  it("folds tool results into their call and keeps plain turns as text", () => {
    const out = storedToDisplay([
      { role: "user", content: "list agents" },
      {
        role: "assistant",
        content: "Two agents.",
        content_blocks: JSON.stringify([
          { type: "tool_use", id: "t1", name: "mcp__kernel__kernel_agents_list", input: {} },
          { type: "tool_result", tool_use_id: "t1", content: "[...]", is_error: false },
          { type: "text", text: "Two " },
          { type: "text", text: "agents." },
        ]),
      },
      { role: "system", content: "ignored" },
    ]);
    expect(out).toEqual([
      { role: "user", blocks: [{ type: "text", text: "list agents" }] },
      {
        role: "assistant",
        blocks: [
          { type: "tool_use", id: "t1", name: "mcp__kernel__kernel_agents_list", input: {}, result: "[...]", is_error: false },
          { type: "text", text: "Two agents." },
        ],
      },
    ]);
  });

  it("unwraps attachment envelopes and skips empty rows", () => {
    const out = storedToDisplay([
      { role: "user", content: JSON.stringify({ text: "look", images: ["a.png"] }) },
      { role: "assistant", content: "" },
    ]);
    expect(out).toEqual([{ role: "user", blocks: [{ type: "text", text: "look" }] }]);
  });
});

describe("storedToDisplay attachments", () => {
  it("surfaces the row's metas, or the envelope ids, and keeps attachment-only turns", () => {
    const meta = { id: "a1", filename: "plan.pdf" } as any;
    const out = storedToDisplay([
      { role: "user", content: JSON.stringify({ text: "read this", attachments: ["a1"] }), attachments: [meta] },
      { role: "user", content: JSON.stringify({ text: "", attachments: ["a2"] }) },
      { role: "assistant", content: "Read it." },
    ]);
    expect(out).toEqual([
      { role: "user", blocks: [{ type: "text", text: "read this" }], attachments: [meta] },
      { role: "user", blocks: [], attachments: ["a2"] },
      { role: "assistant", blocks: [{ type: "text", text: "Read it." }] },
    ]);
  });
});
