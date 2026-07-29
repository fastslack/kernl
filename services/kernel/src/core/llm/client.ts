/**
 * Unified LLM Client — single interface for OpenAI, Anthropic, or any compatible API.
 *
 * Usage:
 *   const llm = createLlmClient(config);
 *   const response = await llm.chat({ system: "...", user: "...", model: "gpt-4o-mini" });
 *
 * Supports:
 *   - OpenAI (gpt-4o, gpt-4o-mini, gpt-4-turbo, etc.)
 *   - Anthropic (claude-3-haiku, claude-3-sonnet, claude-3-opus, etc.)
 *   - Any OpenAI-compatible API (Groq, Together, Ollama, etc.)
 */

import { log } from "../logger.js";
import * as providerHealth from "./provider-health.js";
import type { FailureKind } from "./provider-health.js";
import * as callLog from "./call-log.js";
import * as limiter from "./limiter.js";
import { ChatClaudeCodeProvider } from "./claude-code-adapter.js";

/** Hard ceiling for an in-place backoff sleep on a rate-limited LAST link.
 *  We never block longer than this even if the provider's Retry-After is huge —
 *  better to surface the error than to hang the caller for a minute. */
const RATE_LIMIT_MAX_WAIT_MS = (() => {
  const v = Number(process.env.LLM_RATE_LIMIT_MAX_WAIT_MS);
  return Number.isFinite(v) && v > 0 ? v : 15_000;
})();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** ±15% jitter so retries from concurrent callers don't re-converge into a
 *  fresh thundering herd against the same provider. */
function withJitter(ms: number): number {
  return Math.round(ms * (0.85 + Math.random() * 0.3));
}

/** Errors carry an optional `retryAfterMs` hint parsed from the provider's
 *  rate-limit headers — see `parseRetryAfterMs`. */
interface RetryableError extends Error {
  retryAfterMs?: number;
}

/**
 * Pull a concrete "wait this long" hint out of a rate-limited HTTP response.
 * Honors, in priority order:
 *   - `Retry-After` (delta-seconds OR an HTTP date) — standard, used by most
 *   - `anthropic-ratelimit-{requests,tokens}-reset` (ISO 8601 timestamp)
 *   - `x-ratelimit-reset-{requests,tokens}` (OpenAI; secs or `1m30s`-style)
 * Returns undefined when no usable hint is present.
 */
function parseRetryAfterMs(headers: Headers): number | undefined {
  const ra = headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  for (const h of ["anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-reset"]) {
    const v = headers.get(h);
    if (v) {
      const d = Date.parse(v);
      if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
    }
  }
  for (const h of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const v = headers.get(h);
    if (v) {
      const ms = parseDurationish(v);
      if (ms !== undefined) return ms;
    }
  }
  return undefined;
}

/** Parse OpenAI-style reset values: a bare number of seconds, or compound
 *  durations like "1m30s" / "6m0s" / "750ms". Returns ms or undefined. */
function parseDurationish(v: string): number | undefined {
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const m = v.match(/(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?/);
  if (!m) return undefined;
  const mins = Number(m[1] ?? 0);
  const secs = Number(m[2] ?? 0);
  const ms = Number(m[3] ?? 0);
  const total = mins * 60_000 + secs * 1000 + ms;
  return total > 0 ? total : undefined;
}

export type LlmProvider = "openai" | "anthropic" | "custom";

// Singleton Claude Code SDK provider. Reused across every LlmClient instance
// so the binary-lookup cache (`findBinary()`) survives, and so multiple
// extensions sharing the global `llm()` client all route through the same
// OAuth session. Created lazily on first use.
let _claudeCodeSdk: ChatClaudeCodeProvider | null | undefined = undefined;
function getClaudeCodeSdk(): ChatClaudeCodeProvider | null {
  if (_claudeCodeSdk === undefined) {
    try {
      const inst = new ChatClaudeCodeProvider();
      _claudeCodeSdk = inst.available() ? inst : null;
    } catch {
      _claudeCodeSdk = null;
    }
  }
  return _claudeCodeSdk;
}

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  /** Base URL override (for custom/Ollama/Groq endpoints) */
  baseUrl?: string;
  /** Default model if none specified per-call */
  defaultModel?: string;
  /** Max retries on transient errors */
  maxRetries?: number;
  /** Hard ceiling for a single HTTP call. Default 60s for production calls,
   *  overridable per-LlmClient — the probe path drops this to ~15s so a
   *  hung provider can't lock up the chain audit endpoint. */
  timeoutMs?: number;
  /**
   * Logical kernel slug (e.g. "claude", "grok", "lmstudio", "nvidia"). Used
   * by the shared provider health tracker to keep latency/failure stats per
   * logical provider — `provider: "custom"` is shared by xAI, NVIDIA, etc.,
   * so the slug is what disambiguates them. Optional; falls back to
   * `provider` when not set.
   */
  slug?: string;
  /**
   * Ordered fallback chain. When the primary call fails with a transient or
   * provider-specific error (429, 5xx, quota_exceeded, timeout), the client
   * retries against each entry in order. Each entry is a fully-specified
   * alternative (its own provider + apiKey + model). Empty array = no fallback.
   */
  fallbackChain?: LlmConfig[];
}

export interface LlmChatOptions {
  system?: string;
  user: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** If true, return raw JSON (for structured output) */
  json?: boolean;
  /** Free-form tag identifying who's calling — appears in call-log rows
   *  + kernel log so an audit can trace "this EmailTriage burst is the
   *  thing that ate the Grok credit". Convention: "module:purpose"
   *  (e.g. "email-triage", "agent:research-001", "subs-translate",
   *  "chain-probe"). Optional but strongly recommended. */
  caller?: string;
  /** Base64-encoded image attachment (vision input). When set, `user` is
   *  appended as the prompt and the image is sent alongside via the
   *  provider's multimodal format. Caller must also set `imageMediaType`
   *  (e.g. "image/jpeg", "image/png", "image/webp"). Provider responsibility:
   *  if the chain hits a model that doesn't support vision, that link
   *  errors out and the chain falls through. */
  imageBase64?: string;
  imageMediaType?: string;
}

export interface LlmChatResult {
  text: string;
  model: string;
  provider: LlmProvider;
  inputTokens?: number;
  outputTokens?: number;
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export class LlmClient {
  private config: LlmConfig;

  constructor(config: LlmConfig) {
    this.config = config;
  }

  get provider(): LlmProvider {
    return this.config.provider;
  }

  get hasKey(): boolean {
    return !!this.config.apiKey;
  }

  /** Hot-reload this client with a new config (used when /api/config/ai POSTs). */
  reload(config: LlmConfig): void {
    this.config = config;
    log.info(
      `LLM client reloaded: primary=${config.provider}` +
      (config.fallbackChain?.length ? ` + ${config.fallbackChain.length} fallback(s)` : ""),
    );
  }

  /** Live diagnostic — run a tiny "ping" call against EVERY link in the
   *  chain (not just until the first success) and return per-link
   *  results: success + latency + sample, OR failure + raw error +
   *  classified kind (auth/quota/rate-limit/transient). Used by the
   *  /models page's "Probar ahora" button so the operator can see in one
   *  shot why a fallback isn't picking up. Per-call cost is minimal
   *  (≈20 output tokens × N links) but it IS a real call, so don't wire
   *  this to anything that auto-polls. */
  async probeAllLinks(
    prompt = "ping",
    onResult?: (r: {
      idx: number;
      slug: string;
      provider: LlmProvider;
      model: string;
      ok: boolean;
      latencyMs: number;
      preview?: string;
      errorRaw?: string;
      errorKind?: FailureKind;
    }) => void,
    opts?: { indices?: number[] },
  ): Promise<Array<{
    idx: number;
    slug: string;
    provider: LlmProvider;
    model: string;
    ok: boolean;
    latencyMs: number;
    preview?: string;
    errorRaw?: string;
    errorKind?: FailureKind;
  }>> {
    const baseLinks = [this.config, ...(this.config.fallbackChain ?? [])];
    // Per-link cap. The probe endpoint MUST come back before nginx's default
    // 60s `proxy_read_timeout` or the dashboard sees an opaque 504. With
    // parallel execution, worst case = max(timeout per link).
    //
    // claude-code is special: each call spawns a child `claude` binary
    // (CLI cold start + OAuth refresh + LLM round-trip) so 15s is too
    // tight for cold runs — production calls have been seen taking 5-10s
    // just for the spawn alone. Give the SDK paths 45s; everything else
    // (HTTP fetch to api.openai.com etc.) stays at 15s.
    const probeTimeoutFor = (slug: string): number =>
      slug === "claude-code" || slug === "claude_code" ? 45_000 : 15_000;
    // Run every link in parallel — a hung provider can no longer hold up
    // the rest of the audit. Order is preserved because Promise.all keeps
    // the input array's index.
    // The chain index is the authoritative identifier per link — the same
    // (slug, model) pair can appear multiple times (e.g. 4 nvidia entries
    // with different models). Without `idx`, frontends that key by slug
    // alone would overwrite each other's state.
    const onlyIdx = opts?.indices ? new Set(opts.indices) : null;
    const probes = baseLinks
      .map((link, idx) => ({ link, idx }))
      .filter(({ idx }) => !onlyIdx || onlyIdx.has(idx))
      .map(async ({ link, idx }) => {
      const slug = slugOf(link);
      const t0 = Date.now();
      // Build a single-link client so chat() only tries this one (no
      // hidden fallback). We deliberately call the constructor directly
      // rather than via createLlmClient(config) — we want to test THIS
      // link's apiKey + baseUrl exactly as the live chain has them.
      const solo = new LlmClient({
        ...link,
        fallbackChain: [],
        maxRetries: 0,
        timeoutMs: probeTimeoutFor(slug),
      });
      let result: Awaited<ReturnType<LlmClient["probeAllLinks"]>>[number];
      try {
        const r = await solo.chat({ user: prompt, maxTokens: 20, caller: "chain-probe" });
        result = {
          idx,
          slug,
          provider: link.provider,
          model: r.model || link.defaultModel || "",
          ok: true,
          latencyMs: Date.now() - t0,
          preview: r.text.slice(0, 80),
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        result = {
          idx,
          slug,
          provider: link.provider,
          model: link.defaultModel ?? "",
          ok: false,
          latencyMs: Date.now() - t0,
          errorRaw: errMsg,
          errorKind: providerHealth.classifyError(err),
        };
      }
      // Fire the streaming callback the moment THIS link resolves —
      // callers that don't pass one get the same behaviour as before.
      if (onResult) {
        try { onResult(result); } catch { /* hook errors must not break audit */ }
      }
      return result;
    });
    return Promise.all(probes);
  }

  /** Introspect the configured chain — used by callers that want to show
   *  the user which provider/model is about to run (e.g. the subtitle
   *  translator's `/translate-srt/info` endpoint).
   *  `available` means the link has credentials or can route through the
   *  Claude Code SDK; an unavailable primary still appears so the UI can
   *  surface a clear "no key" hint. */
  describeChain(): {
    primary: { slug: string; provider: LlmProvider; model: string; available: boolean };
    fallbacks: Array<{ slug: string; provider: LlmProvider; model: string; available: boolean }>;
  } {
    const sdkReady = !!getClaudeCodeSdk();
    const usable = (l: LlmConfig) =>
      !!l.apiKey || l.provider === "custom" || (l.provider === "anthropic" && sdkReady);
    const describe = (l: LlmConfig) => ({
      slug: slugOf(l),
      provider: l.provider,
      model: l.defaultModel ?? "",
      available: usable(l),
    });
    return {
      primary: describe(this.config),
      fallbacks: (this.config.fallbackChain ?? []).map(describe),
    };
  }

  async chat(opts: LlmChatOptions): Promise<LlmChatResult> {
    // Walk primary + fallback chain. Each link gets its own retry budget.
    // The chain is reordered each call by health score: the configured primary
    // gets a boost (so caller intent wins when it's healthy) but a primary
    // that has accumulated 3+ consecutive failures is soft-unpinned and the
    // fastest healthy alternative jumps to the head.
    const baseLinks = [this.config, ...(this.config.fallbackChain ?? [])];
    // `anthropic` links without an apiKey are still usable when the Claude
    // Code SDK is logged in — `chatOnce` will route them through the OAuth
    // CLI subscription instead of the metered REST API.
    const sdkReady = !!getClaudeCodeSdk();
    const usable = baseLinks.filter(
      l => l.apiKey || l.provider === "custom" || (l.provider === "anthropic" && sdkReady),
    );
    const primarySlug = slugOf(this.config);
    const links = sortLinksByHealth(usable, primarySlug);

    let lastErr: unknown;
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      try {
        return await this.chatOnce(link, opts, { isLast: i === links.length - 1 });
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (i < links.length - 1) {
          log.warn(`LLM chain ${i + 1}/${links.length} (${slugOf(link)}) failed: ${msg.slice(0, 140)} — trying next`);
        }
        // Non-retryable errors for a bad request (400 malformed) shouldn't
        // waste fallback budget. Errors like 429/5xx/quota/timeout get fallback.
        if (!isChainableError(err)) throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("LLM: all chain links exhausted");
  }

  /**
   * One provider call with its own intra-link retry budget. Each attempt is
   * gated by the shared concurrency limiter (`limiter.acquire`) so bursts of
   * callers can't all hit the provider at once — the #1 cause of 429s here.
   *
   * Retry policy within a link:
   *   - transient (5xx / network): retry in place, exponential + jitter.
   *   - rate-limit (429): if this is the LAST link in the chain there's nothing
   *     to fall through to, so retry in place honoring the provider's
   *     `Retry-After` (capped at RATE_LIMIT_MAX_WAIT_MS). If other links remain,
   *     throw immediately so `chat()` fails over to a healthy provider rather
   *     than blocking on a backoff.
   *
   * The limiter slot is ALWAYS released before any backoff sleep — holding a
   * slot during backoff would defeat the limiter.
   */
  private async chatOnce(
    link: LlmConfig,
    opts: LlmChatOptions,
    ctx: { isLast: boolean },
  ): Promise<LlmChatResult> {
    const model = opts.model ?? link.defaultModel ?? this.getDefaultModelFor(link.provider);
    const maxTokens = opts.maxTokens ?? 2048;
    const retries = link.maxRetries ?? 1;
    const slug = slugOf(link);
    // The chain-audit probe runs every link in parallel with its own timeout;
    // gating it through the limiter would serialize the audit and risk false
    // timeouts. Live traffic always goes through the limiter.
    const useLimiter = opts.caller !== "chain-probe";

    for (let attempt = 0; attempt <= retries; attempt++) {
      const t0 = Date.now();
      let release: (() => void) | null = null;
      try {
        if (useLimiter) release = await limiter.acquire(slug);
        // Direct HTTP only. The rust bridge has its own LLM router that
        // ignores per-link provider/baseUrl and forces every call through an
        // openai-compatible endpoint at api.openai.com — which 404s as soon
        // as the model name belongs to grok/claude/nvidia. Routing has to
        // stay here in TS where /models + materializeLink already pick the
        // right baseUrl per provider.
        let result: LlmChatResult;
        if (link.provider === "anthropic") {
          result = await this.chatAnthropic(link, opts, model, maxTokens);
        } else {
          result = await this.chatOpenAI(link, opts, model, maxTokens);
        }
        if (release) { release(); release = null; } // free the slot ASAP
        const latency = Date.now() - t0;
        providerHealth.recordSuccess(slug, latency);
        // Audit log: every successful call lands in llm_call_log + kernel log.
        callLog.record({
          slug,
          model: result.model || model,
          ok: true,
          latencyMs: latency,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          caller: opts.caller,
          startedAt: t0,
        });
        return result;
      } catch (err) {
        if (release) { release(); release = null; } // release BEFORE any backoff
        const kind = providerHealth.classifyError(err);
        const retryAfterMs = (err as RetryableError)?.retryAfterMs;
        const transient = isTransientError(err);
        const rateLimited = kind === "rate-limit";
        // Retry in place for transient errors always; for rate-limit only when
        // this is the last link (no healthy fallback to jump to).
        const canRetry = attempt < retries && (transient || (rateLimited && ctx.isLast));
        if (canRetry) {
          // Don't record a failure yet — we're about to retry within this link.
          const base = rateLimited
            ? Math.min(RATE_LIMIT_MAX_WAIT_MS, retryAfterMs ?? 2000 * Math.pow(2, attempt))
            : 1000 * (attempt + 1);
          await sleep(withJitter(base));
          continue;
        }
        providerHealth.recordFailure(slug, kind, retryAfterMs);
        callLog.record({
          slug,
          model,
          ok: false,
          latencyMs: Date.now() - t0,
          errorKind: kind,
          errorMsg: err instanceof Error ? err.message : String(err),
          caller: opts.caller,
          startedAt: t0,
        });
        throw err;
      }
    }
    throw new Error(`LLM: ${link.provider} retries exhausted`);
  }

  /** Convenience: chat and parse JSON response */
  async chatJson<T = unknown>(opts: LlmChatOptions): Promise<T> {
    const result = await this.chat({ ...opts, json: true });
    const cleaned = result.text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(cleaned) as T;
  }

  private getDefaultModelFor(provider: LlmProvider): string {
    switch (provider) {
      case "anthropic": return "claude-haiku-4-5-20251001";
      case "openai": return "gpt-4o-mini";
      default: return "gpt-4o-mini";
    }
  }

  private getBaseUrlFor(link: LlmConfig): string {
    if (link.baseUrl) return link.baseUrl;
    switch (link.provider) {
      case "anthropic": return ANTHROPIC_URL;
      case "openai": return OPENAI_URL;
      default: return OPENAI_URL;
    }
  }

  // ── OpenAI / OpenAI-compatible ──

  private async chatOpenAI(link: LlmConfig, opts: LlmChatOptions, model: string, maxTokens: number): Promise<LlmChatResult> {
    // OpenAI-style messages: text-only is { role, content: string }; vision
    // input swaps to { role, content: [{type:"text",...}, {type:"image_url",...}] }.
    const messages: Array<{ role: string; content: unknown }> = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    if (opts.imageBase64 && opts.imageMediaType) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: opts.user },
          { type: "image_url", image_url: { url: `data:${opts.imageMediaType};base64,${opts.imageBase64}` } },
        ],
      });
    } else {
      messages.push({ role: "user", content: opts.user });
    }

    const body: Record<string, unknown> = { model, messages, max_tokens: maxTokens };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.json) body.response_format = { type: "json_object" };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), link.timeoutMs ?? 60_000);
    let response: Response;
    try {
      response = await fetch(this.getBaseUrlFor(link), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${link.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`LLM OpenAI timeout: no response in ${link.timeoutMs ?? 60_000}ms`);
      }
      throw err;
    }
    clearTimeout(timer);

    if (!response.ok) {
      const err = await response.text();
      const e: RetryableError = new Error(`LLM OpenAI ${response.status}: ${err}`);
      if (response.status === 429 || response.status === 503) {
        e.retryAfterMs = parseRetryAfterMs(response.headers);
      }
      throw e;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
      model: string;
    };

    return {
      text: data.choices?.[0]?.message?.content ?? "",
      model: data.model ?? model,
      provider: link.provider,
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
    };
  }

  // ── Anthropic ──

  private async chatAnthropic(link: LlmConfig, opts: LlmChatOptions, model: string, maxTokens: number): Promise<LlmChatResult> {
    // Prefer the Claude Code SDK (OAuth via Max/Pro subscription) over the
    // paid REST API whenever the CLI is logged in. Same intent — same model —
    // but the call goes through the user's flat-rate subscription instead of
    // a metered API key that may have no credit. The SDK refuses any model
    // name that doesn't look like a Claude model; pin a known default in that
    // case so a misconfigured `defaultModel` (e.g. "gpt-4o-mini" left over from
    // legacy CHAT_DEFAULT_MODEL) doesn't surface a confusing SDK error.
    // `available()` only proves the CLI binary is on disk — it says nothing
    // about the OAuth session. A logged-out CLI therefore looks usable right up
    // until the call fails, so an auth failure here must NOT kill the request:
    // if this link also carries an API key we drop through to the REST path
    // below, and if it doesn't we throw an error `isChainableError` recognises
    // so `chat()` moves on to the next provider. Without this, one logged-out
    // CLI takes down every LLM feature in the kernel.
    const sdk = getClaudeCodeSdk();
    if (sdk) {
      const sdkModel = /^claude[-_]/i.test(model) ? model : "claude-sonnet-4-5";
      // The SDK shells out to the CLI; if the CLI is hung (orphan process,
      // bad OAuth refresh, etc.) it would wait forever. Race the call
      // against the same timeout used for direct HTTP so the probe path
      // can't lock up the chain audit endpoint.
      const timeoutMs = link.timeoutMs ?? 60_000;
      try {
        const sdkCall = sdk.chatCompletion(
          [{ role: "user", content: opts.user }],
          {
            model: sdkModel,
            system: opts.system,
            max_tokens: maxTokens,
            temperature: opts.temperature,
            caller: "llm-client",
          },
        );
        const result = await Promise.race([
          sdkCall,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`LLM Claude-Code-SDK timeout: no response in ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);
        return {
          text: result.content,
          model: result.model,
          provider: "anthropic",
          outputTokens: result.tokens_used,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isAuthFailure(msg)) throw err;
        if (!link.apiKey) {
          throw new Error(`LLM Claude-Code-SDK 401 not authenticated: ${msg} (run \`claude\` and /login)`);
        }
        log.warn(`Claude Code SDK is not logged in (${msg.slice(0, 80)}) — using the Anthropic API key instead`);
      }
    }

    // Anthropic-style multimodal: { role:"user", content: [{type:"image",source:{...}}, {type:"text",text:"..."}] }
    const userContent = opts.imageBase64 && opts.imageMediaType
      ? [
          { type: "image", source: { type: "base64", media_type: opts.imageMediaType, data: opts.imageBase64 } },
          { type: "text", text: opts.user },
        ]
      : opts.user;
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: userContent }],
    };
    if (opts.system) body.system = opts.system;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), link.timeoutMs ?? 60_000);
    let response: Response;
    try {
      response = await fetch(this.getBaseUrlFor(link), {
        method: "POST",
        headers: {
          "x-api-key": link.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`LLM Anthropic timeout: no response in ${link.timeoutMs ?? 60_000}ms`);
      }
      throw err;
    }
    clearTimeout(timer);

    if (!response.ok) {
      const err = await response.text();
      const e: RetryableError = new Error(`LLM Anthropic ${response.status}: ${err}`);
      // Anthropic uses 429 for rate-limit and 529 for "overloaded" — both are
      // worth honoring a Retry-After / reset window for.
      if (response.status === 429 || response.status === 529 || response.status === 503) {
        e.retryAfterMs = parseRetryAfterMs(response.headers);
      }
      throw e;
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
      model: string;
    };

    return {
      text: data.content?.find(b => b.type === "text")?.text ?? "",
      model: data.model ?? model,
      provider: "anthropic",
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    };
  }
}

/**
 * Logical slug for a chain link — the identifier used by the shared
 * provider health tracker. Prefer the explicit `slug` set by `materializeLink`;
 * fall back to inferring from baseUrl (xAI / NVIDIA / LM Studio share
 * `provider: "custom"`) and finally to the raw provider name.
 */
function slugOf(link: LlmConfig): string {
  if (link.slug) return link.slug;
  if (link.provider !== "custom") return link.provider;
  const url = link.baseUrl ?? "";
  if (/x\.ai/i.test(url)) return "grok";
  if (/nvidia/i.test(url)) return "nvidia";
  if (/localhost|127\.0\.0\.1|host\.docker\.internal/.test(url)) return "lmstudio";
  return "custom";
}

/**
 * Sort chain links by the shared health tracker's score. The configured
 * primary keeps a boost while it's healthy; once it accumulates enough
 * consecutive failures, the boost is dropped (soft auto-unpin) and the
 * fastest healthy alternative becomes the head of the chain for this call.
 *
 * Blocked-but-not-dead links land at the tail so we still try them as a
 * last resort instead of returning "all chain links exhausted".
 */
function sortLinksByHealth(links: LlmConfig[], primarySlug: string): LlmConfig[] {
  const ranked = providerHealth.rankCandidates(
    links.map(l => slugOf(l)),
    { primary: primarySlug },
  );
  // Map ranked slugs back to links, preserving duplicates by consuming
  // each link once (a chain may legitimately have two links of the same
  // slug — e.g. two different Claude models on the same provider).
  const remaining = [...links];
  const out: LlmConfig[] = [];
  for (const slug of ranked) {
    const idx = remaining.findIndex(l => slugOf(l) === slug);
    if (idx >= 0) {
      out.push(remaining[idx]);
      remaining.splice(idx, 1);
    }
  }
  // Anything not matched (defensive) goes to the tail in original order
  out.push(...remaining);
  return out;
}

/**
 * Errors worth retrying within the same link (transient server issues).
 * 5xx, network flakes, empty rate-limit bodies with backoff hint.
 */
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b5\d\d\b|ECONNRESET|ETIMEDOUT|network|socket/i.test(msg);
}

/**
 * Errors worth jumping to the next chain link (provider is unusable for now).
 * - 429 / quota / insufficient_quota / rate_limit → next link
 * - auth 401/403 → next link (probably wrong key)
 * - 5xx → next link after intra-link retry
 * - request timeout, network flake → next link
 * - 400 with validation error → DON'T fall back (caller's fault)
 */
/**
 * A credential problem rather than a request problem: the CLI is logged out,
 * the key was revoked, the subscription lapsed. Always worth trying the next
 * link, because the next link has different credentials.
 */
function isAuthFailure(msg: string): boolean {
  return /not logged in|\/login|logged out|unauthori[sz]ed|authentication|invalid[_ -]?api[_ -]?key|no credit|credit balance/i.test(
    msg,
  );
}

function isChainableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b400\b/.test(msg) && /invalid|validation|malformed/i.test(msg)) return false;
  // Credentials are per-link, so a dead one must never end the chain.
  if (isAuthFailure(msg)) return true;
  // 404 with "model … does not exist" is chainable — the next link uses a
  // different model, so falling through can save the call. Pure 404 on a non-
  // model resource is rare here, treat all 404 as chainable.
  return /\b(404|429|401|403|5\d\d)\b|quota|rate[_ ]?limit|timeout|ECONN|ETIMED|network|socket|does not exist|not found/i.test(msg);
}

// ── Factory ──

import type { KernelConfig } from "../config.js";

/**
 * Materialize a single chain entry (kernel provider name + model) into an
 * LlmConfig link. Returns null when the provider has no credentials — the
 * caller filters those out so we never add a dead link to the chain.
 */
function materializeLink(
  kernelProvider: string,
  model: string,
  config: KernelConfig,
): LlmConfig | null {
  const openaiKey = config.webIntel.openaiApiKey || config.voice.openaiApiKey;
  const anthropicKey = config.webIntel.anthropicApiKey;
  const grokKey = config.webIntel.grokApiKey;
  const nvidiaKey = config.webIntel.nvidiaApiKey;

  switch (kernelProvider) {
    case "openai":
      if (!openaiKey) return null;
      return {
        provider: "openai",
        slug: "openai",
        apiKey: openaiKey,
        defaultModel: model || "gpt-4o-mini",
      };
    case "anthropic":
    case "claude": {
      // SDK (OAuth via the logged-in CLI) is the preferred path — it doesn't
      // need an API key. The `chat()` filter accepts an empty apiKey when SDK
      // is available, and `chatAnthropic()` transparently routes the call.
      // Without this, an SDK-only user (no anthropic key set) would have
      // every `claude/*` chain entry dropped at materialize time.
      const sdkReady = !!getClaudeCodeSdk();
      if (!anthropicKey && !sdkReady) return null;
      return {
        provider: "anthropic",
        slug: "claude",
        apiKey: anthropicKey,
        defaultModel: model || "claude-haiku-4-5-20251001",
      };
    }
    case "grok":
    case "xai":
      if (!grokKey) return null;
      // xAI is OpenAI-compatible.
      return {
        provider: "custom",
        slug: "grok",
        apiKey: grokKey,
        baseUrl: "https://api.x.ai/v1/chat/completions",
        defaultModel: model || config.webIntel.grokDefaultModel || "grok-4-fast-reasoning",
      };
    case "nvidia":
    case "nim":
      if (!nvidiaKey) return null;
      // NVIDIA NIM is OpenAI-compatible.
      return {
        provider: "custom",
        slug: "nvidia",
        apiKey: nvidiaKey,
        baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
        defaultModel: model || config.webIntel.nvidiaDefaultModel || "deepseek-ai/deepseek-v4-pro",
      };
    case "minimax": {
      // MiniMax is registry-native (no config.webIntel home) — read its key
      // from process.env (mirrored there by syncProvidersToKernelConfig / .env).
      const minimaxKey = process.env.MINIMAX_API_KEY ?? "";
      if (!minimaxKey) return null;
      // OpenAI-compatible endpoint.
      const base = process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1";
      const url = base.endsWith("/chat/completions")
        ? base
        : `${base.replace(/\/+$/, "")}/chat/completions`;
      return {
        provider: "custom",
        slug: "minimax",
        apiKey: minimaxKey,
        baseUrl: url,
        defaultModel: model || process.env.MINIMAX_DEFAULT_MODEL || "MiniMax-M2.7",
      };
    }
    case "lmstudio":
    case "ollama": {
      const base = config.webIntel.lmstudioBaseUrl;
      if (!base) return null;
      // LM Studio / Ollama expose OpenAI-compatible /v1/chat/completions.
      const url = base.endsWith("/chat/completions")
        ? base
        : `${base.replace(/\/+$/, "")}/chat/completions`;
      return {
        provider: "custom",
        slug: kernelProvider === "ollama" ? "ollama" : "lmstudio",
        apiKey: "lm-studio", // dummy — LM Studio ignores auth
        baseUrl: url,
        defaultModel: model || "",
      };
    }
    case "claude_code":
    case "claude-code": {
      // Claude Agent SDK — not a direct HTTP endpoint. The link is shaped as
      // `anthropic` (so `chatOnce` enters the Anthropic branch) and the SDK
      // routing in `chatAnthropic` takes over from there. Drops out of the
      // chain if the CLI isn't installed.
      if (!getClaudeCodeSdk()) return null;
      return {
        provider: "anthropic",
        slug: "claude-code",
        apiKey: "",
        defaultModel: model || "claude-sonnet-4-5",
      };
    }
    default:
      return null;
  }
}

/**
 * Build a full LLM config with primary + fallback chain.
 * Priority order:
 *   1. config.agents.defaultModelChain[0]  → primary (if present + has key)
 *   2. config.chat.defaultProvider         → primary (legacy, if chain empty)
 *   3. first available key (openai → anthropic) → primary (last resort)
 *   Then the rest of defaultModelChain becomes the fallback chain.
 */
function buildLlmConfig(config: KernelConfig): LlmConfig {
  const chain = config.agents?.defaultModelChain ?? [];
  const materialized: LlmConfig[] = [];
  for (const e of chain) {
    const link = materializeLink(e.provider, e.model, config);
    if (link) materialized.push(link);
  }

  // Legacy fallback: if chain is empty or all dead, try chat.defaultProvider.
  if (materialized.length === 0) {
    const legacy = materializeLink(
      config.chat.defaultProvider || "openai",
      config.chat.defaultModel ?? "",
      config,
    );
    if (legacy) materialized.push(legacy);
  }

  // Last resort: whatever key exists.
  if (materialized.length === 0) {
    for (const provName of ["openai", "anthropic", "grok", "lmstudio"]) {
      const link = materializeLink(provName, "", config);
      if (link) { materialized.push(link); break; }
    }
  }

  if (materialized.length === 0) {
    // No providers configured at all — return an empty OpenAI shell so boot
    // succeeds; the first call will throw a clean "no key" error.
    return { provider: "openai", apiKey: "", defaultModel: "gpt-4o-mini" };
  }

  const [primary, ...fallbackChain] = materialized;
  return { ...primary, fallbackChain };
}

/**
 * A client pinned to ONE provider+model, with no fallback.
 *
 * Needed whenever you must measure or address a specific model rather than
 * "whatever the chain picks". `chat({ model })` alone is not enough: it
 * overrides the model NAME on the current primary, so asking for a Claude
 * model while MiniMax is primary sends a foreign model id to MiniMax, gets a
 * 400, and falls through — which measures the chain, not the model.
 *
 * Returns null when the provider isn't configured (no key, not installed).
 */
export function createPinnedLlmClient(
  provider: string,
  model: string,
  config: KernelConfig,
): LlmClient | null {
  const link = materializeLink(provider, model, config);
  if (!link) return null;
  return new LlmClient({ ...link, fallbackChain: [], maxRetries: 0 });
}

/** Create LLM client from kernel config, wired up with primary + fallback chain. */
export function createLlmClient(config: KernelConfig): LlmClient {
  return new LlmClient(buildLlmConfig(config));
}

/** Rebuild the global singleton's config (hot-reload on /api/config/ai POSTs). */
export function reloadLlmClient(config: KernelConfig): void {
  const client = (globalThis as { __llm?: LlmClient }).__llm;
  if (!client) return;
  client.reload(buildLlmConfig(config));
}

/** Get the global LLM client singleton (set during bootstrap) */
export function llm(): LlmClient {
  const client = (globalThis as any).__llm as LlmClient | undefined;
  if (!client) throw new Error("LLM client not initialized — bootstrap() not called yet");
  return client;
}

/** Create a lightweight LLM client for a specific purpose (triage, analysis, etc.) */
export function createLlmClientFromKeys(
  openaiKey: string,
  anthropicKey: string,
  preferredProvider?: string,
): LlmClient {
  const provider = (preferredProvider === "anthropic" && anthropicKey) ? "anthropic" : "openai";
  return new LlmClient({
    provider: provider as LlmProvider,
    apiKey: provider === "anthropic" ? anthropicKey : openaiKey,
    defaultModel: provider === "anthropic" ? "claude-haiku-4-5-20251001" : "gpt-4o-mini",
  });
}
