/**
 * Store module — redeem a license into installed extensions.
 *
 * The free kernel ships the *mechanism* to buy add-ons, never the paid code:
 *   • kernel_store_browse   — list purchasable extensions + which your license
 *                             already covers.
 *   • kernel_store_install  — download the entitled .kernlext from the store
 *                             (authenticated with your license JWT) and install
 *                             it. The key IS the download credential.
 *
 * The store lives at KERNEL_STORE_URL (default https://issuer.lifekernl.com);
 * bundles are served only to a license that carries the matching `pro:<slug>`.
 *
 *   • kernel_store_update   — manual trigger for the auto-update engine: checks
 *                             the catalog for newer versions of already-installed,
 *                             licensed extensions and applies them in place.
 */

import type { KernelModule, ModuleContext, ToolDefinition, ToolResult } from "../../core/types.js";
import type { LicenseService } from "../../core/license/index.js";
import { textResult, errorResult } from "../../core/helpers.js";
import type { ExtensionService } from "../extensions/index.js";
import type { AgentService } from "../agents/service.js";
import { materializeOffice, officeDefinitionFromJson } from "../agents/office-kit.js";
import { z } from "zod";
import { fetchStoreCatalog, downloadStoreBundle, downloadStoreText } from "./client.js";
import { runStoreUpdates } from "./auto-update.js";
import { defineTool, defineToolNoInput } from "../../core/tool-builder.js";

export interface StoreModuleDeps {
  /** Resolves the extensions service used to install downloaded .kernlext bundles. */
  getExtensionService: () => ExtensionService | null;
  /** Resolves the agents service used to materialize downloaded office blueprints. */
  getAgentService: () => AgentService | null;
}

export const DEFAULT_STORE_URL = "https://issuer.lifekernl.com";

export function createStoreModule(deps: StoreModuleDeps): KernelModule {
  let tools: ToolDefinition[] = [];

  return {
    name: "store",
    async initialize(ctx: ModuleContext) {
      const storeUrl = process.env.KERNEL_STORE_URL ?? DEFAULT_STORE_URL;
      tools = buildTools(ctx, deps, storeUrl, ctx.license);
    },
    getTools() {
      return tools;
    },
    async shutdown() {},
  };
}

function buildTools(
  ctx: ModuleContext,
  deps: StoreModuleDeps,
  storeUrl: string,
  license: LicenseService,
): ToolDefinition[] {
  return [
    defineToolNoInput({
      name: "kernel_store_browse",
      description:
        "List the paid extensions available in the Kernl store and show which ones your current license already unlocks. Read-only.",
      outputSchema: z.unknown(),
      tags: ["store", "extensions", "license"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 300, reversible: true, cacheable: true },
      async handler(): Promise<ToolResult> {
        let items;
        try {
          items = await fetchStoreCatalog(storeUrl);
        } catch (e) {
          return errorResult(`Could not reach the store: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (items.length === 0) return textResult("The store catalog is currently empty.");

        const lines = items.map((it) => {
          const owned = ctx.license.has(it.feature);
          const badge = owned ? "✅ included in your license" : "🔒 not in your license";
          return `- **${it.name}** \`${it.slug}\` · v${it.version} — ${badge}`;
        });
        const anyOwned = items.some((it) => ctx.license.has(it.feature));
        const footer = anyOwned
          ? "\n\nInstall an unlocked one with `kernel_store_install { slug }`."
          : "\n\nGet a license at https://lifekernl.com/pricing, then install with `kernel_store_install { slug }`.";
        return textResult(`### Kernl store\n\n${lines.join("\n")}${footer}`);
      },
    }),
    defineTool({
      name: "kernel_store_install",
      description:
        "Download and install a paid extension from the Kernl store. Requires a license that includes the extension; the license authenticates the download. Installs the signed .kernlext and activates it if entitled.",
      schema: z.object({
        slug: z.string().min(1).describe("Extension slug, e.g. 'trading' (see kernel_store_browse)"),
      }),
      outputSchema: z.unknown(),
      tags: ["store", "extensions", "install"],
      sideEffects: ["extension.installed:1"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 4000, reversible: false, cacheable: false },
      async handler({ slug }): Promise<ToolResult> {
        const jwt = ctx.license.jwt();
        if (!jwt) {
          return errorResult(
            "No license found. Add your license under Settings → License (or paste your key), then try again.",
          );
        }

        // Look up the catalog item to know if it's an extension or an office.
        let item;
        try {
          item = (await fetchStoreCatalog(storeUrl)).find((i) => i.slug === slug) ?? null;
        } catch (e) {
          return errorResult(`Could not reach the store: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!item) return errorResult(`Unknown item "${slug}". Run kernel_store_browse to see what's available.`);

        return item.type === "office"
          ? installOffice(ctx, deps, storeUrl, slug, jwt)
          : installExtension(deps, storeUrl, slug, jwt);
      },
    }),
    defineToolNoInput({
      name: "kernel_store_update",
      description:
        "Check the Kernl store for newer versions of your installed, licensed extensions and apply them in place. " +
        "Only touches extensions you've already installed and your license covers — never installs anything new. " +
        "Free (no license) is a no-op. Manual trigger; nothing runs automatically.",
      outputSchema: z.unknown(),
      tags: ["store", "extensions", "update", "license"],
      sideEffects: ["extension.updated:*"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 4000, reversible: false, cacheable: false },
      async handler(): Promise<ToolResult> {
        const report = await runStoreUpdates({
          storeUrl,
          getExtensionService: deps.getExtensionService,
          licenseHas: (feature) => license.has(feature),
          licenseJwt: () => license.jwt(),
        });

        if (report.catalogError) {
          return errorResult(`Could not reach the store: ${report.catalogError}`);
        }

        const header = `Updated ${report.updated.filter((r) => r.ok).length}, skipped ${report.skipped}, ${report.errors} errors.`;
        if (report.updated.length === 0) return textResult(header);

        const lines = report.updated.map((r) =>
          r.ok
            ? `- ✅ **${r.slug}** ${r.from} → ${r.to}`
            : `- ❌ **${r.slug}** ${r.from} → ${r.to}: ${r.error}`,
        );
        return textResult(`${header}\n\n${lines.join("\n")}`);
      },
    }),
  ];
}

// ─── install paths ───────────────────────────────────────────────────

async function installExtension(
  deps: StoreModuleDeps,
  storeUrl: string,
  slug: string,
  jwt: string,
): Promise<ToolResult> {
  const service = deps.getExtensionService();
  if (!service) return errorResult("Extensions service is not available.");

  let bundlePath: string;
  try {
    bundlePath = (await downloadStoreBundle({ storeUrl, slug, licenseJwt: jwt })).path;
  } catch (e) {
    // Store returns precise messages (401 no/expired license, 403 not entitled,
    // 404 unknown/not-published) — surface them verbatim.
    return errorResult(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const installed = await service.installFromBundle(bundlePath, {
      type: "url",
      url: `${storeUrl.replace(/\/+$/, "")}/store/download?slug=${encodeURIComponent(slug)}`,
    });
    return textResult(
      `✅ Installed **${installed.slug}** from the store. ` +
        "Reload the kernel to activate it (`kernel_extensions_activate` or a restart).",
    );
  } catch (e) {
    return errorResult(`Install failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function installOffice(
  ctx: ModuleContext,
  deps: StoreModuleDeps,
  storeUrl: string,
  slug: string,
  jwt: string,
): Promise<ToolResult> {
  const service = deps.getAgentService();
  if (!service) return errorResult("Agents service is not available.");

  let text: string;
  try {
    text = await downloadStoreText({ storeUrl, slug, licenseJwt: jwt });
  } catch (e) {
    return errorResult(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let def;
  try {
    def = officeDefinitionFromJson(JSON.parse(text));
  } catch (e) {
    return errorResult(`Invalid office blueprint: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    materializeOffice(ctx.sqlite, service, def);
    return textResult(
      `✅ Set up the **${def.name}** office — ${def.agents.length} agents ` +
        `(${def.agents.map((a) => a.name).join(", ")}). Open the dashboard to see the team.`,
    );
  } catch (e) {
    return errorResult(`Office setup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
