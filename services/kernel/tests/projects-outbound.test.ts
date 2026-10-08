import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "../src/core/tool-builder.js";
import { filterOutboundTools, OUTBOUND_NAME_RE } from "../src/modules/agents/executor.js";

const send = defineTool({ name: "kernel_email_send", description: "", schema: z.object({}), outbound: true, handler: async () => ({ content: [] }) as never });
const read = defineTool({ name: "kernel_email_search", description: "", schema: z.object({}), handler: async () => ({ content: [] }) as never });

describe("outbound tools", () => {
  it("defineTool keeps the flag", () => {
    expect(send.outbound).toBe(true);
    expect(read.outbound).toBeUndefined();
  });
  it("project run drops outbound tools", () => {
    expect(filterOutboundTools([send, read], "P1").map((t) => t.name)).toEqual(["kernel_email_search"]);
  });
  it("no project → outbound tools kept", () => {
    expect(filterOutboundTools([send, read], null).length).toBe(2);
  });
});

/**
 * Static guard over every tool definition in the kernel, its bundled
 * extensions and the paid extensions: a tool that publishes or sends must
 * carry `outbound: true` between its name and its handler, or a run for a
 * project could publish without going through the outbox.
 */
const ROOTS = ["src", "assets/extensions", "../../../kernl-pro/assets/extensions"].filter((r) => existsSync(r));

/** Publish/send tools whose names the regex can't recognise. */
const MUST_BE_OUTBOUND = [
  "kernel_twitter_approve", "kernel_twitter_create_post", "kernel_tiktok_post_queue",
  "kernel_youtube_update_video", "kernel_events_invite", "kernel_events_invite_contacts",
  "kernel_comms_request_missing_info", "kernel_social_post", "kernel_social_react",
  "kernel_social_follow", "kernel_social_unfollow", "kernel_social_delete", "kernel_social_set_profile",
  "kernel_mesh_call_peer_tool", "kernel_mesh_pair_peer",
  "kernel_federation_connect", "kernel_federation_add_peer", "kernel_federation_sync", "kernel_federation_sync_peer",
];
/** Names the regex matches that only talk to the operator, never to the outside. */
const NOT_OUTBOUND = ["kernel_digest_send_now"];

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) yield p;
  }
}

function toolDefs(): Array<{ name: string; outbound: boolean; file: string }> {
  const out: Array<{ name: string; outbound: boolean; file: string }> = [];
  for (const root of ROOTS) {
    for (const file of tsFiles(root)) {
      const src = readFileSync(file, "utf8");
      const re = /name:\s*"(kernel_[a-z0-9_]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const rest = src.slice(m.index);
        const end = rest.search(/\bhandler\s*[:(]/);
        const block = end > 0 ? rest.slice(0, end) : rest.slice(0, 4000);
        out.push({ name: m[1], outbound: /\boutbound:\s*true\b/.test(block), file });
      }
    }
  }
  return out;
}

describe("outbound catalog guard", () => {
  const defs = toolDefs();
  it("finds the tool definitions", () => {
    expect(defs.length).toBeGreaterThan(200);
  });
  it("every tool that looks like sending is marked outbound", () => {
    const unmarked = defs
      .filter((d) => (OUTBOUND_NAME_RE.test(d.name) || MUST_BE_OUTBOUND.includes(d.name)) && !NOT_OUTBOUND.includes(d.name))
      .filter((d) => !d.outbound)
      .map((d) => `${d.name} (${d.file})`);
    expect(unmarked).toEqual([]);
  });
});

describe("outbound guard at the MCP dispatch", () => {
  it("refuses an outbound tool to a caller whose run works for a project", async () => {
    const { setProjectRunLookup, outboundRefusal } = await import("../src/core/outbound-guard.js");
    setProjectRunLookup((runId) => (runId === "R-PROJ" ? "P1" : null));
    expect(outboundRefusal(send, { callerAgentId: "A", callerRunId: "R-PROJ", callerDepth: 0 })).toMatch(/kernel_outbox_propose/);
    expect(outboundRefusal(send, { callerAgentId: "A", callerRunId: "R-PLAIN", callerDepth: 0 })).toBeNull();
    expect(outboundRefusal(send, { callerAgentId: "", callerRunId: "", callerDepth: 0 })).toBeNull();
    expect(outboundRefusal(read, { callerAgentId: "A", callerRunId: "R-PROJ", callerDepth: 0 })).toBeNull();
    setProjectRunLookup(null);
  });
});

describe("outbound guard on every in-process path", () => {
  it("the registry's catalog refuses outbound tools to project runs, flag or not (old bundles), on any caller path", async () => {
    const { ModuleRegistry } = await import("../src/core/module-registry.js");
    const { setProjectRunLookup } = await import("../src/core/outbound-guard.js");
    const { runWithContext } = await import("../src/core/request-context.js");
    let sentCount = 0;
    const handler = async () => { sentCount++; return { content: [{ type: "text" as const, text: "sent" }] }; };
    const legacy = { name: "kernel_legacy_send", description: "", inputSchema: z.object({}), handler } as never;
    const approve = { name: "kernel_twitter_approve", description: "", inputSchema: z.object({}), handler } as never;
    const reg = new ModuleRegistry();
    reg.register({ name: "legacy", initialize: async () => {}, getTools: () => [legacy, approve], shutdown: async () => {} });
    await reg.initializeAll({} as never);
    setProjectRunLookup((id) => (id === "R-PROJ" ? "P1" : null));
    const tools = reg.getAllTools();
    for (const t of tools) {
      const r = await runWithContext({ callerAgentId: "A", callerRunId: "R-PROJ", callerDepth: 0 }, () => t.handler({}));
      expect(r.isError).toBe(true);
      expect(t.outbound).toBe(true);
    }
    expect(sentCount).toBe(0);
    await runWithContext({ callerAgentId: "A", callerRunId: "R-PLAIN", callerDepth: 0 }, () => tools[0].handler({}));
    expect(sentCount).toBe(1);
    setProjectRunLookup(null);
  });
});
