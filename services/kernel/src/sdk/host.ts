/**
 * The contract between an extension and the kernel it runs in.
 *
 * Every extension is bundled on its own, so any kernel module it imports is
 * copied into its bundle. For a module that holds state — the logger's level,
 * a request's AsyncLocalStorage, the LLM client — that copy is a second,
 * empty instance the kernel never touches: the extension logs at the default
 * level, reads no caller context, and so on.
 *
 * The host is the one live instance. The kernel installs it on a process-wide
 * symbol while it boots, and every copy of this file reads the same slot,
 * because `Symbol.for` hands back the same symbol to all of them. Nothing here
 * holds state of its own.
 *
 * Without a kernel (tests, scripts) the default host answers: logging goes to
 * stderr, and anything that needs a running kernel says so instead of
 * returning something plausible.
 */

import type { LlmClient } from "../core/llm/client.js";
import type { ProviderConfig } from "../core/llm/credentials.js";
import type { KernelConfig } from "../core/config.js";
import type { LlmStartInfo, LlmEndInfo, LlmFailInfo } from "../core/llm/logger.js";
import type { MediaTool, MediaToolStatus } from "../core/media-tools.js";
import type { KernelRequestContext } from "../core/request-context.js";
import type { PeeringService } from "../core/peering/service.js";
import type { verifyRequest } from "../core/peering/auth.js";

/** Major version of the extension contract. Manifests declare it as `sdk`. */
export const SDK_MAJOR = 1;

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export interface KernlHost {
  readonly sdk: number;
  readonly log: Logger;
  llm(): LlmClient;
  createPinnedLlmClient(provider: string, model: string, config: KernelConfig): LlmClient | null;
  /**
   * A provider's key, URL and model from the kernel's encrypted provider
   * registry — for the few extension features that must call a provider API
   * directly (speech-to-text). Chat goes through `llm()`.
   */
  getProviderConfig(slugOrAlias: string): ProviderConfig;
  /**
   * Whether the user finished connecting this provider. `getProviderConfig`
   * alone cannot answer this for a provider like LM Studio, whose `baseUrl`
   * falls back to a non-empty catalog default even when never connected.
   */
  isConnected(slugOrAlias: string): boolean;
  logLlmStart(info: LlmStartInfo): void;
  logLlmEnd(info: LlmEndInfo): void;
  logLlmFail(info: LlmFailInfo): void;
  getRequestContext(): KernelRequestContext;
  loadTransformers(): Promise<typeof import("@huggingface/transformers")>;
  mediaToolBin(tool: MediaTool): string;
  probeMediaTool(tool: MediaTool, opts?: { fresh?: boolean }): Promise<MediaToolStatus>;
  mediaToolError(tool: MediaTool, cause?: unknown): Error;
  peering(): PeeringService | null;
  verifyPeerRequest: typeof verifyRequest;
}

const HOST_KEY = Symbol.for("kernl.host");
type HostSlot = { [HOST_KEY]?: KernlHost };
const slot = globalThis as HostSlot;

export class KernlHostVersionError extends Error {
  constructor(hostMajor: number) {
    super(
      `Kernl host speaks SDK v${hostMajor}, but this code was built against SDK v${SDK_MAJOR} — rebuild it`,
    );
    this.name = "KernlHostVersionError";
  }
}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function defaultWrite(level: Level, msg: string, data?: unknown): void {
  const wanted = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  if (LEVELS[level] < (LEVELS[wanted] ?? LEVELS.info)) return;
  let payload = "";
  if (data !== undefined) {
    try {
      payload = ` ${JSON.stringify(data)}`;
    } catch {
      payload = ` ${String(data)}`;
    }
  }
  process.stderr.write(`${level.toUpperCase()} ${msg}${payload}\n`);
}

function notInstalled(fn: string): never {
  throw new Error(`Kernl host not installed: ${fn}() only works inside a running kernel`);
}

const defaultHost: KernlHost = Object.freeze({
  sdk: SDK_MAJOR,
  log: Object.freeze({
    debug: (msg: string, data?: unknown) => defaultWrite("debug", msg, data),
    info: (msg: string, data?: unknown) => defaultWrite("info", msg, data),
    warn: (msg: string, data?: unknown) => defaultWrite("warn", msg, data),
    error: (msg: string, data?: unknown) => defaultWrite("error", msg, data),
  }),
  llm: () => notInstalled("llm"),
  createPinnedLlmClient: () => notInstalled("createPinnedLlmClient"),
  getProviderConfig: () => notInstalled("getProviderConfig"),
  isConnected: () => notInstalled("isConnected"),
  logLlmStart: () => {},
  logLlmEnd: () => {},
  logLlmFail: () => {},
  getRequestContext: () => ({ callerAgentId: "", callerRunId: "", callerDepth: 0 }),
  loadTransformers: () => notInstalled("loadTransformers"),
  mediaToolBin: () => notInstalled("mediaToolBin"),
  probeMediaTool: () => notInstalled("probeMediaTool"),
  mediaToolError: () => notInstalled("mediaToolError"),
  peering: () => null,
  verifyPeerRequest: () => notInstalled("verifyPeerRequest"),
});

/** The installed host, or the default one when no kernel is running. */
export function getHost(): KernlHost {
  const host = slot[HOST_KEY];
  if (!host) return defaultHost;
  if (host.sdk !== SDK_MAJOR) throw new KernlHostVersionError(host.sdk);
  return host;
}

/** The host currently in the slot, without falling back to the default. */
export function installedHost(): KernlHost | undefined {
  return slot[HOST_KEY];
}

/**
 * Put a host in the slot, or clear it with `undefined`. Meant for the kernel's
 * boot sequence and for tests; an extension has no reason to call it.
 */
export function setHost(host: KernlHost | undefined): void {
  if (host === undefined) {
    delete slot[HOST_KEY];
    return;
  }
  slot[HOST_KEY] = Object.isFrozen(host) ? host : Object.freeze(host);
}
