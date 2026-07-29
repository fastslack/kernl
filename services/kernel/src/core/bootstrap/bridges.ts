/**
 * Stage: global LLM client + bridges + MCP stdio.
 *
 *  - Builds the singleton LlmClient (also stashed in `globalThis.__llm` so
 *    legacy callers via `llm()` see it).
 *  - Wires the chat memory distiller (needs `__llm`).
 *  - Optionally starts the mtwRequest BridgeServer (unix socket).
 *  - Optionally connects the Rust bridge, pushes LLM creds, hands the bridge
 *    to the torrents module so it can flip to the Rust engine when present.
 *  - Optionally starts MCP stdio (transport=stdio|both).
 */

import { log } from "../logger.js";
import type { KernelConfig } from "../config.js";
import type { ToolDefinition } from "../types.js";
import type { EventBus } from "../event-bus.js";
import type { ModuleRegistry } from "../module-registry.js";
import type { Identity } from "../attestation.js";
import type { CostRouter } from "../llm/cost-router.js";
import type { LlmClient } from "../llm/client.js";
import type { ToolMemoryModule } from "../../modules/tool-memory/index.js";
import type { TorrentsModule, MeshModule } from "../types/extensions/index.js";

import { createLlmClient } from "../llm/client.js";
import { BridgeServer } from "../mtw/bridge-server.js";
import { RustBridge } from "../rust/bridge.js";
import { createRustDelegates } from "../rust/delegates.js";
import { createMcpServer, startStdio } from "../../server.js";
import type { SkillRegistry } from "../../skills/registry.js";

export interface BridgesResult {
  llmClient: LlmClient;
  bridgeServer: BridgeServer | null;
  rustBridge: RustBridge | null;
  rustDelegates: ReturnType<typeof createRustDelegates> | null;
}

export async function initBridgesAndStdio(args: {
  config: KernelConfig;
  events: EventBus;
  registry: ModuleRegistry;
  chatModule: { wireDistiller: () => void };
  torrentsModule: TorrentsModule | null;
  finalTools: ToolDefinition[];
  // For MCP stdio
  useStdio: boolean;
  attestIdentity: Identity | undefined;
  costRouter: CostRouter;
  toolMemoryModule: ToolMemoryModule;
  meshModule: MeshModule | null;
  skillRegistry: SkillRegistry;
}): Promise<BridgesResult> {
  const {
    config, events, registry,
    chatModule, torrentsModule, finalTools,
    useStdio,
    attestIdentity, costRouter, toolMemoryModule, meshModule, skillRegistry,
  } = args;

  // ── Global LLM Client (singleton, used by all services via llm()) ──
  const llmClient = createLlmClient(config);
  log.info(`LLM client: provider=${llmClient.provider}, hasKey=${llmClient.hasKey}`);
  (globalThis as { __llm?: LlmClient }).__llm = llmClient;

  // ── Late-binding subsystems that depend on the global LLM client ──
  chatModule.wireDistiller();

  // ── mtwRequest Bridge (Unix socket) ────────────────
  let bridgeServer: BridgeServer | null = null;
  if (config.bridge.enabled) {
    bridgeServer = new BridgeServer({
      socketPath: config.bridge.socketPath,
      tools: finalTools,
      events,
    });
    await bridgeServer.start();
  }

  // ── Rust Bridge (delegate heavy operations to Rust) ──
  let rustBridge: RustBridge | null = null;
  let rustDelegates: ReturnType<typeof createRustDelegates> | null = null;
  if (config.rustBridge.enabled) {
    rustBridge = new RustBridge({
      socketPath: config.rustBridge.socketPath,
      timeout: 30000,
      reconnect: true,
      reconnectDelay: 2000,
    });

    try {
      await rustBridge.connect();
      rustDelegates = createRustDelegates(rustBridge);
      log.info(`Rust bridge connected: ${config.rustBridge.socketPath}`);

      // Push LLM credentials to Rust so it can call providers without env vars.
      const credProviders: Array<Record<string, string>> = [];
      if (config.webIntel.anthropicApiKey) {
        credProviders.push({ name: "anthropic", api_key: config.webIntel.anthropicApiKey });
      }
      if (config.webIntel.openaiApiKey) {
        credProviders.push({ name: "openai", api_key: config.webIntel.openaiApiKey });
      }
      if (config.webIntel.lmstudioBaseUrl) {
        credProviders.push({ name: "lmstudio", api_key: "local", base_url: config.webIntel.lmstudioBaseUrl });
      }
      if (credProviders.length > 0) {
        rustBridge.call("credentials.set", { providers: credProviders })
          .then((r) => log.info(`Rust bridge: credentials pushed (${JSON.stringify(r)})`))
          .catch((e) => log.warn(`Rust bridge: credentials.set failed: ${e}`));
      }

      // Hand the bridge to the torrents module so it can probe mtwRequest's
      // `torrent.health` and switch the engine over to Rust when present.
      const torrentBackendMode = (process.env.TORRENT_BACKEND ?? "auto") as "auto" | "rust" | "legacy";
      torrentsModule?.setRustBridge(rustBridge, torrentBackendMode)
        .catch((e) => log.warn(`torrents: setRustBridge failed: ${e}`));
    } catch (err) {
      log.warn(`Rust bridge unavailable, using local fallback: ${err}`);
      rustBridge = null;
    }
  }

  // ── MCP stdio ──────────────────────────────────────
  if (useStdio) {
    const server = createMcpServer(registry, events, {
      skillRegistry,
      identity: attestIdentity,
      costRouter,
      toolMemory: toolMemoryModule.getService() ?? undefined,
      mesh: meshModule?.getService() ?? undefined,
    });
    await startStdio(server);
  }

  return {
    llmClient,
    bridgeServer,
    rustBridge,
    rustDelegates,
  };
}
