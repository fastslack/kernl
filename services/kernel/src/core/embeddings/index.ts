/**
 * Embeddings client factory.
 *
 * The factory builds a primary + fallback chain that mirrors the LLM chain
 * configured on /models (`config.agents.defaultModelChain`). Same providers,
 * same credentials — so when the user adds an OpenAI / NVIDIA / Ollama key
 * for chat, embeddings get it for free.
 *
 * Order of construction:
 *   1. Start with the explicit `EMBEDDINGS_PROVIDER` (back-compat with the
 *      legacy single-provider config). When set to "lmstudio" or "local",
 *      that becomes the primary and the chain is bypassed entirely — the
 *      user wanted exactly one backend, give them exactly one.
 *   2. Otherwise build a chain from `config.agents.defaultModelChain`:
 *      - For each entry whose provider has an embeddings API
 *        (openai / nvidia / lmstudio / ollama), materialize a client.
 *      - Each client uses per-provider default embedding model + dim (see
 *        `PROVIDER_DEFAULTS` below) UNLESS the user pinned one via env
 *        (e.g. `EMBEDDINGS_MODEL_OPENAI`).
 *      - The first link with a valid configuration becomes primary; the
 *        rest become fallbacks. Fallbacks with incompatible (model, dim)
 *        get filtered out inside `ChainedEmbeddings` so the Neo4j index
 *        never sees mismatched vectors.
 *   3. Append `LocalEmbeddings` (MiniLM, in-process) as the absolute final
 *      fallback ONLY when the resolved primary is also 384d MiniLM —
 *      otherwise local would corrupt a non-MiniLM index, which is worse
 *      than failing the call. Users who want local fallback for a non-
 *      MiniLM primary should set `EMBEDDINGS_PROVIDER=local`.
 *
 * The chain's `.model` and `.dim` always reflect the PRIMARY link — that's
 * what consumers use for Neo4j index naming and reembed bookkeeping.
 */

import { log } from "../logger.js";
import type { KernelConfig } from "../config.js";
import type { EmbeddingsClient } from "./client.js";
import { LmStudioEmbeddings } from "./lmstudio.js";
import { LocalEmbeddings } from "./local.js";
import { OpenAiCompatEmbeddings, type OpenAiCompatOptions } from "./openai-compat.js";
import { ChainedEmbeddings } from "./chain.js";

export { type EmbeddingsClient, type EmbeddingsProvider, safeIndexSuffix } from "./client.js";
export { LmStudioEmbeddings } from "./lmstudio.js";
export { LocalEmbeddings } from "./local.js";
export { OpenAiCompatEmbeddings } from "./openai-compat.js";
export { ChainedEmbeddings } from "./chain.js";

/** Per-provider default embedding model + dim. Used when the user hasn't
 *  pinned an override via env vars. Picked for retrieval quality and broad
 *  availability on each platform. */
const PROVIDER_DEFAULTS: Record<
  "openai" | "nvidia" | "ollama" | "lmstudio",
  { model: string; dim: number; baseUrl?: string; extraBody?: Record<string, unknown> }
> = {
  // OpenAI: text-embedding-3-small is the modern default — cheap, good quality.
  openai: {
    model: "text-embedding-3-small",
    dim: 1536,
    baseUrl: "https://api.openai.com/v1",
  },
  // NVIDIA NIM: nv-embedqa-e5-v5 is retrieval-tuned, OpenAI-compatible,
  // and matches bge-m3's 1024d so it's an ideal fallback when LMStudio
  // bge-m3 goes down.
  nvidia: {
    model: "nvidia/nv-embedqa-e5-v5",
    dim: 1024,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    extraBody: { input_type: "passage" },
  },
  // Ollama: bge-m3 is the canonical model after `ollama pull bge-m3`.
  // Ollama's OpenAI-compatible server lives at /v1.
  ollama: {
    model: "bge-m3",
    dim: 1024,
    baseUrl: "http://127.0.0.1:11434/v1",
  },
  // LMStudio: matches the legacy EMBEDDINGS_MODEL default (text-embedding-bge-m3)
  // — what's already populating the Neo4j index for cinema.
  lmstudio: {
    model: "text-embedding-bge-m3",
    dim: 1024,
    // baseUrl resolved from config.embeddings.baseUrl at link time.
  },
};

interface ResolvedLinkConfig {
  provider: "openai" | "nvidia" | "ollama" | "lmstudio";
  model: string;
  dim: number;
  baseUrl: string;
  apiKey: string;
  extraBody?: Record<string, unknown>;
}

/** Resolve a (provider, model) chain entry into a fully-specified embedding
 *  link, applying per-provider defaults + env overrides. Returns null when
 *  the provider has no embeddings API or no credentials. */
function resolveLink(
  kernelProvider: string,
  config: KernelConfig,
): ResolvedLinkConfig | null {
  // Normalize aliases. The chat chain uses "claude" / "claude-code" / etc.,
  // none of which serve embeddings — drop them silently.
  const slug = kernelProvider.toLowerCase();
  switch (slug) {
    case "openai": {
      const apiKey = config.webIntel.openaiApiKey;
      if (!apiKey) return null;
      const d = PROVIDER_DEFAULTS.openai;
      return {
        provider: "openai",
        model: process.env.EMBEDDINGS_MODEL_OPENAI ?? d.model,
        dim: parseInt(process.env.EMBEDDINGS_DIM_OPENAI ?? String(d.dim), 10),
        baseUrl: process.env.OPENAI_EMBEDDINGS_BASE_URL ?? d.baseUrl!,
        apiKey,
      };
    }
    case "nvidia":
    case "nim": {
      const apiKey = config.webIntel.nvidiaApiKey;
      if (!apiKey) return null;
      const d = PROVIDER_DEFAULTS.nvidia;
      return {
        provider: "nvidia",
        model: process.env.EMBEDDINGS_MODEL_NVIDIA ?? d.model,
        dim: parseInt(process.env.EMBEDDINGS_DIM_NVIDIA ?? String(d.dim), 10),
        baseUrl: process.env.NVIDIA_EMBEDDINGS_BASE_URL ?? d.baseUrl!,
        apiKey,
        extraBody: d.extraBody,
      };
    }
    case "ollama": {
      const d = PROVIDER_DEFAULTS.ollama;
      // Ollama doesn't need a key. Reuse the chat baseUrl when present
      // (stripped down to /v1) — otherwise fall back to the default.
      const base = process.env.OLLAMA_EMBEDDINGS_BASE_URL ?? d.baseUrl!;
      return {
        provider: "ollama",
        model: process.env.EMBEDDINGS_MODEL_OLLAMA ?? d.model,
        dim: parseInt(process.env.EMBEDDINGS_DIM_OLLAMA ?? String(d.dim), 10),
        baseUrl: base,
        apiKey: "",
      };
    }
    case "lmstudio": {
      // LMStudio uses the global embeddings.model + dim (and the lmstudio
      // baseUrl from /models). This preserves the current behavior — the
      // legacy EMBEDDINGS_MODEL/DIM still pins the LMStudio link.
      const base = config.embeddings.baseUrl
        || config.webIntel.lmstudioBaseUrl
        || "http://127.0.0.1:1234/v1";
      // Normalize /chat/completions tails that may have leaked in from the
      // chat chain config.
      const normalized = base.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
      return {
        provider: "lmstudio",
        model: config.embeddings.model || PROVIDER_DEFAULTS.lmstudio.model,
        dim: config.embeddings.dim || PROVIDER_DEFAULTS.lmstudio.dim,
        baseUrl: normalized,
        apiKey: "",
      };
    }
    // Providers without embeddings APIs — chat-only.
    case "grok":
    case "xai":
    case "claude":
    case "anthropic":
    case "claude-code":
    case "claude_code":
      return null;
    default:
      return null;
  }
}

function instantiate(link: ResolvedLinkConfig): EmbeddingsClient {
  const opts: OpenAiCompatOptions = {
    provider: link.provider,
    baseUrl: link.baseUrl,
    model: link.model,
    dim: link.dim,
    apiKey: link.apiKey,
    extraBody: link.extraBody,
  };
  return new OpenAiCompatEmbeddings(opts);
}

export async function createEmbeddingsClient(config: KernelConfig): Promise<EmbeddingsClient> {
  const cfg = config.embeddings;

  // Legacy single-provider escape hatch — preserved so users with an
  // explicit EMBEDDINGS_PROVIDER=local or =lmstudio still get exactly one
  // backend (no surprise chain). The default ("auto") flows through to the
  // chain builder below.
  if (cfg.provider === "local") {
    const c = new LocalEmbeddings();
    log.info(`embeddings: local ${c.model} (dim=${c.dim}) [forced]`);
    return c;
  }

  if (cfg.provider === "lmstudio") {
    const c = new LmStudioEmbeddings(cfg.baseUrl, cfg.model, cfg.dim);
    const ok = await c.available();
    if (ok) {
      log.info(`embeddings: lmstudio ${cfg.model} (dim=${cfg.dim}) @ ${cfg.baseUrl} [forced]`);
      return c;
    }
    throw new Error(
      `LMStudio embeddings unreachable at ${cfg.baseUrl} or model '${cfg.model}' not loaded. ` +
      `Switch EMBEDDINGS_PROVIDER to 'auto' to enable /models fallback chain, or 'local' for in-process MiniLM.`,
    );
  }

  // === Chain build (provider === "auto") =================================
  // Walk defaultModelChain, materialize embedding clients for any provider
  // that has an embeddings API. Always prepend the legacy LMStudio config
  // (it's the one currently feeding the cinema index) so existing setups
  // keep working without re-touching env vars.
  const candidates: ResolvedLinkConfig[] = [];

  // 1. Legacy LMStudio link first — same defaults the catalog already uses.
  const lmsLegacy = resolveLink("lmstudio", config);
  if (lmsLegacy) candidates.push(lmsLegacy);

  // 2. /models providers in user-configured order. De-duplicate against the
  //    legacy LMStudio link by (provider, baseUrl).
  const seen = new Set(candidates.map((c) => `${c.provider}@${c.baseUrl}`));
  for (const entry of config.agents.defaultModelChain ?? []) {
    const link = resolveLink(entry.provider, config);
    if (!link) continue;
    const key = `${link.provider}@${link.baseUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(link);
  }

  // 3. Auto-discover providers whose keys are present in env even when the
  //    user's /models chain only lists chat-only providers (e.g. claude_code).
  //    Without this, an embeddings-capable NVIDIA / OpenAI key sits idle and
  //    the chain collapses to the last-resort MiniLM with a 384d index that
  //    silently re-embeds the whole catalog at the wrong shape.
  //    Order: NVIDIA before OpenAI (NVIDIA's nv-embedqa-e5-v5 has a free tier
  //    and matches the 1024d shape currently in the cinema vector index).
  for (const auto of ["nvidia", "openai"] as const) {
    const link = resolveLink(auto, config);
    if (!link) continue;
    const key = `${link.provider}@${link.baseUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(link);
  }

  // Build EmbeddingsClient instances and probe in order — primary is the
  // FIRST link whose `available()` returns true. Skipping dead links at the
  // chain head avoids "every call retries the dead primary first" overhead.
  const builtClients: EmbeddingsClient[] = candidates.map(instantiate);
  let primaryIdx = -1;
  for (let i = 0; i < builtClients.length; i++) {
    const c = builtClients[i];
    try {
      if (await c.available()) {
        primaryIdx = i;
        log.info(
          `embeddings: chain primary = ${c.provider} ${c.model} (dim=${c.dim}) ` +
          `[${candidates[i].baseUrl}]`,
        );
        break;
      }
      log.warn(
        `embeddings: chain link ${c.provider} ${c.model} unavailable at ${candidates[i].baseUrl} — ` +
        `skipping for primary`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`embeddings: probe failed for ${c.provider} — ${msg.slice(0, 160)}`);
    }
  }

  if (primaryIdx >= 0) {
    const primary = builtClients[primaryIdx];
    // Fallbacks = remaining built clients in original chain order (skip the
    // ones above the primary that failed the probe, since they're cold; the
    // chain may still try them at embed time, but they probably won't help).
    const fallbacks = builtClients.slice(primaryIdx + 1);
    // Append LocalEmbeddings ONLY when shape-compatible with the primary.
    // Otherwise it would scribble MiniLM vectors into a non-MiniLM index.
    if (primary.model === "Xenova/all-MiniLM-L6-v2" && primary.dim === 384) {
      fallbacks.push(new LocalEmbeddings());
    }
    if (fallbacks.length === 0) return primary;
    const chained = new ChainedEmbeddings(primary, fallbacks);
    log.info(
      `embeddings: chain depth ${chained.describe().length} ` +
      `(${chained.describe().map((d) => d.provider).join(" → ")})`,
    );
    return chained;
  }

  // No /models link works → absolute final fallback: in-process MiniLM.
  // This will produce 384d vectors into a different Neo4j index — the user
  // is informed via warning so they can fix the upstream.
  log.warn(
    `embeddings: every /models embedding link is down. Falling back to local MiniLM (384d). ` +
    `This will write vectors to a DIFFERENT index than your primary — fix LMStudio / OpenAI / NVIDIA to restore normal search.`,
  );
  const fallback = new LocalEmbeddings();
  log.info(`embeddings: local ${fallback.model} (dim=${fallback.dim}) [last-resort fallback]`);
  return fallback;
}
