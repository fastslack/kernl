/**
 * Admin HTTP routes for LlmProviderRegistry.
 *
 *   GET  /api/llm-providers                 → list + statuses
 *   GET  /api/llm-providers/:slug           → one provider's status
 *   GET  /api/llm-providers/:slug/schema    → config schema for the form
 *   GET  /api/llm-providers/:slug/models    → discovered models (if provider implements listModels)
 *   GET  /api/llm-providers/:slug/config    → current settings_json
 *   PUT  /api/llm-providers/:slug/config    → save settings_json (hot-reload)
 *   POST /api/llm-providers/:slug/start     → (re)start the provider
 *   POST /api/llm-providers/:slug/stop      → stop the provider
 */

import type { KernelHttpServer } from "../http-server.js";
import type { LlmProviderRegistry } from "./provider-registry.js";
import { clearProviderExhausted } from "./chat-adapters.js";
import { llm } from "./client.js";
import { getAllHealth } from "./provider-health.js";
import { ModelBlocklist } from "./model-blocklist.js";
import { recent as recentCalls } from "./call-log.js";
import { classifyModel, type ModelTraits } from "./model-traits.js";

/** Enough of the value to recognise it, never enough to use it. */
const MASK = "***";
function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return value.slice(0, 2) + MASK;
  return value.slice(0, 8) + MASK + value.slice(-4);
}
/** A value that came back out of `maskSecret` — i.e. the client never saw the
 *  real one and is echoing our own placeholder. Must not be persisted. */
function isMasked(value: string): boolean {
  return value.includes(MASK);
}
import { ChatClaudeCodeProvider } from "./claude-code-adapter.js";
import { ClaudeCodeAuthService } from "./claude-code-auth-service.js";

function slugOf(req: unknown): string | null {
  const params = (req as { params?: Record<string, string> }).params;
  const slug = params?.slug;
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug)) return null;
  return slug;
}

export function registerLlmProviderRoutes(
  server: KernelHttpServer,
  registry: LlmProviderRegistry,
  blocklist: ModelBlocklist,
  /**
   * Called after a provider's settings_json is saved (PUT …/config). The
   * bootstrap wires this to mirror the new config into config.webIntel.* + .env
   * and hot-reload the chat adapter / llm() singleton. Optional — tests and
   * minimal deployments can omit it.
   */
  onConfigSaved?: (slug: string) => void | Promise<void>,
): void {
  server.get("/api/llm-providers", (_req, res) => {
    server.json(res, 200, { providers: registry.getStatuses() });
  });

  // POST /api/llm-providers/clear-exhausted — wipes the per-provider quota
  // exhaustion flag (in-memory + persisted in `provider_status`). Useful when
  // an OOQ flag is stuck from a prior day or a quota was topped up out of
  // band. Body `{slug}` clears one provider; empty body clears all.
  server.post("/api/llm-providers/clear-exhausted", async (req, res) => {
    try {
      const body = (await server.parseBody<{ slug?: string }>(req).catch(() => ({}))) as { slug?: string };
      const slug = body.slug;
      const cleared = clearProviderExhausted(slug);
      server.json(res, 200, { cleared, slug: slug ?? "(all)" });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.get("/api/llm-providers/:slug", (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    const status = registry.getStatuses().find(s => s.slug === slug);
    if (!status) { server.json(res, 404, { error: "provider not found" }); return; }
    server.json(res, 200, { status });
  });

  server.get("/api/llm-providers/:slug/schema", (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    const schema = registry.getConfigSchema(slug);
    if (!schema) { server.json(res, 404, { error: "provider not found" }); return; }
    server.json(res, 200, { schema });
  });

  server.get("/api/llm-providers/:slug/models", async (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    const provider = registry.getProvider(slug);
    if (!provider) { server.json(res, 404, { error: "provider not running" }); return; }
    if (typeof provider.listModels !== "function") {
      server.json(res, 200, { models: [], dynamic: false, blocked: 0 });
      return;
    }
    try {
      const all = await provider.listModels();
      // Subtract proven-broken (slug, model) pairs so the /models
      // dropdown never re-offers a model that hangs or 404s.
      const visible = blocklist.filterAvailable(slug, all);
      // Filter to chat-completion models only (NVIDIA NIM advertises
      // embeddings/audio/image/reranker models in /v1/models too) and
      // annotate each survivor with capability badges (vision/reasoning/
      // fast/long-context) so the UI can render icons in the dropdown.
      const classified = visible.map((id) => ({ id, traits: classifyModel(slug, id) }));
      const chat = classified.filter((m) => m.traits.chat);
      const nonChat = classified.length - chat.length;
      server.json(res, 200, {
        models: chat.map((m): { id: string; traits: ModelTraits } => ({ id: m.id, traits: m.traits })),
        dynamic: true,
        blocked: all.length - visible.length,
        nonChatHidden: nonChat,
      });
    } catch (err) {
      server.json(res, 200, { models: [], dynamic: true, blocked: 0, nonChatHidden: 0, error: String(err) });
    }
  });

  /**
   * Masked. This used to return `settings_json` verbatim, so a plain GET
   * handed back the Claude Code OAuth token and every provider API key in
   * cleartext to anything holding a dashboard session.
   *
   * It read raw for a reason — the dashboard does read-modify-write and needs
   * the old secret to send back unchanged — so the PUT below now does that
   * merge server-side instead. The secret never has to leave the kernel.
   */
  server.get("/api/llm-providers/:slug/config", (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    const raw = registry.loadConfig(slug);
    const schema = registry.getConfigSchema(slug) ?? [];
    const secretKeys = new Set(schema.filter((f) => f.type === "password").map((f) => f.key));
    // oauthToken has no schema field (it is set by the sign-in dialog, not the
    // form) and is the most sensitive value here, so name it explicitly.
    secretKeys.add("oauthToken");
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = secretKeys.has(k) && typeof v === "string" ? maskSecret(v) : v;
    }
    server.json(res, 200, { config: out });
  });

  server.put("/api/llm-providers/:slug/config", async (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    let parsed: unknown;
    try {
      parsed = await server.parseBody(req);
    } catch (err) {
      server.json(res, 400, { error: `body: ${String(err)}` });
      return;
    }
    const config = (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      ? ((parsed as { config?: Record<string, unknown> }).config ?? (parsed as Record<string, unknown>))
      : null;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      server.json(res, 400, { error: "body must be a JSON object" });
      return;
    }
    const schema = registry.getConfigSchema(slug);
    if (!schema) { server.json(res, 404, { error: "provider not found" }); return; }

    // Merge secrets server-side. `saveConfig` replaces wholesale, so before the
    // GET was masked the client had to fetch the real token and send it back
    // just to change a model name. Now an omitted, empty or still-masked
    // secret means "leave it alone" — a config save can no longer wipe a
    // credential, and the credential never travels.
    const stored = registry.loadConfig(slug);
    const secretKeys = new Set(schema.filter((f) => f.type === "password").map((f) => f.key));
    secretKeys.add("oauthToken");
    for (const key of secretKeys) {
      const incoming = config[key];
      const keep = typeof incoming !== "string" || incoming === "" || isMasked(incoming);
      if (keep && typeof stored[key] === "string" && stored[key]) config[key] = stored[key];
    }

    const ok = registry.saveConfig(slug, config);
    if (!ok) { server.json(res, 500, { error: "failed to persist config" }); return; }

    // Hot-reload
    const wasRunning = !!registry.getProvider(slug);
    if (wasRunning) {
      await registry.stopProvider(slug);
      const started = await registry.startProvider(slug);
      if (!started) {
        server.json(res, 200, {
          saved: true,
          running: false,
          error: registry.lastStartError,
        });
        return;
      }
    }
    // Mirror into KernelConfig/.env + reload the chat adapter and llm() singleton.
    if (onConfigSaved) {
      try { await onConfigSaved(slug); } catch (err) { /* non-fatal */ void err; }
    }
    server.json(res, 200, { saved: true, running: !!registry.getProvider(slug) });
  });

  server.post("/api/llm-providers/:slug/start", async (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    const ok = await registry.startProvider(slug);
    if (!ok) {
      server.json(res, 500, { ok: false, error: registry.lastStartError ?? "start failed" });
      return;
    }
    server.json(res, 200, { ok: true });
  });

  server.post("/api/llm-providers/:slug/stop", async (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    const ok = await registry.stopProvider(slug);
    server.json(res, ok ? 200 : 404, { ok });
  });

  // POST /api/llm/chain/test — live audit: pings EVERY link in the chain
  // (not just until first success) with a tiny prompt. STREAMS results as
  // NDJSON so the UI can animate each link's transition (probing → ok/fail)
  // as it actually happens, not all at once after the slowest link returns.
  // Event shape:
  //   { event:"start",  chain:[{slug,provider,model}, …] }
  //   { event:"result", slug, ok, latencyMs, ... , hint? }   (one per link)
  //   { event:"done",   winner?:{slug,model,preview}, durationMs }
  // Each event is one line ending in `\n`. Frontend reads via fetch + ReadableStream.
  // Body: { prompt?: string } — optional override (default "ping").
  server.post("/api/llm/chain/test", async (req, res) => {
    type Hint = { label: string; action: string; url?: string };
    function buildHint(slug: string, kind?: string, raw?: string): Hint {
      const billingUrl: Record<string, string> = {
        grok:    "https://console.x.ai/team",
        openai:  "https://platform.openai.com/account/billing",
        claude:  "https://console.anthropic.com/settings/billing",
        anthropic: "https://console.anthropic.com/settings/billing",
        nvidia:  "https://build.nvidia.com/",
      };
      // NVIDIA NIM publishes models in /v1/models that aren't actually
      // online on the hosted endpoint — the chat call hangs until the
      // probe's 15s timeout fires. Surface that specifically so the user
      // doesn't think their key is bad.
      if (slug === "nvidia" && raw && /timeout|no response in/i.test(raw)) {
        return {
          label: "NIM model not available on the hosted endpoint",
          action: `NVIDIA NIM lists this model in /v1/models but the inference server isn't responding. Change NVIDIA_DEFAULT_MODEL to one that's actually served (meta/llama-3.1-8b-instruct, meta/llama-3.3-70b-instruct, qwen/qwen3-32b).`,
          url: "https://build.nvidia.com/models",
        };
      }
      switch (kind) {
        case "exhausted":
          return {
            label: "Out of credits / billing exhausted",
            action: `Top up credits or raise the monthly limit for "${slug}".`,
            url: billingUrl[slug],
          };
        case "auth":
          return {
            label: "Auth rejected (invalid key or suspended account)",
            action: `Check "${slug}"'s API key at /api/llm-providers/${slug}/config — it may have been rotated, revoked, or the account suspended.`,
            url: billingUrl[slug],
          };
        case "rate-limit":
          return {
            label: "Provider rate limit",
            action: `"${slug}" is rejecting requests due to volume. Wait a few seconds and retry, or lower concurrency.`,
          };
        case "transient":
          return {
            label: "Transient provider error",
            action: raw && /timeout|no response in/i.test(raw)
              ? `"${slug}" didn't respond within 15s. The model may be offline on the endpoint, or the network between kernel and provider is down.`
              : raw && /ECONN|ETIMED|socket|network/i.test(raw)
              ? `Network between kernel and "${slug}" is unstable — retry; if it persists, check the container's DNS/firewall.`
              : `5xx failure on "${slug}" — likely to recover on its own. If it persists, check its status page.`,
          };
        default:
          return { label: "Unknown error", action: "See the raw message below for more context." };
      }
    }

    const body = (await server.parseBody<{ prompt?: string; indices?: number[] }>(req).catch(() => ({}))) as { prompt?: string; indices?: number[] };
    const prompt = (typeof body.prompt === "string" && body.prompt.trim()) || "ping";
    // Optional: probe only specific chain indices (per-row "▶" button in UI).
    // When omitted, probes the whole chain.
    const indices = Array.isArray(body.indices) && body.indices.every(n => Number.isInteger(n) && n >= 0)
      ? body.indices
      : undefined;

    // Stream NDJSON — one event per line, flushed as soon as it's written.
    // `x-accel-buffering: no` disables nginx response buffering so each
    // event reaches the browser in real time instead of the proxy holding
    // the whole response until the connection closes. Don't set
    // `transfer-encoding` explicitly — Node's HTTP layer chooses chunked
    // automatically when there's no Content-Length, and manually setting
    // it conflicts with HTTP/2 upstreams and confuses some intermediaries.
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    });
    let alive = true;
    req.on("close", () => { alive = false; });
    const send = (obj: unknown) => {
      if (!alive) return;
      try { res.write(JSON.stringify(obj) + "\n"); } catch { alive = false; }
    };

    try {
      const chain = llm().describeChain();
      const links = [chain.primary, ...chain.fallbacks];
      // Emit idx so the frontend can key per-row state by chain position,
      // not by slug. Critical when the chain contains multiple entries
      // for the same provider (e.g. 4 nvidia models with different IDs).
      send({
        event: "start",
        prompt,
        chain: links.map((l, idx) => ({ idx, slug: l.slug, provider: l.provider, model: l.model })),
        indices: indices ?? null,
      });

      const t0 = Date.now();
      let firstOk: { slug: string; model: string; preview?: string } | null = null;

      // probeAllLinks fires `onResult` per-link the moment that link's
      // promise settles — so the stream gets a "result" event in real time
      // as each provider responds (or times out). The Promise.all at the
      // end is what we await to know all events have shipped.
      await llm().probeAllLinks(prompt, (r) => {
        if (r.ok && !firstOk) firstOk = { slug: r.slug, model: r.model, preview: r.preview };
        // Auto-block model-specific failures (timeout / 404). Provider-
        // wide failures (quota/auth/rate-limit) are skipped — those
        // affect EVERY model under the slug, not this one. See
        // ModelBlocklist.reasonForFailure for the classification.
        let autoBlocked: { reason: string } | undefined;
        if (!r.ok && r.model) {
          const reason = ModelBlocklist.reasonForFailure(r.errorKind, r.errorRaw);
          if (reason) {
            blocklist.block(r.slug, r.model, reason, r.errorRaw ?? "");
            autoBlocked = { reason };
          }
        }
        send({
          event: "result",
          ...r,
          hint: r.ok ? undefined : buildHint(r.slug, r.errorKind, r.errorRaw),
          autoBlocked,
        });
      }, indices ? { indices } : undefined);
      send({ event: "done", winner: firstOk, durationMs: Date.now() - t0 });
    } catch (err) {
      // Defensive: any uncaught throw (e.g., llm() not initialized) MUST
      // be terminated as an event in the stream + a clean res.end(), or
      // nginx will see an orphaned connection and surface a 502 to the
      // client with no diagnostic.
      const msg = err instanceof Error ? err.message : String(err);
      send({ event: "error", error: msg });
    } finally {
      try { res.end(); } catch { /* */ }
    }
  });

  // POST /api/llm/chat — drive the global chain (with fallbacks) from outside
  // the kernel process. Mirrors the LlmChatOptions shape; returns the winning
  // link's text + the provider/model that served it. Useful for batch jobs
  // (cinema translator, eval scripts) that want the kernel's fallback logic
  // without re-bootstrapping the whole config in a side process.
  // Body: { system?, user, model?, maxTokens?, temperature?, json?, caller? }
  server.post("/api/llm/chat", async (req, res) => {
    try {
      const body = await server.parseBody<{
        system?: string;
        user?: string;
        model?: string;
        maxTokens?: number;
        temperature?: number;
        json?: boolean;
        caller?: string;
      }>(req);
      if (!body?.user || typeof body.user !== "string" || !body.user.trim()) {
        server.json(res, 400, { error: "`user` is required and must be a non-empty string" });
        return;
      }
      const t0 = Date.now();
      const result = await llm().chat({
        system: body.system,
        user: body.user,
        model: body.model,
        maxTokens: body.maxTokens,
        temperature: body.temperature,
        json: body.json,
        caller: body.caller ?? "http:/api/llm/chat",
      });
      server.json(res, 200, {
        text: result.text,
        provider: result.provider,
        model: result.model,
        latency_ms: Date.now() - t0,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      server.json(res, 502, { error: msg });
    }
  });

  // GET /api/llm/calls — recent audit log of every LLM call. Query params:
  //   ?limit=N      (default 100, max 1000)
  //   ?slug=grok    filter to one provider
  //   ?ok=1         only successful
  //   ?fail=1       only failed
  server.get("/api/llm/calls", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const calls = recentCalls({
      limit: Number(url.searchParams.get("limit")) || 100,
      slug: url.searchParams.get("slug") || undefined,
      okOnly:   url.searchParams.get("ok")   === "1",
      failOnly: url.searchParams.get("fail") === "1",
    });
    server.json(res, 200, { calls });
  });

  // ── Model blocklist admin ────────────────────────────────────────
  // GET /api/llm/blocklist           → all auto-blocked (slug, model) pairs
  // DELETE /api/llm/blocklist/all    → wipe everything (for "Re-enable all")
  // DELETE /api/llm/blocklist/:slug/:model → unblock a specific entry
  server.get("/api/llm/blocklist", (_req, res) => {
    server.json(res, 200, { entries: blocklist.list() });
  });
  server.delete("/api/llm/blocklist/all", (_req, res) => {
    const removed = blocklist.unblockAll();
    server.json(res, 200, { removed });
  });
  server.delete("/api/llm/blocklist/:slug/:model", (req, res) => {
    const params = (req as { params?: Record<string, string> }).params ?? {};
    const slug = params.slug;
    // Models often contain slashes (e.g. meta/llama-3.1-8b-instruct) which
    // the param matcher captures as `:model` only up to the first slash.
    // Fall back to parsing the path manually so multi-segment IDs survive.
    let model = params.model ?? "";
    if (req.url) {
      const m = /^\/api\/llm\/blocklist\/([^/]+)\/(.+?)(?:\?|$)/.exec(req.url);
      if (m && m[1] === slug) model = decodeURIComponent(m[2]);
    }
    if (!slug || !model) {
      server.json(res, 400, { error: "slug and model are required" });
      return;
    }
    const removed = blocklist.unblock(slug, model);
    server.json(res, removed ? 200 : 404, { removed });
  });

  // POST /api/llm/blocklist/:slug/:model/permanent — flag a blocked entry
  // as "permanently dismissed". Stays in the blocklist (so the dropdown
  // keeps hiding the model) but disappears from the "Modelos descartados"
  // section. Use when the user has accepted the model is dead for good.
  server.post("/api/llm/blocklist/:slug/:model/permanent", (req, res) => {
    const params = (req as { params?: Record<string, string> }).params ?? {};
    const slug = params.slug;
    let model = params.model ?? "";
    if (req.url) {
      const m = /^\/api\/llm\/blocklist\/([^/]+)\/(.+?)\/permanent(?:\?|$)/.exec(req.url);
      if (m && m[1] === slug) model = decodeURIComponent(m[2]);
    }
    if (!slug || !model) {
      server.json(res, 400, { error: "slug and model are required" });
      return;
    }
    const ok = blocklist.markPermanent(slug, model);
    server.json(res, 200, { ok });
  });

  // GET /api/llm/chain — primary + fallbacks the global LlmClient will use,
  // each link annotated with availability (has key/SDK) and a status that
  // collapses provider-health into something the LIVE-button popover can
  // render directly:
  //   "active"    → healthy primary (next call goes here)
  //   "standby"   → healthy fallback (used if a higher-priority link blows)
  //   "no-key"    → link in the chain but has no credentials
  //   "quota"     → blocked because of 402/insufficient_quota (out of credit)
  //   "rate-limit"→ blocked because of 429 (will recover quickly)
  //   "auth"      → blocked because of 401/403 (bad key / forbidden)
  //   "degraded"  → recent transient failures, still in rotation
  server.get("/api/llm/chain", (_req, res) => {
    const chain = llm().describeChain();
    const health = getAllHealth();
    type LinkStatus = "active" | "standby" | "no-key" | "quota" | "rate-limit" | "auth" | "degraded";
    const describe = (link: { slug: string; provider: string; model: string; available: boolean }, isPrimary: boolean) => {
      const h = health[link.slug];
      let status: LinkStatus;
      let reason: string | undefined;
      if (!link.available) {
        status = "no-key";
        reason = "no API key configured";
      } else if (h?.blocked) {
        const kind = h.lastFailureKind ?? "transient";
        if (kind === "exhausted") { status = "quota"; reason = "credits exhausted / billing required"; }
        else if (kind === "rate-limit") { status = "rate-limit"; reason = "rate-limited by provider"; }
        else if (kind === "auth") { status = "auth"; reason = "auth rejected (bad key / forbidden)"; }
        else { status = "degraded"; reason = "blocked after repeated transient failures"; }
      } else if ((h?.failures ?? 0) > 0) {
        status = "degraded";
        reason = `${h?.failures} recent failure(s)`;
      } else {
        status = isPrimary ? "active" : "standby";
      }
      return {
        slug: link.slug,
        provider: link.provider,
        model: link.model,
        status,
        reason,
        latencyMs: h?.ewmaMs,
        blockedForMs: h?.blockedFor,
        lastSuccessAt: h?.lastSuccessAt,
        failures: h?.failures ?? 0,
      };
    };
    server.json(res, 200, {
      primary: describe(chain.primary, true),
      fallbacks: chain.fallbacks.map(l => describe(l, false)),
    });
  });
}

/**
 * Claude Code sign-in, driven from the dashboard.
 *
 * This provider runs on the operator's Claude subscription instead of a metered
 * key, which makes it the one provider that works with nothing configured — and
 * the one that silently stops working when its session goes. A container
 * recreate used to be enough to lose it, with no way to sign back in short of
 * an interactive shell inside the container. These four routes are that way in.
 */
export function registerClaudeCodeAuthRoutes(
  server: KernelHttpServer,
  registry: LlmProviderRegistry,
): void {
  const SLUG = "claude-code";
  const auth = new ClaudeCodeAuthService(
    () => new ChatClaudeCodeProvider().binaryPath(),
    () => {
      const cfg = registry.loadConfig(SLUG);
      const t = cfg.oauthToken;
      return typeof t === "string" && t ? t : undefined;
    },
    (token) => {
      registry.saveConfig(SLUG, { ...registry.loadConfig(SLUG), oauthToken: token });
      // Mirror into the environment so the adapter picks it up on the very next
      // call. It is built without config, so the registry alone is invisible.
      if (token) process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    },
  );

  server.get("/api/llm/claude-code/auth", (_req, res) => {
    server.json(res, 200, auth.status());
  });

  server.post("/api/llm/claude-code/auth/login", async (_req, res) => {
    const r = await auth.startLogin();
    if ("error" in r) return server.json(res, 400, { error: r.error });
    server.json(res, 200, r.session);
  });

  server.post("/api/llm/claude-code/auth/code", async (req, res) => {
    const body = await server.parseBody<{ session?: string; code?: string }>(req);
    const r = await auth.submitCode(String(body?.session ?? ""), String(body?.code ?? ""));
    // A completed sign-in changes the answer to "can an agent run", so the
    // next check must ask again instead of serving a pre-login verdict.
    if (r.ok) (await import("./readiness.js")).markLlmReadinessStale("claude-code signed in");
    server.json(res, r.ok ? 200 : 400, r.ok ? { ok: true, status: r.status } : { error: r.error });
  });

  server.post("/api/llm/claude-code/auth/token", async (req, res) => {
    const body = await server.parseBody<{ token?: string }>(req);
    const r = auth.saveToken(String(body?.token ?? ""));
    if (r.ok) (await import("./readiness.js")).markLlmReadinessStale("claude-code token saved");
    server.json(res, r.ok ? 200 : 400, r.ok ? { ok: true, status: r.status } : { error: r.error });
  });

  server.post("/api/llm/claude-code/auth/cancel", async (req, res) => {
    const body = await server.parseBody<{ session?: string }>(req);
    auth.cancel(String(body?.session ?? ""));
    server.json(res, 200, { ok: true });
  });

  // ── Readiness ────────────────────────────────────────────────────
  //
  // Exempt from the gate it feeds (see readiness-gate.ts) — a blocked
  // dashboard has to be able to ask why it is blocked.
  server.get("/api/llm/readiness", async (_req, res) => {
    const { ensureLlmReadiness } = await import("./readiness.js");
    server.json(res, 200, await ensureLlmReadiness());
  });

  /** Re-probe on demand. This spends a real call, so it is a POST. */
  server.post("/api/llm/readiness/recheck", async (_req, res) => {
    const { ensureLlmReadiness } = await import("./readiness.js");
    server.json(res, 200, await ensureLlmReadiness(true));
  });
}
