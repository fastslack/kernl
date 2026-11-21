/**
 * The HTTP leg of an `llm()` call, run by mtwRequest (mtw-ai's
 * `llm.complete` on the Rust bridge socket).
 *
 * The driver (client.ts) still decides everything: which link and model,
 * the order of the chain, health, the 429 limiter, retries, the call log and
 * the usage accounting. This module only hands one exchange to the broker,
 * which builds the provider's request, sends it through its egress policy
 * and reports back the text and token counts, or the HTTP status, body and
 * rate-limit headers of a failure. The driver turns a failure into the very
 * error it would have raised from its own fetch (`LLM OpenAI 429: …`, with
 * `retryAfterMs`), so classification, failover and the log do not change.
 *
 * The broker is mandatory, but an LLM call must not wait for it: with no
 * bridge, the bridge down, a broker that predates `llm.complete`, a request
 * too large for one frame, or `LLM_GATEWAY=off`, `callGateway` returns null
 * and the driver makes the call itself, as before. The Claude Code link is
 * never sent here: it is a local subprocess with the user's sign-in.
 *
 * Keys travel with each call over the local socket; the broker keeps none.
 */

import { log } from "../logger.js";
import type { RetryableError } from "./retry.js";
import { parseRetryAfterMs } from "./retry.js";

/** What the broker needs from the bridge client. */
export interface LlmGatewayTransport {
  isConnected(): boolean;
  call(tool: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>;
}

export interface GatewayCall {
  wire: "openai" | "anthropic";
  url: string;
  apiKey: string;
  model: string;
  system?: string;
  user: string;
  image?: { mediaType: string; data: string };
  /** Top-level body fields besides model, messages and system. */
  params: Record<string, unknown>;
  timeoutMs: number;
}

export interface GatewayUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export type GatewayResult =
  | { ok: true; text: string; model: string; usage: GatewayUsage }
  | {
      ok: false;
      kind: "http" | "timeout" | "network" | "invalid_response";
      status?: number;
      message: string;
      headers?: Record<string, string>;
    };

/** One frame on the bridge is at most 10 MB; leave room for the envelope. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** A broker without `llm.complete` is asked again after this long. */
const UNSUPPORTED_RETRY_MS = 5 * 60_000;
/** The broker's own timeout should fire first; the bridge's is a backstop. */
const BRIDGE_GRACE_MS = 5_000;

interface GatewayState {
  transport: LlmGatewayTransport | null;
  unsupportedUntil: number;
  announced: boolean;
}

// On globalThis, like the rest of the driver's state: extension bundles that
// carry their own copy of this module must see the kernel's bridge.
const STATE_KEY = "__kernlLlmGateway";
function state(): GatewayState {
  const g = globalThis as unknown as Record<string, GatewayState | undefined>;
  return (g[STATE_KEY] ??= { transport: null, unsupportedUntil: 0, announced: false });
}

/** Registered at bootstrap with the Rust bridge client; `null` unregisters. */
export function setLlmGateway(transport: LlmGatewayTransport | null): void {
  const s = state();
  s.transport = transport;
  s.unsupportedUntil = 0;
  s.announced = false;
}

function switchedOff(): boolean {
  const v = process.env.LLM_GATEWAY?.trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "no";
}

function approxBytes(c: GatewayCall): number {
  return c.user.length + (c.system?.length ?? 0) + (c.image?.data.length ?? 0) + 4096;
}

/**
 * Run the call on the broker. Null means "make it yourself": no broker to
 * ask, or one that cannot take this call. Never throws.
 */
export async function callGateway(c: GatewayCall): Promise<GatewayResult | null> {
  const s = state();
  const t = s.transport;
  if (!t || switchedOff() || !t.isConnected()) return null;
  if (s.unsupportedUntil > Date.now()) return null;
  if (approxBytes(c) > MAX_REQUEST_BYTES) return null;

  const args: Record<string, unknown> = {
    wire: c.wire,
    url: c.url,
    api_key: c.apiKey,
    model: c.model,
    user: c.user,
    params: c.params,
    timeout_ms: c.timeoutMs,
  };
  if (c.system) args.system = c.system;
  if (c.image) args.image = { media_type: c.image.mediaType, data: c.image.data };

  let raw: unknown;
  try {
    raw = await t.call("llm.complete", args, { timeoutMs: c.timeoutMs + BRIDGE_GRACE_MS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/tool not found/i.test(msg)) {
      s.unsupportedUntil = Date.now() + UNSUPPORTED_RETRY_MS;
      log.info("llm: this mtwRequest has no llm.complete — calling providers from the kernel");
      return null;
    }
    // Dropped before the call went out: nothing was sent, make it here.
    if (/not connected/i.test(msg)) return null;
    // Lost mid-call: the provider may have it. Report a network failure, which
    // the driver retries like any other.
    return { ok: false, kind: "network", message: `mtwRequest gateway: ${msg}` };
  }

  const r = raw as Partial<GatewayResult> | null;
  if (!r || typeof r !== "object" || typeof r.ok !== "boolean") {
    return { ok: false, kind: "invalid_response", message: "mtwRequest gateway: malformed llm.complete reply" };
  }
  if (!s.announced) {
    s.announced = true;
    log.info("llm: provider calls go through mtwRequest (mtw-ai llm.complete)");
  }
  return r as GatewayResult;
}

/**
 * The error the driver's own fetch would have raised for this failure, so
 * health classification, failover and the call log read it the same way.
 * `retryStatuses` are the statuses whose rate-limit headers are honoured.
 */
export function gatewayError(
  label: "OpenAI" | "Anthropic",
  f: Extract<GatewayResult, { ok: false }>,
  timeoutMs: number,
  retryStatuses: readonly number[],
): RetryableError {
  switch (f.kind) {
    case "http": {
      const e: RetryableError = new Error(`LLM ${label} ${f.status}: ${f.message}`);
      if (f.status !== undefined && retryStatuses.includes(f.status)) {
        e.retryAfterMs = parseRetryAfterMs(new Headers(f.headers ?? {}));
      }
      return e;
    }
    case "timeout":
      return new Error(`LLM ${label} timeout: no response in ${timeoutMs}ms`);
    case "network":
      return new Error(`LLM ${label} network error: ${f.message}`);
    default:
      return new Error(`LLM ${label} invalid response: ${f.message}`);
  }
}
