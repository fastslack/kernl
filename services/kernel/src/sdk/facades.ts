/**
 * Kernel services an extension reaches through the host instead of a bundled
 * copy. Each keeps the name and signature of the kernel function it stands
 * for, so moving an import here is the whole migration.
 */

import { getHost, type KernlHost } from "./host.js";
import type { KernelConfig } from "../core/config.js";
import type { LlmClient } from "../core/llm/client.js";
import type { ProviderConfig } from "../core/llm/credentials.js";
import type { LlmStartInfo, LlmEndInfo, LlmFailInfo } from "../core/llm/logger.js";
import type { LlmCallRecord } from "../core/llm/call-log.js";
import type { MediaTool, MediaToolStatus } from "../core/media-tools.js";
import type { KernelRequestContext } from "../core/request-context.js";
import type { PeeringService } from "../core/peering/service.js";
import type { NostrIdentity } from "./nostr-identity.js";

/**
 * The kernel's LLM driver. Every model call goes through it: provider
 * fallback, the 429 limiter, retries, the call log and usage accounting all
 * live behind this one door. Pass a `caller:` tag so the call is attributable.
 */
export function llm(): LlmClient {
  return getHost().llm();
}

/** A client pinned to one provider and model, for when the chain must not pick. */
export function createPinnedLlmClient(
  provider: string,
  model: string,
  config: KernelConfig,
): LlmClient | null {
  return getHost().createPinnedLlmClient(provider, model, config);
}

export function logLlmStart(info: LlmStartInfo): void {
  getHost().logLlmStart(info);
}

export function logLlmEnd(info: LlmEndInfo): void {
  getHost().logLlmEnd(info);
}

export function logLlmFail(info: LlmFailInfo): void {
  getHost().logLlmFail(info);
}

/** Record a model call made outside `llm()` so it shows in token usage. */
export function recordLlmCall(record: LlmCallRecord, opts?: { silent?: boolean }): void {
  getHost().recordLlmCall?.(record, opts);
}

/**
 * A provider's key, URL and model from the kernel's encrypted provider
 * registry. For the few extension features that must call a provider API that
 * is not a chat completion (speech-to-text); chat goes through `llm()`.
 */
export function getProviderConfig(slugOrAlias: string): ProviderConfig {
  return getHost().getProviderConfig(slugOrAlias);
}

/** Whether the user finished connecting this provider. */
export function isConnected(slugOrAlias: string): boolean {
  return getHost().isConnected(slugOrAlias);
}

/** The caller context of the MCP request being served, or an empty default. */
export function getRequestContext(): KernelRequestContext {
  return getHost().getRequestContext();
}

/** `@huggingface/transformers`, with its model cache pointed at the data dir. */
export function loadTransformers(): Promise<typeof import("@huggingface/transformers")> {
  return getHost().loadTransformers();
}

/** Resolved binary for ffmpeg, ffprobe or whisper-cli. */
export function mediaToolBin(tool: MediaTool): string {
  return getHost().mediaToolBin(tool);
}

/** Probe one media tool. Never throws. */
export function probeMediaTool(tool: MediaTool, opts?: { fresh?: boolean }): Promise<MediaToolStatus> {
  return getHost().probeMediaTool(tool, opts);
}

/** Turn a media tool spawn failure into something a user can act on. */
export function mediaToolError(tool: MediaTool, cause?: unknown): Error {
  return getHost().mediaToolError(tool, cause);
}

/** The kernel's peering service, or null when peering is off. */
export function peering(): PeeringService | null {
  return getHost().peering();
}

/**
 * The instance's own Nostr identity (the key peering signs with), or null
 * while peering is off. Never the user's social persona: whatever is signed
 * with it is tied to this machine, not to the person.
 */
export function instanceNostrIdentity(): NostrIdentity | null {
  const service = getHost().peering();
  if (!service) return null;
  // Extension bundles inline this SDK and may run on an older core whose
  // PeeringService predates the accessor; its `identity` field is the same
  // instance key, so fall back to it only in that case.
  if (typeof service.instanceNostrIdentity !== "function") return service.identity ?? null;
  return service.instanceNostrIdentity();
}

/**
 * True when the instance key is the same key as the Social persona (a legacy
 * install that kept old friendships). Public "this is a Kernl instance"
 * announcements must then stay off: signing them would link the persona to
 * the machine. False while peering is off.
 */
export function instanceKeyIsShared(): boolean {
  const service = getHost().peering();
  // An older core (see instanceNostrIdentity) cannot tell; report not shared.
  if (!service || typeof service.instanceKeyIsShared !== "function") return false;
  return service.instanceKeyIsShared();
}

/**
 * Tell the kernel which Social persona runs on this instance, so trusted
 * friends can fetch a link-proof for it over peering (never published). The
 * kernel keeps only the proof, never the key; pass null to withdraw it.
 *
 * Returns false when it did not take: peering off or not started yet, an
 * older core, or another persona already registered. Peering starts after
 * extensions initialise, so call it again from `registerRoutes` (which runs
 * once peering exists); nothing is stashed in between.
 */
export function registerPersona(identity: NostrIdentity | null): boolean {
  const service = getHost().peering();
  if (!service || typeof service.registerPersona !== "function") return false;
  return service.registerPersona(identity) !== false;
}

/**
 * Persona pubkeys (hex) of trusted friends, learned from their link-proofs.
 * Empty when peering is off or the core predates link-proofs.
 */
export function friendPersonas(): string[] {
  const service = getHost().peering();
  if (!service || typeof service.friendPersonas !== "function") return [];
  return service.friendPersonas();
}

/** Verify a NIP-98 signed request from a peer against the friends store. */
export const verifyPeerRequest: KernlHost["verifyPeerRequest"] = (opts) =>
  getHost().verifyPeerRequest(opts);
