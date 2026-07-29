/**
 * meta module — kernel-wide MCP meta tools.
 *
 * Exposes three tools that operate on the *entire* tool catalog rather
 * than any single domain:
 *
 *   * `kernel_tool_search`   — progressive discovery. Free-text query
 *                              against name/description/tags, returns a
 *                              ranked list without dragging full schemas
 *                              into the context.
 *   * `kernel_tool_describe` — fetch one tool's full input/output schema
 *                              after `kernel_tool_search` narrowed it
 *                              down.
 *   * `kernel_code_run`      — programmatic tool calling. Runs a small
 *                              JS script in a Node `vm` sandbox with a
 *                              `tool(name, args)` host function that
 *                              dispatches to other kernel tools without
 *                              another inference round.
 *
 * The "tool catalog" is captured *late* — after all other modules have
 * been initialized — by passing a `getCatalog` callback to
 * `createMetaModule`. This avoids registering a module that hasn't yet
 * been initialized, while still letting the meta tools see the full
 * surface (kernel + skill + email + bridged tools).
 */

import { z } from "zod";
import type {
  KernelModule,
  ModuleContext,
  ToolDefinition,
  ToolResult,
} from "../../core/types.js";
import { errorResult, structuredResult, textResult, uiResult } from "../../core/helpers.js";
import { defineTool, defineToolNoInput } from "../../core/tool-builder.js";
import { elicit } from "../../core/elicit.js";
import { runScript } from "./code-runner.js";
import {
  verifyChain,
  verifyReceipt,
  type Identity,
  type PlanReceipt,
  type Receipt,
} from "../../core/attestation.js";
import type { CostRouter } from "../../core/llm/cost-router.js";
import { buildDigest, type DigestDefaults } from "./digest.js";
import { RankingService } from "../../core/ranking/service.js";
import type { EmbeddingsClient } from "../../core/embeddings/client.js";

export interface MetaModuleOptions {
  /**
   * Live snapshot of every tool the kernel exposes. Called *every* time a
   * meta tool needs the catalog, so plugins / extensions / runtime
   * registrations show up without a server restart.
   */
  getCatalog: () => ToolDefinition[];
  /**
   * Optional accessor to the running server's attestation identity. When
   * present, `kernel_attest_identity` reports it as enabled and exposes
   * the public-key fingerprint. `kernel_attest_verify` works either way —
   * it verifies any receipt against its embedded `server_id`.
   */
  getIdentity?: () => Identity | undefined;
  /**
   * Optional accessor to the cost router. When present,
   * `kernel_meta_cost_report` reports the top tools by accumulated $$.
   */
  getCostRouter?: () => CostRouter | undefined;
  /** Embeddings client for the research-digest ranking layer. */
  getEmbeddings?: () => EmbeddingsClient | null;
  /** One-shot LLM completion used by kernel_research_digest's map-reduce. */
  getCompleter?: () =>
    | ((system: string, user: string) => Promise<{ text: string; tokens: number }>)
    | undefined;
}

export function createMetaModule(opts: MetaModuleOptions): KernelModule {
  const tools: ToolDefinition[] = [
    buildToolSearch(opts.getCatalog),
    buildToolDescribe(opts.getCatalog),
    buildCodeRun(opts.getCatalog, {
      ranking: new RankingService(opts.getEmbeddings?.() ?? null),
      embeddings: opts.getEmbeddings?.() ?? null,
    }),
    buildElicitConfirm(),
    buildRenderCard(),
    buildAttestIdentity(opts.getIdentity),
    buildAttestVerify(),
    buildAttestVerifyChain(),
    buildCostReport(opts.getCostRouter),
  ];

  // Research-digest is only wired when a completer is actually available —
  // graceful degradation, matching how other optional tools are gated.
  const completer = opts.getCompleter?.();
  if (completer) {
    const DIGEST_DEFAULTS: DigestDefaults = {
      k: 24,
      chunkSize: 20,
      concurrency: 3,
      cooldownMs: 1500,
      maxItems: 500,
    };
    tools.push(
      buildDigest({
        getCatalog: opts.getCatalog,
        ranking: new RankingService(opts.getEmbeddings?.() ?? null),
        complete: completer,
        defaults: DIGEST_DEFAULTS,
      }),
    );
  }

  return {
    name: "meta",
    async initialize(_ctx: ModuleContext): Promise<void> {
      // Stateless module — nothing to bootstrap.
    },
    getTools(): ToolDefinition[] {
      return tools;
    },
    async shutdown(): Promise<void> {},
  };
}

// ── kernel_tool_search ────────────────────────────────────────────

const ToolSearchInput = z.object({
  query: z.string().describe("Free-text search query."),
  limit: z.number().int().positive().max(50).default(10),
});

const ToolSearchOutput = z.object({
  matches: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      tags: z.array(z.string()),
      score: z.number(),
    }),
  ),
  total: z.number().int(),
});

/**
 * Build a tool_search tied to a specific catalog accessor. Exported so
 * the agents executor can construct an agent-scoped version that searches
 * only the agent's allowed_tools, instead of the kernel-wide catalog.
 */
export function buildToolSearch(getCatalog: () => ToolDefinition[]): ToolDefinition {
  return defineTool({
    name: "kernel_tool_search",
    description:
      "Search the kernel tool catalog by free-text query. Returns ranked matches " +
      "(name + description + tags + score) without dragging their full input schemas " +
      "into the context. Pair with `kernel_tool_describe` to fetch one tool's full " +
      "schema on demand. Replaces the antipattern of dumping every tool into the " +
      "context window.",
    schema: ToolSearchInput,
    outputSchema: ToolSearchOutput,
    tags: ["meta", "discovery", "search"],
    handler: async (input): Promise<ToolResult> => {
      const { query, limit } = input;
      const q = query.toLowerCase();
      const tokens = q.split(/\s+/).filter(Boolean);
      const catalog = getCatalog();

      const scored = catalog
        .map((t) => ({ tool: t, score: scoreTool(q, tokens, t) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const matches = scored.map(({ tool, score }) => ({
        name: tool.name,
        description: tool.description,
        tags: tool.tags ?? [],
        score,
      }));

      return structuredResult(
        { matches, total: matches.length },
        formatSearchSummary(query, matches),
      );
    },
  });
}

function scoreTool(query: string, tokens: string[], tool: ToolDefinition): number {
  let score = 0;
  const name = tool.name.toLowerCase();
  const desc = tool.description.toLowerCase();
  const tags = tool.tags ?? [];

  if (name.includes(query)) score += 3;
  if (desc.includes(query)) score += 1;
  for (const tag of tags) {
    if (tag.toLowerCase().includes(query)) score += 2;
  }

  if (tokens.length > 1) {
    for (const tok of tokens) {
      if (name.includes(tok)) score += 0.5;
      if (desc.includes(tok)) score += 0.25;
    }
  }
  return score;
}

function formatSearchSummary(
  query: string,
  matches: Array<{ name: string; score: number }>,
): string {
  if (matches.length === 0) return `No tools matched "${query}".`;
  const lines = [`# ${matches.length} match(es) for "${query}"`, ""];
  for (const m of matches) lines.push(`- **${m.name}** (score ${m.score.toFixed(2)})`);
  return lines.join("\n");
}

// ── kernel_tool_describe ──────────────────────────────────────────

const ToolDescribeInput = z.object({
  name: z.string().describe("Exact tool name as returned by kernel_tool_search."),
});

const ToolDescribeOutput = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown().optional(),
  tags: z.array(z.string()),
});

export function buildToolDescribe(getCatalog: () => ToolDefinition[]): ToolDefinition {
  return defineTool({
    name: "kernel_tool_describe",
    description:
      "Fetch the full input/output schema for a tool by name. Use after " +
      "`kernel_tool_search` to load only the schemas you'll actually call. " +
      "Returns the same shape that `tools/list` would emit for this single " +
      "tool — minus the host function: this is purely metadata.",
    schema: ToolDescribeInput,
    outputSchema: ToolDescribeOutput,
    tags: ["meta", "discovery"],
    handler: async (input): Promise<ToolResult> => {
      const { name } = input;
      const tool = getCatalog().find((t) => t.name === name);
      if (!tool) return errorResult(`Tool not found: ${name}`);

      // We can't lazily import zodToJsonSchema at module top level
      // without introducing a circular dep, so do it here.
      const { zodToJsonSchema } = await import("../../core/zod-to-json.js");
      const description = {
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.inputSchema),
        outputSchema: tool.outputSchema ? zodToJsonSchema(tool.outputSchema) : undefined,
        tags: tool.tags ?? [],
      };
      return structuredResult(description);
    },
  });
}

// ── kernel_code_run ───────────────────────────────────────────────

const CodeRunInput = z.object({
  script: z
    .string()
    .max(64 * 1024)
    .describe(
      "JavaScript source. Available globals: `tool(name, args)` (async — calls " +
        "any kernel tool), `log(msg)`, `input` (the `vars` object below). " +
        "Return a value from the script body to expose it as `result`.",
    ),
  vars: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Variables exposed inside the script as `input`."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30_000)
    .default(5_000)
    .describe("Wall-clock timeout."),
});

const CodeRunOutput = z.object({
  result: z.unknown(),
  logs: z.array(z.string()),
  durationMs: z.number().int(),
});

export function buildCodeRun(
  getCatalog: () => ToolDefinition[],
  sandboxDeps: import("./code-runner.js").SandboxDeps = {},
): ToolDefinition {
  return defineTool({
    name: "kernel_code_run",
    description:
      "Run a small JS script that can call other kernel tools via `tool(name, args)`. " +
      "Use this to compose multiple tool calls in ONE inference round (e.g. " +
      "list-then-filter, create-then-run). Sandbox: no FS, no network, no require, " +
      "5s default wall-clock. Available helpers: `tool(name, args)` (async), `log(msg)`, " +
      "`input` (the `vars` object). Example: `const r = await tool(\"kernel_tasks_list\", {}); " +
      "return r.tasks.length`.",
    schema: CodeRunInput,
    outputSchema: CodeRunOutput,
    tags: ["meta", "code", "compose"],
    handler: async (input): Promise<ToolResult> => {
      const out = await runScript(input, getCatalog, sandboxDeps);
      return structuredResult(out);
    },
  });
}

// ── kernel_meta_elicit_confirm ────────────────────────────────────
// Demo / validation tool for the elicitation primitive. Asks the
// connected client to surface a yes/no confirmation form to the user,
// then echoes the choice. Tools that need mid-execution input (e.g.
// "this looks destructive — confirm?") follow the same pattern: import
// `elicit` from `core/elicit`, build a fields map, branch on the
// returned action.

const ElicitConfirmInput = z.object({
  message: z.string().describe("Question shown to the user."),
  default_value: z.boolean().optional(),
});

const ElicitConfirmOutput = z.object({
  action: z.enum(["accept", "decline", "cancel", "unsupported"]),
  confirmed: z.boolean().optional(),
  reason: z.string().optional(),
});

export function buildElicitConfirm(): ToolDefinition {
  return defineTool({
    name: "kernel_meta_elicit_confirm",
    description:
      "Server-initiated elicitation demo. Asks the connected client to display " +
      "a yes/no form and echoes the user's choice. Returns `action: \"unsupported\"` " +
      "(with a reason) when the client didn't declare the elicitation capability — " +
      "every real tool that uses elicitation must handle that branch explicitly.",
    schema: ElicitConfirmInput,
    outputSchema: ElicitConfirmOutput,
    tags: ["meta", "elicitation", "demo"],
    handler: async (input): Promise<ToolResult> => {
      const { message, default_value } = input;
      const outcome = await elicit<{ confirmed: boolean }>({
        message,
        fields: {
          confirmed: {
            type: "boolean",
            title: "Proceed?",
            description: "Tick to confirm. Untick to decline.",
            ...(default_value !== undefined ? { default: default_value } : {}),
          },
        },
        required: ["confirmed"],
      });
      switch (outcome.action) {
        case "accept":
          return structuredResult({
            action: "accept",
            confirmed: outcome.content.confirmed,
          }, `User ${outcome.content.confirmed ? "confirmed" : "declined"}: ${message}`);
        case "decline":
          return structuredResult({ action: "decline" }, "User declined the prompt.");
        case "cancel":
          return structuredResult({ action: "cancel" }, "User cancelled the prompt.");
        case "unsupported":
          return structuredResult(
            { action: "unsupported", reason: outcome.reason },
            `Elicitation not supported by this client: ${outcome.reason}`,
          );
      }
      // TS exhaustiveness — never reached at runtime.
      return textResult("unreachable");
    },
  });
}

// ── kernel_meta_render_card  (MCP applications proof point) ──────
//
// David's keynote opens with an "MCP application" — the server ships a UI
// the client renders, no plugin or SDK gymnastics. We expose the same idea
// here as a tiny generic surface: a tool that takes structured fields
// (title, body markdown, item list, accent color) and returns BOTH:
//
//   * `content[].text` — plaintext rendering for CLI / legacy clients.
//   * `_meta.ui`       — self-contained HTML that capable clients (Claude
//                        Desktop, ChatGPT, web harnesses) render as a real
//                        card surface.
//
// Once tests prove the wire shape, real domain tools (`kernel_dashboard_*`,
// `kernel_finance_summary`, etc.) can adopt the same `uiResult(...)`
// helper and turn into MCP applications by adding ~3 lines.

const RenderCardInput = z.object({
  title: z.string().describe("Card title shown as <h2>."),
  body: z.string().optional().describe("Markdown body. A small renderer turns it into HTML."),
  items: z.array(
    z.object({
      label: z.string(),
      value: z.string().optional(),
      hint: z.string().optional(),
    }),
  ).optional().describe("Optional list rendered as a <ul>."),
  accent: z.enum(["blue", "green", "amber", "rose", "violet"]).optional()
    .describe("Accent color name. Default: blue."),
});

const RenderCardOutput = z.object({
  rendered: z.boolean(),
  mimeType: z.string(),
  bytes: z.number().int(),
});

export function buildRenderCard(): ToolDefinition {
  return defineTool({
    name: "kernel_meta_render_card",
    description:
      "Render a card as an MCP-application UI surface. Returns both a plaintext " +
      "summary (for CLI / legacy clients) and an HTML body (for web-based clients " +
      "that opt into the `ui` content type — Claude Desktop, ChatGPT, web harnesses). " +
      "Use this as a template for any domain tool that wants to ship a real surface " +
      "instead of pasting markdown — wire `uiResult(...)` from `core/helpers.ts`.",
    schema: RenderCardInput,
    outputSchema: RenderCardOutput,
    tags: ["meta", "ui", "applications"],
    handler: async (input): Promise<ToolResult> => {
      const { title, body, items, accent } = input;
      const html = renderCardHtml({ title, body, items, accent });
      const text = renderCardText({ title, body, items });
      const out = { rendered: true, mimeType: "text/html", bytes: html.length };
      const result = uiResult(text, "text/html", html);
      // Layer the structured payload so clients on protocol ≥ 2025-03-26
      // can read it without parsing text. uiResult already supplies the
      // text + ui blocks; we add structuredContent here for symmetry.
      result.structuredContent = out;
      return result;
    },
  });
}

interface CardData {
  title: string;
  body?: string;
  items?: Array<{ label: string; value?: string; hint?: string }>;
  accent?: "blue" | "green" | "amber" | "rose" | "violet";
}

function renderCardText(c: CardData): string {
  const lines: string[] = [`# ${c.title}`];
  if (c.body) lines.push("", c.body);
  if (c.items && c.items.length > 0) {
    lines.push("");
    for (const it of c.items) {
      const v = it.value ? ` — ${it.value}` : "";
      const h = it.hint ? ` _(${it.hint})_` : "";
      lines.push(`- **${it.label}**${v}${h}`);
    }
  }
  return lines.join("\n");
}

const ACCENT_COLORS: Record<NonNullable<CardData["accent"]>, string> = {
  blue: "#2563eb",
  green: "#16a34a",
  amber: "#d97706",
  rose: "#e11d48",
  violet: "#7c3aed",
};

function renderCardHtml(c: CardData): string {
  const accent = ACCENT_COLORS[c.accent ?? "blue"];
  const escape = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Tiny markdown rendering: paragraphs, **bold**, `code`. No raw HTML
  // makes it past `escape` — the bold/code transforms run on the already-
  // escaped string, so script injection through {body} can't happen.
  const renderInline = (s: string): string =>
    escape(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const renderBody = (s: string): string =>
    s.split(/\n{2,}/).map((p) => `<p>${renderInline(p).replace(/\n/g, "<br/>")}</p>`).join("");

  const itemsHtml = c.items && c.items.length > 0
    ? `<ul class="kc-items">${c.items.map((it) => `
        <li>
          <span class="kc-label">${escape(it.label)}</span>
          ${it.value ? `<span class="kc-value">${escape(it.value)}</span>` : ""}
          ${it.hint ? `<span class="kc-hint">${escape(it.hint)}</span>` : ""}
        </li>`).join("")}</ul>`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  .kc-card { font: 14px/1.5 system-ui,-apple-system,sans-serif; max-width: 640px; padding: 16px 20px; border-radius: 12px; border: 1px solid rgba(0,0,0,.08); box-shadow: 0 1px 3px rgba(0,0,0,.04); background: #fff; color: #0f172a; }
  .kc-card h2 { margin: 0 0 8px; font-size: 18px; color: ${accent}; border-bottom: 2px solid ${accent}22; padding-bottom: 8px; }
  .kc-card p { margin: 6px 0; }
  .kc-card code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .kc-items { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 6px; }
  .kc-items li { display: grid; grid-template-columns: minmax(120px, max-content) 1fr auto; gap: 8px; padding: 6px 0; border-top: 1px dashed #e2e8f0; align-items: baseline; }
  .kc-items li:first-child { border-top: 0; }
  .kc-label { font-weight: 600; color: #475569; }
  .kc-value { color: #0f172a; }
  .kc-hint { color: #94a3b8; font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    .kc-card { background: #0f172a; color: #e2e8f0; border-color: rgba(255,255,255,.08); }
    .kc-card code { background: #1e293b; }
    .kc-items li { border-color: #1e293b; }
    .kc-label { color: #cbd5e1; }
    .kc-value { color: #f1f5f9; }
  }
</style></head>
<body><div class="kc-card">
  <h2>${escape(c.title)}</h2>
  ${c.body ? renderBody(c.body) : ""}
  ${itemsHtml}
</div></body></html>`;
}

// ── kernel_attest_identity / kernel_attest_verify ─────────────────
// Surface the attestation primitive: who signs receipts (identity) and
// how to validate any receipt the client previously received. Verify is
// stateless — it works on receipts from any peer as long as the receipt
// embeds its `server_id`.

const AttestIdentityOutput = z.object({
  enabled: z.boolean(),
  server_id: z.string().optional(),
});

export function buildAttestIdentity(getIdentity?: () => Identity | undefined): ToolDefinition {
  return defineToolNoInput({
    name: "kernel_attest_identity",
    description:
      "Return this kernel's Ed25519 attestation identity (server_id) and " +
      "whether attestation is currently enabled. Clients pin this fingerprint " +
      "and verify every receipt against it.",
    outputSchema: AttestIdentityOutput,
    tags: ["meta", "attestation", "identity"],
    handler: async (): Promise<ToolResult> => {
      const id = getIdentity?.();
      if (!id) return structuredResult({ enabled: false });
      return structuredResult({ enabled: true, server_id: id.serverId() });
    },
  });
}

const AttestVerifyInput = z.object({
  receipt: z.object({
    v: z.number(),
    tool: z.string(),
    input_hash: z.string(),
    output_hash: z.string(),
    side_effects: z.array(z.string()),
    ts_ms: z.number(),
    server_id: z.string(),
    sig: z.string(),
  }).describe("Full receipt object as it appeared in `_meta.mtw.attestation`."),
});

const AttestVerifyOutput = z.object({
  valid: z.boolean(),
  tool: z.string().optional(),
  server_id: z.string().optional(),
  ts_ms: z.number().optional(),
  side_effects: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

export function buildAttestVerify(): ToolDefinition {
  return defineTool({
    name: "kernel_attest_verify",
    description:
      "Verify a previously-issued attestation receipt against its embedded " +
      "`server_id`. Stateless verification — does not check whether you " +
      "actually trust that signing identity. Wire-compatible with the Rust " +
      "mtw-attest crate.",
    schema: AttestVerifyInput,
    outputSchema: AttestVerifyOutput,
    tags: ["meta", "attestation", "verify"],
    handler: async (input): Promise<ToolResult> => {
      const { receipt } = input;
      const result = verifyReceipt(receipt as Receipt);
      if (result.valid) {
        return structuredResult({
          valid: true,
          tool: receipt.tool,
          server_id: receipt.server_id,
          ts_ms: receipt.ts_ms,
          side_effects: receipt.side_effects,
        });
      }
      return structuredResult({
        valid: false,
        tool: receipt.tool,
        server_id: receipt.server_id,
        ts_ms: receipt.ts_ms,
        side_effects: receipt.side_effects,
        reason: result.reason,
      });
    },
  });
}

// ── kernel_meta_cost_report ───────────────────────────────────────
// Top-N tools by accumulated dollar cost, fed by the rolling p50 stats
// CostRouter maintains. Use this to answer "what's eating my budget".

const CostReportInput = z.object({
  limit: z.number().int().positive().max(100).default(10),
});

const CostReportOutput = z.object({
  enabled: z.boolean(),
  rows: z.array(
    z.object({
      tool: z.string(),
      total_usd: z.number(),
      samples: z.number().int(),
      avg_latency_ms: z.number(),
    }),
  ),
});

export function buildCostReport(getCostRouter?: () => CostRouter | undefined): ToolDefinition {
  return defineTool({
    name: "kernel_meta_cost_report",
    description:
      "Top-N tools by accumulated dollar cost. Sourced from rolling p50 " +
      "stats the cost router maintains across runs. Returns enabled=false " +
      "when the cost router isn't wired in.",
    schema: CostReportInput,
    outputSchema: CostReportOutput,
    tags: ["meta", "cost", "telemetry"],
    cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 5, reversible: true, cacheable: true },
    handler: async (input): Promise<ToolResult> => {
      const { limit } = input;
      const router = getCostRouter?.();
      if (!router) return structuredResult({ enabled: false, rows: [] });
      const rows = router.topByCost(limit);
      return structuredResult({ enabled: true, rows });
    },
  });
}

// ── kernel_attest_verify_chain ────────────────────────────────────
// Validates a plan receipt + its child receipts as a chain. Three
// guarantees (in order of failure granularity):
//   1. The plan receipt's own signature is valid.
//   2. Every child receipt is individually signed correctly.
//   3. The merkle root computed from the children matches the one
//      embedded in the plan receipt.
// Any one of those failing means the audit trail is compromised —
// the verifier returns the specific reason so callers can act on it.

const VerifyChainInput = z.object({
  plan_receipt: z.object({
    v: z.number(),
    kind: z.literal("plan"),
    plan_id: z.string(),
    merkle_root: z.string(),
    node_count: z.number().int(),
    succeeded_count: z.number().int(),
    node_summary: z.array(z.string()),
    ts_ms: z.number(),
    server_id: z.string(),
    sig: z.string(),
  }),
  child_receipts: z.array(z.object({
    v: z.number(),
    tool: z.string(),
    input_hash: z.string(),
    output_hash: z.string(),
    side_effects: z.array(z.string()),
    ts_ms: z.number(),
    server_id: z.string(),
    sig: z.string(),
  })),
});

const VerifyChainOutput = z.object({
  valid: z.boolean(),
  child_failures: z.number().int().optional(),
  reason: z.string().optional(),
  plan_id: z.string().optional(),
  server_id: z.string().optional(),
});

export function buildAttestVerifyChain(): ToolDefinition {
  return defineTool({
    name: "kernel_attest_verify_chain",
    description:
      "Verify a plan receipt + its child receipts as one chained audit. " +
      "Returns valid only when (1) the plan receipt's own signature checks out, " +
      "(2) every child verifies, and (3) the merkle root of the children matches " +
      "the one inside the plan receipt. Stateless — works on chains from any peer.",
    schema: VerifyChainInput,
    outputSchema: VerifyChainOutput,
    tags: ["meta", "attestation", "verify", "plans"],
    cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 30, reversible: true, cacheable: true },
    handler: async (input): Promise<ToolResult> => {
      const { plan_receipt, child_receipts } = input;
      const result = verifyChain({
        planReceipt: plan_receipt as PlanReceipt,
        childReceipts: child_receipts as Receipt[],
      });
      if (result.valid) {
        return structuredResult({
          valid: true,
          child_failures: result.child_failures,
          plan_id: plan_receipt.plan_id,
          server_id: plan_receipt.server_id,
        });
      }
      return structuredResult({
        valid: false,
        reason: result.reason,
        plan_id: plan_receipt.plan_id,
        server_id: plan_receipt.server_id,
      });
    },
  });
}
