/**
 * Find out, by asking, which models can call tools.
 *
 * LiteLLM knows nothing about NVIDIA's catalogue (0 of 68 models on a live
 * install) and NVIDIA's /models says nothing either, so every one of them
 * reached the Chief's picker as "not verified". Each unknown model gets the
 * same request "Probar" sends when a provider is connected (provider-probe.ts):
 * one trivial tool and an instruction to call it.
 *
 *   tool call back      → yes (call-log already records that; stored again here)
 *   prose instead       → no: asked for a tool and did not use one
 *   timeout, 404, 5xx…  → unknown, retried on the next pass
 *
 * Cost is bounded: free providers are checked in full; paid ones only for
 * models priced at most MAX_OUTPUT_PER_MTOK, a few per pass. A model never
 * priced on a paid provider is left for the operator to try.
 */

import type { SqliteDb } from "../db/sqlite.js";
import { log } from "../logger.js";
import type { ChatLlmProvider } from "./chat-provider.js";
import { isToolsUnsupportedError, observeToolSupport, toolSupportFor } from "./model-caps.js";
import { classifyModel } from "./model-traits.js";
import { probeAdapter } from "./provider-probe.js";
import { PROBE_CALLER } from "./chat-instrumentation.js";

/** Providers whose calls cost the operator nothing (free tier or local). */
const FREE = new Set(["nvidia", "ollama", "lmstudio"]);
/** Never ask the Claude Code shim: its SDK runs tools itself. */
const SKIP = new Set(["claude-code", "claude_code"]);
const MAX_OUTPUT_PER_MTOK = 20;
const MAX_FREE_PER_PASS = 100;
const MAX_PAID_PER_PASS = 15;

export interface VerifyDeps {
  db: SqliteDb;
  /** Running chat adapters by slug. */
  adapters: Map<string, ChatLlmProvider>;
  /** Model ids per running provider. */
  listModels: (slug: string) => Promise<string[]>;
  /** USD per MTok of output, when priced. */
  outputPrice: (slug: string, model: string) => number | undefined;
  timeoutMs?: number;
  concurrency?: number;
}

export interface VerifyReport {
  slug: string;
  checked: number;
  yes: number;
  no: number;
  inconclusive: number;
}

/** Which unknown models of `slug` this pass may spend a request on. */
export function modelsToVerify(
  slug: string,
  unknown: string[],
  outputPrice: (slug: string, model: string) => number | undefined,
): string[] {
  if (SKIP.has(slug)) return [];
  if (FREE.has(slug)) return unknown.slice(0, MAX_FREE_PER_PASS);
  return unknown
    .filter((m) => {
      const p = outputPrice(slug, m);
      return p !== undefined && p <= MAX_OUTPUT_PER_MTOK;
    })
    .slice(0, MAX_PAID_PER_PASS);
}

export async function verifyProvider(slug: string, deps: VerifyDeps): Promise<VerifyReport> {
  const report: VerifyReport = { slug, checked: 0, yes: 0, no: 0, inconclusive: 0 };
  const adapter = deps.adapters.get(slug);
  if (!adapter || adapter.supportsToolLoop === false || SKIP.has(slug)) return report;

  const chat = (await deps.listModels(slug)).filter((id) => classifyModel(slug, id).chat);
  const known = toolSupportFor(deps.db, slug, chat);
  const unknown = chat.filter((id) => known.get(id) === undefined);
  const queue = modelsToVerify(slug, unknown, deps.outputPrice);

  const timeoutMs = deps.timeoutMs ?? 45_000;
  const worker = async () => {
    for (let model = queue.shift(); model !== undefined; model = queue.shift()) {
      report.checked++;
      const r = await probeAdapter(adapter, { model, timeoutMs, local: FREE.has(slug) && slug !== "nvidia", caller: PROBE_CALLER });
      if (r.ok && r.toolCall) {
        observeToolSupport(deps.db, slug, model, true);
        report.yes++;
      } else if (r.error?.code === "no_tools" || isToolsUnsupportedError(r.error?.detail ?? "")) {
        observeToolSupport(deps.db, slug, model, false);
        report.no++;
      } else {
        report.inconclusive++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency ?? 2) }, worker));
  return report;
}

/** Every running provider, one after another. Never throws. */
export async function verifyAll(deps: VerifyDeps): Promise<VerifyReport[]> {
  const out: VerifyReport[] = [];
  // The map carries aliases ("claude_code" next to "claude-code"): one pass per adapter.
  const seen = new Set<ChatLlmProvider>();
  for (const [slug, adapter] of deps.adapters) {
    if (seen.has(adapter)) continue;
    seen.add(adapter);
    try {
      const r = await verifyProvider(slug, deps);
      if (r.checked > 0) {
        out.push(r);
        log.info(`tool verify: ${slug} — ${r.yes} yes, ${r.no} no, ${r.inconclusive} inconclusive of ${r.checked}`);
      }
    } catch (e) {
      log.warn(`tool verify: ${slug} skipped — ${String(e).slice(0, 160)}`);
    }
  }
  return out;
}
