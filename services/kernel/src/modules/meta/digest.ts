import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../../core/types.js";
import { errorResult, structuredResult } from "../../core/helpers.js";
import { RankingService } from "../../core/ranking/service.js";
import { mapReduce, type DigestItem } from "./digest-engine.js";
import { defineTool } from "../../core/tool-builder.js";

export interface DigestDefaults {
  k: number;
  chunkSize: number;
  concurrency: number;
  cooldownMs: number;
  maxItems: number;
}

export interface DigestDeps {
  getCatalog: () => ToolDefinition[];
  ranking: RankingService;
  complete: (system: string, user: string) => Promise<{ text: string; tokens: number }>;
  defaults: DigestDefaults;
}

const SourceSchema = z.union([
  z.object({
    tool: z.string().describe("Kernel tool to call for the source rows."),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    items: z.array(z.unknown()).describe("Inline source rows."),
  }),
]);

const DigestInput = z.object({
  source: SourceSchema,
  query: z.string().optional().describe("If set, rank the source to top-k before digesting."),
  map_instruction: z.string().describe("How to summarize each chunk."),
  reduce_instruction: z.string().describe("How to combine chunk summaries."),
  k: z.number().int().positive().optional(),
  chunk_size: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  cooldown_ms: z.number().int().nonnegative().optional(),
  max_items: z.number().int().positive().optional(),
  id_key: z.string().optional().describe("Field to use as item id (default: id)."),
  text_key: z.string().optional().describe("Field to use as item text (default: title/name/text/body or JSON)."),
});

const DigestOutput = z.object({
  digest: z.string(),
  citations: z.array(z.string()),
  chunks_processed: z.number().int(),
  chunks_failed: z.number().int(),
  items_truncated: z.number().int(),
  degraded: z.boolean(),
  tokens: z.number().int(),
});

/** Pull the row array out of a tool's structured result. */
function extractItems(structured: unknown): unknown[] {
  if (Array.isArray(structured)) return structured;
  if (structured && typeof structured === "object") {
    for (const v of Object.values(structured as Record<string, unknown>)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function toDigestItem(row: unknown, i: number, idKey: string, textKey?: string): DigestItem {
  const obj = (row && typeof row === "object" ? row : { value: row }) as Record<string, unknown>;
  const id = obj[idKey] !== undefined ? String(obj[idKey]) : `idx-${i}`;
  let text: string;
  if (textKey && obj[textKey] !== undefined) {
    text = String(obj[textKey]);
  } else {
    const cand = obj.title ?? obj.name ?? obj.text ?? obj.body;
    text = cand !== undefined ? String(cand) : JSON.stringify(obj);
  }
  return { id, text };
}

export function buildDigest(deps: DigestDeps): ToolDefinition {
  const d = deps.defaults;
  return defineTool({
    name: "kernel_research_digest",
    description:
      "Summarize a large source (a kernel tool's output or an inline list) WITHOUT loading the " +
      "raw rows into your context. Ranks to top-k (when `query` set), chunks, runs a bounded " +
      "map-reduce with concurrency + cooldown caps, and returns a grounded digest with citations. " +
      "Use this instead of listing a big inventory and summarizing it yourself.",
    schema: DigestInput,
    outputSchema: DigestOutput,
    tags: ["meta", "research", "digest", "map-reduce"],
    async handler(p): Promise<ToolResult> {
      const idKey = p.id_key ?? "id";

      // 1. RESOLVE source
      const src = p.source as
        | { items: unknown[] }
        | { tool: string; args: Record<string, unknown> };
      let rows: unknown[];
      if ("items" in src) {
        rows = src.items;
      } else {
        const toolSrc = src as { tool: string; args: Record<string, unknown> };
        const def = deps.getCatalog().find((t) => t.name === toolSrc.tool);
        if (!def) return errorResult(`research_digest: source tool not found: ${toolSrc.tool}`);
        let res: ToolResult;
        try {
          const parsed = def.inputSchema.parse(toolSrc.args ?? {});
          res = await def.handler(parsed);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          return errorResult(`research_digest: source tool ${toolSrc.tool} threw: ${m}`);
        }
        if (res.isError) {
          const text = res.content.map((c) => c.text).join("\n");
          return errorResult(`research_digest: source tool ${toolSrc.tool} failed: ${text}`);
        }
        rows = extractItems(res.structuredContent ?? res.content);
      }

      let items = rows.map((r, i) => toDigestItem(r, i, idKey, p.text_key));
      const total = items.length;
      let itemsTruncated = 0;
      let degraded = false;

      // 2. CAP + RANK
      const k = p.k ?? d.k;
      const maxItems = p.max_items ?? d.maxItems;
      if (p.query && p.query.trim()) {
        const ranked = await deps.ranking.rankAndPage({
          items,
          query: p.query,
          key: (it) => ({ id: it.id, text: it.text }),
          k,
        });
        degraded = ranked.degraded;
        itemsTruncated = Math.max(0, total - ranked.ranked.length);
        items = ranked.ranked;
      } else if (total > maxItems) {
        items = items.slice(0, maxItems);
        itemsTruncated = total - maxItems;
      }

      // 3-5. CHUNK -> MAP -> REDUCE
      const mr = await mapReduce(
        {
          items,
          mapInstruction: p.map_instruction,
          reduceInstruction: p.reduce_instruction,
          chunkSize: p.chunk_size ?? d.chunkSize,
          concurrency: p.concurrency ?? d.concurrency,
          cooldownMs: p.cooldown_ms ?? d.cooldownMs,
        },
        { complete: deps.complete },
      );

      // 6. RETURN
      const summary =
        `Digest of ${total} item(s)` +
        (itemsTruncated ? ` (capped to ${items.length}, ${itemsTruncated} truncated)` : "") +
        (mr.chunksFailed ? ` — ${mr.chunksFailed} chunk(s) failed` : "") +
        (degraded ? " — ranking degraded (no embeddings)" : "") +
        `:\n\n${mr.digest}`;

      return structuredResult(
        {
          digest: mr.digest,
          citations: mr.citations,
          chunks_processed: mr.chunksProcessed,
          chunks_failed: mr.chunksFailed,
          items_truncated: itemsTruncated,
          degraded,
          tokens: mr.tokens,
        },
        summary,
      );
    },
  });
}
