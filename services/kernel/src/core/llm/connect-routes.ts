/**
 * The routes behind "Connect your AI": one provider at a time, tested before
 * anything is saved, and wired into the chain in the same step.
 */

import type { IncomingMessage } from "node:http";
import type { KernelHttpServer } from "../http-server.js";
import { buildChatAdapter, type ChatLlmProvider } from "./chat-adapters.js";
import type { ClaudeCodeProviderOptions } from "./claude-code-adapter.js";
import {
  PROVIDER_CATALOG, canonicalSlug, getCatalogEntry, modelsUrl, type ProviderCatalogEntry,
} from "./provider-catalog.js";
import {
  clearProviderConfig, getProviderConfig, getStoredConfig, isConnected, saveProviderConfig, type ProviderConfig,
} from "./credentials.js";
import { classifyModel } from "./model-traits.js";
import { probeAdapter, type ProbeResult } from "./provider-probe.js";
import { maskSecret } from "./provider-routes.js";

export interface ChainLink { provider: string; model: string }
export interface DetectResult { found: boolean; baseUrl: string; models: string[] }

export interface ConnectDeps {
  registry: { startProvider(slug: string): Promise<boolean>; stopProvider(slug: string): Promise<boolean> };
  getChain(): ChainLink[];
  setChain(chain: ChainLink[]): void;
  /** Rebuild chat, agents and llm() against the new config; mark readiness stale. */
  onChanged(slug: string, why: string): void;
  claudeCode?: ClaudeCodeProviderOptions;
  buildAdapter?: (slug: string, override: Partial<ProviderConfig>) => ChatLlmProvider | null;
  detectLocal?: (entry: ProviderCatalogEntry) => Promise<DetectResult>;
  /** Did the official CLI sign in? Drives Detect, and nothing else. */
  detectClaudeSession?: () => boolean;
  /** Is there any usable credential — a CLI session, the legacy token, or the
   *  environment one? Drives Test, which must not refuse a provider that works. */
  hasClaudeCredential?: () => boolean;
  claudeCodeTransition?: () => "cli" | "legacy-token" | "none";
  loginCommand?: () => string;
  now?: () => string;
  timeoutMs?: (slug: string) => number;
}

export async function detectLocalServer(entry: ProviderCatalogEntry, fetchImpl: typeof fetch = fetch): Promise<DetectResult> {
  const probe = entry.localProbe;
  if (!probe) return { found: false, baseUrl: "", models: [] };
  const stored = getStoredConfig(entry.slug).baseUrl;
  const candidates = [...new Set([
    ...(typeof stored === "string" && stored ? [stored] : []),
    ...probe.hosts.map((h) => `http://${h}:${probe.port}${probe.path}`),
  ])];
  for (const baseUrl of candidates) {
    try {
      const r = await fetchImpl(modelsUrl(baseUrl), { signal: AbortSignal.timeout(1500) });
      if (!r.ok) continue;
      const body = (await r.json()) as { data?: Array<{ id?: string }> };
      const models = (body.data ?? [])
        .map((m) => m.id ?? "")
        .filter((id) => id && classifyModel(entry.slug, id).chat);
      return { found: true, baseUrl, models };
    } catch { /* not there — try the next host */ }
  }
  return { found: false, baseUrl: candidates[0] ?? "", models: [] };
}

function slugParam(req: IncomingMessage): string {
  const slug = (req as { params?: Record<string, string> }).params?.slug ?? "";
  return /^[a-z0-9][a-z0-9_-]{1,62}$/.test(slug) ? slug : "";
}

function readInput(body: unknown): Partial<ProviderConfig> {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  return { apiKey: s("apiKey"), baseUrl: s("baseUrl"), model: s("model"), region: s("region") };
}

const hasOverride = (i: Partial<ProviderConfig>) => !!(i.apiKey || i.baseUrl || i.model || i.region);

export function registerConnectRoutes(server: KernelHttpServer, deps: ConnectDeps): void {
  const now = deps.now ?? (() => new Date().toISOString());
  const timeoutFor = deps.timeoutMs ?? ((slug: string) => (slug === "claude-code" ? 45_000 : 20_000));
  const build = deps.buildAdapter ?? ((slug: string, o: Partial<ProviderConfig>) => buildChatAdapter(slug, o, { claudeCode: deps.claudeCode }));
  const detectLocal = deps.detectLocal ?? ((e: ProviderCatalogEntry) => detectLocalServer(e));
  const chainView = () => deps.getChain().map((l) => ({ provider: canonicalSlug(l.provider), model: l.model }));

  /** Returns whether it actually appended — callers use that to decide if anything changed. */
  const appendToChain = (slug: string): boolean => {
    const chain = deps.getChain();
    if (chain.some((l) => canonicalSlug(l.provider) === slug)) return false;
    deps.setChain([...chain, { provider: slug, model: "" }]);
    return true;
  };

  const entryOr404 = (req: IncomingMessage, res: Parameters<KernelHttpServer["json"]>[0]) => {
    const entry = getCatalogEntry(slugParam(req));
    if (!entry) server.json(res, 404, { error: "unknown provider" });
    return entry;
  };

  async function runProbe(entry: ProviderCatalogEntry, input: Partial<ProviderConfig>): Promise<ProbeResult> {
    const fail = (code: "auth" | "no_session", detail: string): ProbeResult =>
      ({ ok: false, latencyMs: 0, model: input.model ?? "", toolCall: false, error: { code, detail } });
    // Not `detectClaudeSession`: that answers "did the official CLI sign in?",
    // which is the right question for Detect and the wrong one here. An install
    // still running on the legacy token has no CLI session and works anyway —
    // asking for a session made Test report "no session on this machine" for a
    // provider that answers "pong" in 2.8s, so the button called a working
    // primary broken and never even tried it.
    if (entry.kind === "claude-code" && !(deps.hasClaudeCredential?.() ?? true)) {
      return fail("no_session", "Claude Code has no session on this machine");
    }
    if (entry.needsKey && !(input.apiKey || getProviderConfig(entry.slug).apiKey)) {
      return fail("auth", "missing key");
    }
    const adapter = build(entry.slug, input);
    if (!adapter) return fail("auth", "provider unavailable");
    return probeAdapter(adapter, { model: input.model || undefined, timeoutMs: timeoutFor(entry.slug), local: entry.group === "local" });
  }

  server.get("/api/llm/catalog", (_req, res) => {
    server.json(res, 200, {
      providers: PROVIDER_CATALOG.map((e) => {
        const raw = getStoredConfig(e.slug);
        const cfg = getProviderConfig(e.slug);
        return {
          slug: e.slug, name: e.name, group: e.group, recommended: !!e.recommended, kind: e.kind,
          needsKey: e.needsKey, keyUrl: e.keyUrl ?? "", keyHint: e.keyHint ?? "", logo: e.logo,
          blurb: e.blurb, tag: e.tag, pricing: e.pricing, steps: e.steps, models: e.models,
          baseUrlEditable: !!e.baseUrlEditable, regions: e.regions ?? [], docsUrl: e.docsUrl ?? "",
          connected: isConnected(e.slug), model: cfg.model,
          keyMasked: cfg.apiKey ? maskSecret(cfg.apiKey) : "",
          baseUrl: e.baseUrlEditable ? cfg.baseUrl : "", region: cfg.region,
          lastTest: typeof raw.lastTestAt === "string"
            ? { at: raw.lastTestAt, ok: raw.lastTestOk === true, latencyMs: Number(raw.lastLatencyMs ?? 0), code: typeof raw.lastErrorCode === "string" ? raw.lastErrorCode : undefined }
            : null,
        };
      }),
      chain: chainView(),
      claudeCodeTransition: deps.claudeCodeTransition?.() ?? "none",
      claudeCodeLoginCommand: deps.loginCommand?.() ?? "claude",
    });
  });

  server.post("/api/llm-providers/:slug/test", async (req, res) => {
    const entry = entryOr404(req, res);
    if (!entry) return;
    const input = readInput(await server.parseBody(req).catch(() => ({})));
    const result = await runProbe(entry, input);
    // A Test click on a saved connection is remembered for "tested 2 min ago".
    if (!hasOverride(input) && isConnected(entry.slug)) {
      saveProviderConfig(entry.slug, {
        lastTestAt: now(), lastTestOk: result.ok, lastLatencyMs: result.latencyMs,
        lastErrorCode: result.error?.code,
      });
    }
    server.json(res, 200, result);
  });

  server.post("/api/llm-providers/:slug/connect", async (req, res) => {
    const entry = entryOr404(req, res);
    if (!entry) return;
    const input = readInput(await server.parseBody(req).catch(() => ({})));
    let result = await runProbe(entry, input);
    let switchedModel: string | undefined;

    // The catalogue moves under us: a model that disappeared should not cost
    // the user a connection when a sibling from the same provider answers.
    if (!result.ok && result.error?.code === "model") {
      const tried = new Set([input.model || getProviderConfig(entry.slug).model]);
      for (const candidate of [entry.models.recommended, entry.models.fast, ...(entry.models.candidates ?? [])]) {
        if (!candidate || tried.has(candidate)) continue;
        tried.add(candidate);
        const retry = await runProbe(entry, { ...input, model: candidate });
        if (retry.ok) { result = retry; switchedModel = candidate; break; }
        if (retry.error?.code !== "model") break;
      }
    }

    if (!result.ok) {
      server.json(res, 200, { ...result, chain: chainView() });
      return;
    }

    const model = switchedModel ?? input.model;
    saveProviderConfig(entry.slug, {
      connectedAt: now(),
      lastTestAt: now(), lastTestOk: true, lastLatencyMs: result.latencyMs, lastErrorCode: undefined,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.baseUrl && entry.baseUrlEditable ? { baseUrl: input.baseUrl } : {}),
      ...(model ? { defaultModel: model } : {}),
      ...(input.region ? { region: input.region } : {}),
    });
    await deps.registry.startProvider(entry.slug).catch(() => false);
    appendToChain(entry.slug);
    deps.onChanged(entry.slug, `provider "${entry.slug}" was connected`);
    server.json(res, 200, { ...result, ...(switchedModel ? { switchedModel } : {}), chain: chainView() });
  });

  server.post("/api/llm-providers/:slug/detect", async (req, res) => {
    const entry = entryOr404(req, res);
    if (!entry) return;
    if (entry.kind === "claude-code") {
      const session = deps.detectClaudeSession?.() ?? false;
      if (session) {
        // Every poll re-detects a session that never went away — only call
        // onChanged (which spends a real readiness probe) the first time it
        // actually connects something, not on every subsequent "still here".
        const wasConnected = isConnected(entry.slug);
        if (!wasConnected) saveProviderConfig(entry.slug, { connectedAt: now() });
        const appended = appendToChain(entry.slug);
        if (!wasConnected || appended) deps.onChanged(entry.slug, "Claude Code session detected");
      }
      server.json(res, 200, { session, found: session, baseUrl: "", models: [], chain: chainView() });
      return;
    }
    if (entry.group !== "local") {
      server.json(res, 400, { error: "detect only applies to local providers" });
      return;
    }
    server.json(res, 200, await detectLocal(entry));
  });

  server.delete("/api/llm-providers/:slug/connection", async (req, res) => {
    const entry = entryOr404(req, res);
    if (!entry) return;
    clearProviderConfig(entry.slug);
    await deps.registry.stopProvider(entry.slug).catch(() => false);
    deps.setChain(deps.getChain().filter((l) => canonicalSlug(l.provider) !== entry.slug));
    deps.onChanged(entry.slug, `provider "${entry.slug}" was removed`);
    server.json(res, 200, { chain: chainView() });
  });

  server.put("/api/llm/chain", async (req, res) => {
    const body = (await server.parseBody<{ links?: unknown }>(req).catch(() => ({}))) as { links?: unknown };
    if (!Array.isArray(body.links)) {
      server.json(res, 400, { error: "links must be an array" });
      return;
    }
    const links = body.links.map((l) => {
      const o = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
      return { provider: canonicalSlug(String(o.provider ?? "")), model: String(o.model ?? "") };
    });
    if (links.some((l) => !getCatalogEntry(l.provider))) {
      server.json(res, 400, { error: "unknown provider in chain" });
      return;
    }
    deps.setChain(links);
    deps.onChanged("chain", "the provider chain was reordered");
    server.json(res, 200, { chain: chainView() });
  });
}
