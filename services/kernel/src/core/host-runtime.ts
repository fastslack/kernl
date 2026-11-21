/**
 * The kernel's side of the extension host: its live services, installed where
 * every copy of the SDK looks for them (`src/sdk/host.ts`).
 *
 * Installed at the start of `bootstrap()`, before any extension loads. The
 * test preload installs it too, so suites that exercise extension code see
 * the real implementations rather than the default host.
 */

import { SDK_MAJOR, installedHost, setHost, type KernlHost } from "../sdk/host.js";
import type { ProjectsHost } from "../sdk/projects.js";
import { log } from "./logger.js";
import { llm, createPinnedLlmClient } from "./llm/client.js";
import { logLlmStart, logLlmEnd, logLlmFail } from "./llm/logger.js";
import { record as recordLlmCall } from "./llm/call-log.js";
import { getProviderConfig, isConnected } from "./llm/credentials.js";
import { getPrincipal, getRequestContext } from "./request-context.js";
import { principalCan } from "./principal.js";
import { parsePermission } from "./permissions.js";
import { currentScope, refAllowed } from "./scope.js";
import { loadTransformers } from "./transformers-cache.js";
import { mediaToolBin, probeMediaTool, mediaToolError } from "./media-tools.js";
import { PeeringService } from "./peering/service.js";
import { verifyRequest } from "./peering/auth.js";

// Bootstrap points this at the live config (useTimezone); until then, UTC.
let timezoneSource: () => string = () => "UTC";

/** Let every copy of the SDK read the kernel's TIMEZONE setting, live. */
export function useTimezone(get: () => string): void {
  timezoneSource = get;
}

// Bootstrap points this at the projects module once it is up; until then, none.
let projectsSource: () => ProjectsHost | null = () => null;

/** Let every copy of the SDK reach the live projects module. */
export function useProjects(get: () => ProjectsHost | null): void {
  projectsSource = get;
}

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
  recordLlmCall,
  getRequestContext,
  loadTransformers,
  mediaToolBin,
  probeMediaTool,
  mediaToolError,
  peering: () => PeeringService.current,
  verifyPeerRequest: verifyRequest,
  timezone: () => timezoneSource(),
  projects: () => projectsSource(),
  can: (permission: string) => {
    const principal = getPrincipal();
    // Work the kernel starts on its own (an agent run, a trigger) carries no
    // principal and is not a user's to restrict.
    if (!principal || principal.kind === "super_admin") return true;
    const need = parsePermission(permission);
    // Wildcards name no single requirement, and a typo must not grant.
    if (!need || need.module === "*" || need.level === "*") return false;
    return principalCan(principal, { module: need.module, level: need.level });
  },
  inScope: (id: string, level: "read" | "write") => {
    const scope = currentScope();
    return !scope || refAllowed(scope, id, level);
  },
});

/** Install the kernel host. Idempotent; warns if it displaces another host. */
export function installKernlHost(): void {
  const current = installedHost();
  if (current === kernelHost) return;
  if (current) log.warn("extension host: replacing a host that was already installed");
  setHost(kernelHost);
}
