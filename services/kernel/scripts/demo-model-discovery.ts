/**
 * Demo: LLM model discovery against your REAL providers.
 *
 *   bun run scripts/demo-model-discovery.ts
 *
 * Boots the LLM provider registry from your kernel.db (real keys), polls each
 * provider's live model list, then cross-checks every configured model ref
 * (global config + per-agent model_chain) against what's actually available
 * right now — flagging vanished models and suggesting a same-family successor.
 *
 * Writes NOTHING to kernel.db: the catalog lives in an in-memory DB. Pure read
 * of your real config/agents + live HTTP probes. Safe to run while the kernel
 * container is up.
 */

import { Database } from "bun:sqlite";
import { loadConfig } from "../src/core/config.js";
import { LlmProviderRegistry } from "../src/core/llm/provider-registry.js";
import { registerBuiltinLlmProviders } from "../src/core/llm/providers/index.js";
import { classifyModel } from "../src/core/llm/model-traits.js";
import { ModelCatalog } from "../src/core/llm/model-catalog.js";
import {
  suggestSuccessor,
  formatDiscoveryNotification,
  normalizeSlug,
  type BrokenRef,
} from "../src/core/llm/model-discovery.js";
import type { KernelConfig } from "../src/core/config.js";

interface ConfiguredRef {
  location: string;
  kind: "config" | "agent";
  configKey?: string;
  agentId?: string;
  slug: string; // normalized
  model: string;
}

/** Same scan as findBrokenRefs, but WITHOUT the isGone gate — returns every
 *  configured (slug, model) ref so we can check each against the live list. */
function collectConfiguredRefs(config: KernelConfig, db: Database): ConfiguredRef[] {
  const out: ConfiguredRef[] = [];
  const push = (r: Omit<ConfiguredRef, "slug"> & { slug: string }): void => {
    const slug = normalizeSlug(r.slug);
    if (r.model && slug) out.push({ ...r, slug });
  };

  const a = config.agents;
  const c = config.chat;
  (a?.defaultModelChain ?? []).forEach((e, i) =>
    push({ location: `config: AGENTS_DEFAULT_MODEL_CHAIN[${i}]`, kind: "config", configKey: "AGENTS_DEFAULT_MODEL_CHAIN", slug: e.provider, model: e.model }),
  );
  if (a?.defaultModel) push({ location: "config: AGENTS_DEFAULT_MODEL", kind: "config", configKey: "AGENTS_DEFAULT_MODEL", slug: a.defaultProvider, model: a.defaultModel });
  if (a?.evalModel) push({ location: "config: AGENTS_EVAL_MODEL", kind: "config", configKey: "AGENTS_EVAL_MODEL", slug: a.evalProvider || a.defaultProvider, model: a.evalModel });
  if (c?.defaultModel) push({ location: "config: CHAT_DEFAULT_MODEL", kind: "config", configKey: "CHAT_DEFAULT_MODEL", slug: c.defaultProvider, model: c.defaultModel });
  if (c?.extractionModel) push({ location: "config: CHAT_EXTRACTION_MODEL", kind: "config", configKey: "CHAT_EXTRACTION_MODEL", slug: c.defaultProvider, model: c.extractionModel });

  let rows: Array<{ id: string; name: string; model_chain: string }> = [];
  try {
    rows = db.prepare("SELECT id, name, model_chain FROM agents WHERE model_chain IS NOT NULL AND model_chain != ''").all() as typeof rows;
  } catch { rows = []; }
  for (const r of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(r.model_chain); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const e of parsed as Array<{ provider?: string; model?: string }>) {
      if (e?.model) push({ location: `agent: ${r.name}`, kind: "agent", agentId: r.id, slug: e.provider ?? "", model: e.model });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(config.sqlite.path); // read-write open; we only READ it
  console.log(`\n📦 kernel.db: ${config.sqlite.path}\n`);

  const registry = new LlmProviderRegistry();
  registry.setDb(db);
  if (config.encryption.key) registry.setEncryptionKey(config.encryption.key);
  registerBuiltinLlmProviders(registry);
  await registry.startAll();

  const slugs = registry.getRunningSlugs();
  console.log(`🚀 Running providers: ${slugs.join(", ") || "(none — check API keys in .env / kernel.db)"}\n`);

  // ── Section A: live models per provider ──
  console.log("──────────── LIVE MODELS (chat-capable) ────────────");
  const live: Record<string, string[] | null> = {};
  for (const slug of slugs) {
    const provider = registry.getProvider(slug);
    if (!provider?.listModels) {
      console.log(`  ${slug}: (no listModels — e.g. SDK provider)`);
      live[slug] = null;
      continue;
    }
    try {
      const all = await provider.listModels();
      const chat = all.filter((m) => classifyModel(slug, m).chat);
      live[slug] = chat;
      const sample = chat.slice(0, 12).join(", ");
      console.log(`  ${slug}: ${chat.length} model(s)${chat.length ? ` — ${sample}${chat.length > 12 ? ", …" : ""}` : ""}`);
    } catch (err) {
      live[slug] = null;
      console.log(`  ${slug}: ⚠️ listModels failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Section B: configured refs health ──
  // Seed an in-memory catalog with the live lists so suggestSuccessor has
  // candidates to pick from.
  const catalog = new ModelCatalog(new Database(":memory:"));
  for (const [slug, list] of Object.entries(live)) {
    if (list && list.length) catalog.recordDiscovery(slug, list);
  }

  console.log("\n──────────── CONFIGURED REFS HEALTH ────────────");
  const refs = collectConfiguredRefs(config, db);
  if (refs.length === 0) {
    console.log("  (no model refs configured — empty chains everywhere)");
  }
  const broken: BrokenRef[] = [];
  for (const ref of refs) {
    const list = live[ref.slug];
    if (list === undefined) {
      console.log(`  ❔ ${ref.slug}/${ref.model} [${ref.location}] — provider not running, can't verify`);
      continue;
    }
    // Same guard as the real cron: a provider returning null (no endpoint) or an
    // empty list (unreachable / nothing loaded) is SKIPPED — we never flag its
    // refs as gone off an empty response, or grok/lmstudio being down would
    // wrongly condemn every model configured under them.
    if (list === null || list.length === 0) {
      console.log(`  ❔ ${ref.slug}/${ref.model} [${ref.location}] — provider returned no models, can't verify (skipped, as the cron would)`);
      continue;
    }
    if (list.includes(ref.model)) {
      console.log(`  ✅ ${ref.slug}/${ref.model} [${ref.location}]`);
    } else {
      const suggestion = suggestSuccessor(catalog, ref.slug, ref.model);
      const fix = suggestion ? `→ suggest ${suggestion}` : "(no clear successor)";
      console.log(`  🚫 ${ref.slug}/${ref.model} [${ref.location}] MISSING upstream ${fix}`);
      broken.push({ ...ref, suggestion });
    }
  }

  // ── Section C: what the cron would notify ──
  console.log("\n──────────── NOTIFICATION PREVIEW ────────────");
  const note = formatDiscoveryNotification({ added: [], removed: broken.map((b) => ({ slug: b.slug, model: b.model })), brokenRefs: broken });
  if (note) {
    console.log(`  title: ${note.title}`);
    console.log(note.body.split("\n").map((l) => `  ${l}`).join("\n"));
  } else {
    console.log("  (nothing to notify — every configured model is still live)");
  }

  await registry.stopAll();
  db.close();
  console.log("\n✓ done\n");
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
