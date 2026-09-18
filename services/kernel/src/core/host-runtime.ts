/**
 * The kernel's side of the extension host: its live services, installed where
 * every copy of the SDK looks for them (`src/sdk/host.ts`).
 *
 * Installed at the start of `bootstrap()`, before any extension loads. The
 * test preload installs it too, so suites that exercise extension code see
 * the real implementations rather than the default host.
 */

import { SDK_MAJOR, installedHost, setHost, type KernlHost } from "../sdk/host.js";
import { log } from "./logger.js";
import { llm, createPinnedLlmClient } from "./llm/client.js";
import { logLlmStart, logLlmEnd, logLlmFail } from "./llm/logger.js";
import { getProviderConfig, isConnected } from "./llm/credentials.js";
import { getRequestContext } from "./request-context.js";
import { loadTransformers } from "./transformers-cache.js";
import { mediaToolBin, probeMediaTool, mediaToolError } from "./media-tools.js";
import { PeeringService } from "./peering/service.js";
import { verifyRequest } from "./peering/auth.js";

const kernelHost: KernlHost = Object.freeze({
  sdk: SDK_MAJOR,
  log,
  llm,
  createPinnedLlmClient,
  getProviderConfig,
  isConnected,
  logLlmStart,
  logLlmEnd,
  logLlmFail,
  getRequestContext,
  loadTransformers,
  mediaToolBin,
  probeMediaTool,
  mediaToolError,
  peering: () => PeeringService.current,
  verifyPeerRequest: verifyRequest,
});

/** Install the kernel host. Idempotent; warns if it displaces another host. */
export function installKernlHost(): void {
  const current = installedHost();
  if (current === kernelHost) return;
  if (current) log.warn("extension host: replacing a host that was already installed");
  setHost(kernelHost);
}
