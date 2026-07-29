/**
 * Helpers for gating Pro modules behind a license.
 *
 * Two flavors:
 *
 *   1. `stubTools(moduleName, feature)` — returns a single placeholder tool
 *      that the kernel registers in place of the real catalog. The model
 *      sees one well-named tool that, when called, returns a friendly
 *      "this requires Pro" error with the upgrade URL. This keeps the
 *      module's *name* present in `tools/list` so the MCP discovery flow
 *      doesn't pretend the module never existed — important so the user's
 *      AI client can suggest "upgrade to use trading features".
 *
 *   2. `gateToolList(real, license, feature)` — registers the real tools
 *      but wraps each handler so any invocation returns the same friendly
 *      error if the license expires mid-session. Use only for modules
 *      whose initialization is cheap; for heavy modules (DB tables,
 *      background workers), prefer the stubTools pattern + early return.
 *
 * Both keep the marketing URL and feature name in a single place so
 * messaging stays consistent across modules.
 */

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../types.js";
import type { LicenseService } from "./types.js";

const UPGRADE_URL = "https://github.com/fastslack/kernl/pro";

function lockedResult(moduleName: string, feature: string): ToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: `🔒 The ${moduleName} module requires Kernl Pro.\n\n` +
            `Get a license at ${UPGRADE_URL} (${feature}).\n` +
            `Once you have a license JWT, save it at ~/.config/kernl/license.jwt ` +
            `or set it via the dashboard at /settings/license, then restart the kernel.`,
    }],
  };
}

/**
 * One placeholder tool that announces the module's locked state. Picks a
 * name unlikely to clash with any free module (`kernel_<name>_info`).
 */
export function stubTools(moduleName: string, feature: string): ToolDefinition[] {
  return [{
    name: `kernel_${moduleName}_info`,
    description: `${moduleName} module status. Pro license required to enable the full toolset.`,
    inputSchema: z.object({}),
    tags: ["meta", "license", "locked"],
    async handler() {
      return lockedResult(moduleName, feature);
    },
  }];
}

/**
 * Wrap a full tool list so each handler checks the license at call time.
 * The model still sees the real names and schemas (helpful for the LLM
 * to learn what's available), but every execution gates on the license.
 *
 * Returns a fresh array — the input is not mutated.
 */
export function gateToolList(
  real: ToolDefinition[],
  license: LicenseService,
  feature: string,
  moduleName: string,
): ToolDefinition[] {
  return real.map((t): ToolDefinition => ({
    ...t,
    async handler(args) {
      if (!license.has(feature)) return lockedResult(moduleName, feature);
      return t.handler(args);
    },
  }));
}

/**
 * Boolean helper used by modules whose `initialize()` does expensive work
 * (DB migrations, worker threads, background timers). They early-return
 * when this is false, leaving the module loaded but inert.
 */
export function requireFeature(license: LicenseService, feature: string): boolean {
  return license.has(feature);
}
