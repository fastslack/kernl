import { describe, it, expect } from "bun:test";
import { z } from "zod";
import corpus from "./fixtures/injection-corpus.json";
import { wrapExternal } from "../src/sdk/external-content.js";
import { defineTool } from "../src/core/tool-builder.js";
import { guardOutbound } from "../src/core/outbound-guard.js";
import { runWithContext } from "../src/core/request-context.js";

const NET = ["kernel_social_post", "kernel_social_reply", "kernel_social_react", "kernel_social_follow", "kernel_mesh_call_peer_tool", "kernel_mesh_pair_peer"];

describe("injection corpus", () => {
  it("has at least 50 payloads", () => expect((corpus as string[]).length).toBeGreaterThanOrEqual(50));
  for (const [i, p] of (corpus as string[]).entries()) {
    it(`#${i} stays inside one external element`, () => {
      const w = wrapExternal(p, { source: "email", from: "x@y" });
      expect((w.match(/<external\b/gi) ?? []).length).toBe(1);
      expect((w.match(/<\/external>/gi) ?? []).length).toBe(1);
      expect(w.trimEnd().endsWith("</external>")).toBe(true);
      expect(/[­͏؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/u.test(w)).toBe(false);
    });
  }
  it("flags at least 60% of the corpus", () => {
    const flagged = (corpus as string[]).filter((p) => wrapExternal(p, { source: "t" }).includes('flagged="')).length;
    expect(flagged / (corpus as string[]).length).toBeGreaterThanOrEqual(0.6);
  });
  for (const name of NET) {
    it(`${name} cannot be called from an agent run`, async () => {
      let sent = false;
      const tool = guardOutbound(defineTool({ name, description: "", schema: z.object({}), outbound: true, handler: async () => { sent = true; return { content: [] } as never; } }));
      const r = (await runWithContext({ callerRunId: "r1" } as never, () => tool.handler({}))) as { isError?: boolean };
      expect(r.isError).toBe(true);
      expect(sent).toBe(false);
    });
  }
});
