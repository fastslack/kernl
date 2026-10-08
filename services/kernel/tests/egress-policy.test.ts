import { describe, it, expect, afterEach } from "bun:test";
import { z } from "zod";
import { defineTool } from "../src/core/tool-builder.js";
import { mustDraft, isNetworkEgressTool, isOutboundTool, outboundRefusal, peerCallRefusal, guardOutbound, setProjectRunLookup } from "../src/core/outbound-guard.js";
import { filterOutboundTools } from "../src/modules/agents/executor.js";
import { runWithContext } from "../src/core/request-context.js";

const mk = (name: string, outbound?: boolean) =>
  defineTool({ name, description: "", schema: z.object({}), outbound, handler: async () => ({ content: [{ type: "text", text: "sent" }] }) as never });
const email = mk("kernel_email_send", true);
const social = mk("kernel_social_post", true);
const mesh = mk("kernel_mesh_call_peer_tool", true);
const read = mk("kernel_social_timeline");

afterEach(() => { delete process.env.AGENT_EGRESS_STRICT; setProjectRunLookup(null); });

describe("egress policy", () => {
  it("network tools always need a draft from an agent run", () => {
    expect(isNetworkEgressTool(social)).toBe(true);
    expect(isNetworkEgressTool(mesh)).toBe(true);
    expect(isNetworkEgressTool(read)).toBe(false);
    expect(mustDraft(social, null)).toBe(true);
    expect(mustDraft(mesh, null)).toBe(true);
  });
  it("other outbound tools keep working outside projects unless strict", () => {
    expect(mustDraft(email, null)).toBe(false);
    process.env.AGENT_EGRESS_STRICT = "1";
    expect(mustDraft(email, null)).toBe(true);
  });
  it("project runs draft every outbound tool, as before", () => {
    expect(mustDraft(email, "P1")).toBe(true);
    expect(mustDraft(read, "P1")).toBe(false);
  });
  it("executor drops network tools from every run", () => {
    expect(filterOutboundTools([email, social, read], null).map((t) => t.name)).toEqual(["kernel_email_send", "kernel_social_timeline"]);
  });
  it("refusal applies to agent runs without project", () => {
    setProjectRunLookup(() => null);
    expect(outboundRefusal(social, { callerRunId: "r1" } as never)).toContain("kernel_outbox_propose");
    expect(outboundRefusal(email, { callerRunId: "r1" } as never)).toBeNull();
  });
  it("humans (no run) are never refused", () => {
    expect(outboundRefusal(social, {} as never)).toBeNull();
    expect(peerCallRefusal({} as never)).toBeNull();
    expect(peerCallRefusal({ callerRunId: "r1" } as never)).toContain("Refused");
  });
  it("guarded handler refuses inside a run even with no lookup installed", async () => {
    const res = await runWithContext({ callerRunId: "r1" } as never, () => guardOutbound(social).handler({})) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });
  it("social post/reply refusal names the social_post draft path", () => {
    setProjectRunLookup(() => null);
    for (const n of ["kernel_social_post", "kernel_social_reply"]) {
      const msg = outboundRefusal(mk(n, true), { callerRunId: "r1" } as never)!;
      expect(msg).toContain("kernel_outbox_propose");
      expect(msg).toContain('channel "social_post"');
      expect(msg).toContain('account_ref "social:self"');
    }
  });
  it("network tools without an outbox channel say to ask the user, not to draft", () => {
    setProjectRunLookup(() => null);
    for (const n of ["kernel_social_react", "kernel_social_follow", "kernel_social_unfollow", "kernel_social_delete",
      "kernel_social_set_profile", "kernel_mesh_call_peer_tool", "kernel_federation_sync"]) {
      const msg = outboundRefusal(mk(n, true), { callerRunId: "r1" } as never)!;
      expect(msg).toContain("ask the user to do it");
      expect(msg).not.toContain("kernel_outbox_propose");
    }
  });
  it("strict-mode refusal for a non-network tool does not talk about the network", () => {
    setProjectRunLookup(() => null);
    process.env.AGENT_EGRESS_STRICT = "1";
    const msg = outboundRefusal(email, { callerRunId: "r1" } as never)!;
    expect(msg).toContain("strict egress mode is on");
    expect(msg).not.toContain("network");
    expect(msg).toContain("kernel_outbox_propose");
  });
  it("project-run refusal still says why", () => {
    setProjectRunLookup(() => "P1");
    expect(outboundRefusal(email, { callerRunId: "r1" } as never)).toContain("this run works for a project");
  });
  it("kernel_outbox_propose is not outbound and survives strict mode", () => {
    process.env.AGENT_EGRESS_STRICT = "1";
    const propose = mk("kernel_outbox_propose");
    expect(isOutboundTool(propose)).toBe(false);
    expect(filterOutboundTools([email, propose, read], null).map((t) => t.name)).toEqual(["kernel_outbox_propose", "kernel_social_timeline"]);
    expect(filterOutboundTools([propose], "P1").map((t) => t.name)).toEqual(["kernel_outbox_propose"]);
  });
  it("federation tools are network egress", () => {
    expect(isNetworkEgressTool(mk("kernel_federation_connect", true))).toBe(true);
    for (const n of ["kernel_federation_connect", "kernel_federation_add_peer", "kernel_federation_sync", "kernel_federation_sync_peer"]) {
      expect(isOutboundTool({ name: n })).toBe(true);
      expect(isNetworkEgressTool({ name: n })).toBe(true);
    }
  });
});
