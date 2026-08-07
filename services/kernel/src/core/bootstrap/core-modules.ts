/**
 * Stage: register the in-tree (non-extension) modules and run
 * `registry.initializeAll(ctx)`.
 *
 * Order matters — Config goes first so chat / agents see its tools on init.
 * Meta + Plans are registered with *late-bound* accessors (`metaCatalogSlot`,
 * `metaIdentitySlot`, `metaCostRouterSlot`) so they pick up the full tool
 * catalog after extensions load (see `extensions.ts`) and the attestation
 * identity / cost router (see `services.ts`).
 *
 * The MCP plans dispatcher closure handles two cases:
 *   * mesh-proxy (`peer:<short>:<name>`): forwarded to the trusted peer; the
 *     peer's signed receipt is lifted into the outcome verbatim.
 *   * local: resolves from the live catalog and dispatches in-process, signing
 *     a receipt if the identity slot is populated.
 *
 * Performance indexes (composite indexes for dashboard queries) are applied
 * AFTER `initializeAll` since they cover tables created by module migrations.
 */

import { log } from "../logger.js";
import type { ToolDefinition, ModuleContext } from "../types.js";
import type { Identity } from "../attestation.js";
import type { CostRouter } from "../llm/cost-router.js";
import type { ModuleRegistry } from "../module-registry.js";
import type { EmbeddingsClient } from "../embeddings/index.js";

import { createChatProviders, resolveProvider } from "../llm/chat-adapters.js";

import { createConfigModule, type ConfigModule } from "../../modules/config/index.js";
import { createDashboardModule } from "../../modules/dashboard/index.js";
import { createMetaModule } from "../../modules/meta/index.js";
import { createMcpPlansModule } from "../../modules/mcp-plans/index.js";
import { createToolMemoryModule, type ToolMemoryModule } from "../../modules/tool-memory/index.js";
import { createBrainModule } from "../../modules/brain/index.js";
import { createExtensionsModule, type ExtensionsModuleHandle } from "../../modules/extensions/index.js";
import { createStoreModule } from "../../modules/store/index.js";
import { createChatModule } from "../../modules/chat/index.js";
import { createAgentsModule } from "../../modules/agents/index.js";
import { createOfficeInfraModule } from "../../modules/office-infra/index.js";
import { configureAudit as configurePromptSanitizerAudit } from "../prompt-sanitizer.js";
import { applyPerformanceIndexes } from "../db/performance-indexes.js";
import type { MeshModule } from "../types/extensions/index.js";

export interface CoreModulesResult {
  configModule: ConfigModule;
  toolMemoryModule: ToolMemoryModule;
  extensionsModule: ExtensionsModuleHandle;
  chatModule: ReturnType<typeof createChatModule>;
  agentsModule: ReturnType<typeof createAgentsModule>;

  // Late-bound slots (mutated by later stages).
  metaCatalogSlot: { value: () => ToolDefinition[] };
  metaIdentitySlot: { value: () => Identity | undefined };
  metaCostRouterSlot: { value: () => CostRouter | undefined };
  embeddingsResolver: ((c: EmbeddingsClient) => void) | null;
  embeddingsPromise: Promise<EmbeddingsClient>;
}

/**
 * Register all in-tree core modules and run `registry.initializeAll(ctx)`.
 *
 * `getMesh()` is a late-bound accessor — the mesh module is loaded as an
 * extension further down, so the MCP plans dispatcher resolves it per-call.
 */
export async function initCoreModules(args: {
  registry: ModuleRegistry;
  ctx: ModuleContext;
  getMesh: () => MeshModule | null;
}): Promise<CoreModulesResult> {
  const { registry, ctx, getMesh } = args;

  // ── Config — must register first so chat sees its tools at init ──
  const configModule = createConfigModule() as ConfigModule;
  registry.register(configModule);

  // ── Dashboard ──────────────────────────────────────
  registry.register(createDashboardModule());

  // ── Late-bound slots (Meta + Plans see them via getters) ──
  // We use a ref-object so other stages can mutate `.value` and the getters
  // already wired into Meta/Plans pick up the new function.
  const metaCatalogSlot: { value: () => ToolDefinition[] } = {
    value: () => registry.getAllTools(),
  };
  const metaIdentitySlot: { value: () => Identity | undefined } = {
    value: () => undefined,
  };
  const metaCostRouterSlot: { value: () => CostRouter | undefined } = {
    value: () => undefined,
  };

  // ── Tool-memory ──
  // EmbeddingsClient is built later in `services.ts`; pass a promise that
  // resolves once it's available. Module's initialize() awaits it and
  // gracefully degrades if it fails.
  let embeddingsResolver: ((c: EmbeddingsClient) => void) | null = null;
  const embeddingsPromise = new Promise<EmbeddingsClient>((res) => {
    embeddingsResolver = res;
  });

  // Late-bound embeddings ref so the meta module's `getEmbeddings()` reads the
  // latest value: the client is created in `services.ts` and only resolves the
  // promise above. Stays null if embeddings never come online (degrades to
  // lexical ranking inside the digest tool).
  let embeddingsClientRef: EmbeddingsClient | null = null;
  void embeddingsPromise.then((c) => {
    embeddingsClientRef = c;
  });

  // Chat providers + default resolution mirror the agents executor
  // (see modules/agents/index.ts). Built here so kernel_research_digest's
  // map-reduce gets a one-shot completer fed by the same default provider.
  const digestProviders = createChatProviders({
    anthropicApiKey: ctx.config.webIntel.anthropicApiKey,
    openaiApiKey: ctx.config.webIntel.openaiApiKey,
    lmstudioBaseUrl: ctx.config.webIntel.lmstudioBaseUrl,
    grokApiKey: ctx.config.webIntel.grokApiKey,
    grokDefaultModel: ctx.config.webIntel.grokDefaultModel,
    nvidiaApiKey: ctx.config.webIntel.nvidiaApiKey,
    nvidiaDefaultModel: ctx.config.webIntel.nvidiaDefaultModel,
    claudeCode: ctx.config.claudeCode,
  });
  const digestDefaultProvider =
    ctx.config.agents?.defaultProvider || ctx.config.chat.defaultProvider || "claude";

  registry.register(createMetaModule({
    getCatalog: () => metaCatalogSlot.value(),
    getIdentity: () => metaIdentitySlot.value(),
    getCostRouter: () => metaCostRouterSlot.value(),
    getEmbeddings: () => embeddingsClientRef,
    getCompleter: () => {
      // Resolve lazily at registration time, the same way the agents executor
      // picks a provider — falls through to any healthy fallback.
      const provider = resolveProvider(digestProviders, digestDefaultProvider);
      if (!provider || !provider.available()) return undefined;
      return async (system, user) => {
        const res = await provider.chatCompletion(
          [{ role: "user", content: user }],
          { system, max_tokens: 4096 },
        );
        // Reasoning models (e.g. MiniMax) emit <think> blocks that would otherwise
        // consume the budget and leave the digest as raw chain-of-thought. Strip
        // them so the digest is the finished answer.
        const text = res.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        return { text, tokens: res.tokens_used };
      };
    },
  }));
  const toolMemoryModule = createToolMemoryModule(() => embeddingsPromise) as ToolMemoryModule;
  registry.register(toolMemoryModule);

  // ── Brain (unified semantic memory across modules) ──
  // Same late-bound embeddings promise as tool-memory. Auto-indexing is
  // gated behind BRAIN_AUTO_INDEX=1 (see modules/brain/index.ts) so a full
  // backfill never runs unsupervised; tools work regardless.
  registry.register(createBrainModule(() => embeddingsPromise));

  // ── MCP Plans (mesh-aware dispatcher) ──
  registry.register(createMcpPlansModule({
    getCatalog: () => metaCatalogSlot.value(),
    getIdentity: () => metaIdentitySlot.value(),
    getCostRouter: () => metaCostRouterSlot.value(),
    getDispatcher: () => async (toolName, args) => {
      const started = Date.now();

      // Mesh-proxy path: `peer:<short>:<remote_name>` resolves to a
      // trusted peer and is forwarded over HTTP. The receipt that comes
      // back is signed by the peer's identity — we lift it into the
      // outcome verbatim so the plan_receipt's merkle root mixes
      // local + remote attestations.
      if (toolName.startsWith("peer:")) {
        const meshSvc = getMesh()?.getService() ?? null;
        const resolved = meshSvc?.resolveLocal(toolName);
        if (!resolved || !meshSvc) {
          return {
            isError: true,
            output: { error: `mesh tool not resolvable (peer not trusted?): ${toolName}` },
            duration_ms: Date.now() - started,
          };
        }
        try {
          const remote = await meshSvc.callPeerTool({
            peerId: resolved.peer.peer_id,
            toolName: resolved.remoteName,
            arguments: args,
          });
          const r = remote as {
            isError?: boolean;
            content?: Array<{ text?: string }>;
            structuredContent?: unknown;
            _meta?: { ["mtw.attestation"]?: import("../attestation.js").Receipt };
          };
          return {
            isError: r.isError === true,
            output: r.structuredContent ?? { content: r.content ?? [] },
            // The peer's signed receipt rides through unchanged — its
            // server_id will differ from ours, which is the whole point.
            receipt: r._meta?.["mtw.attestation"],
            duration_ms: Date.now() - started,
          };
        } catch (err: unknown) {
          return {
            isError: true,
            output: { error: err instanceof Error ? err.message : String(err) },
            duration_ms: Date.now() - started,
          };
        }
      }

      // Local path: resolve from the live catalog and dispatch in-process.
      const tool = metaCatalogSlot.value().find((t) => t.name === toolName);
      if (!tool) {
        return { isError: true, output: { error: `unknown tool: ${toolName}` }, duration_ms: 0 };
      }
      try {
        const parsed = tool.inputSchema.parse(args);
        const result = await tool.handler(parsed);
        const isError = result.isError === true;
        const output = result.structuredContent ?? { content: result.content };
        const id = metaIdentitySlot.value();
        let receipt: import("../attestation.js").Receipt | undefined;
        if (id) {
          const { signReceipt, hashJson } = await import("../attestation.js");
          receipt = signReceipt({
            identity: id,
            tool: toolName,
            inputHash: hashJson(args ?? {}),
            outputHash: hashJson({
              text: result.content.map((c) => c.text ?? "").join(""),
              isError,
              ...(result.structuredContent !== undefined
                ? { structuredContent: result.structuredContent }
                : {}),
            }),
            sideEffects: isError ? [] : (tool.sideEffects ?? []),
          });
        }
        return {
          isError,
          output,
          receipt,
          duration_ms: Date.now() - started,
        };
      } catch (err: unknown) {
        return {
          isError: true,
          output: { error: err instanceof Error ? err.message : String(err) },
          duration_ms: Date.now() - started,
        };
      }
    },
  }));

  // ── Extensions module (unified extensions registry) ──
  // Configure the prompt-injection audit log next to other persistent state.
  const extensionsDataPath = process.cwd().endsWith("data") ? process.cwd() : `${process.cwd()}/data`;
  configurePromptSanitizerAudit(`${extensionsDataPath}/blocked-prompts.log`);
  const extensionsModule = createExtensionsModule({
    dataPath: extensionsDataPath,
  }) as ExtensionsModuleHandle;
  registry.register(extensionsModule);

  // ── Chat + Agents ──────────────────────────────────
  const chatModule = createChatModule();
  registry.register(chatModule);
  const agentsModule = createAgentsModule();
  registry.register(agentsModule);
  registry.register(createOfficeInfraModule());

  // Store: redeem a license into installed add-ons — downloads the entitled
  // .kernl / office blueprint from the licensed store and hands it to the
  // extensions installer or office-kit. Registered after agents so it can
  // resolve both services. Lazy getters: resolved at tool-run time.
  registry.register(
    createStoreModule({
      getExtensionService: () => {
        try {
          return extensionsModule.service;
        } catch {
          return null;
        }
      },
      getAgentService: () => agentsModule.getService(),
    }),
  );

  // ── Initialize every registered module ─────────────
  await registry.initializeAll(ctx);

  // ── Performance indexes (post-migrations) ──────────
  applyPerformanceIndexes(ctx.sqlite);

  log.debug("Core modules initialized + performance indexes applied");

  return {
    configModule,
    toolMemoryModule,
    extensionsModule,
    chatModule,
    agentsModule,
    metaCatalogSlot,
    metaIdentitySlot,
    metaCostRouterSlot,
    embeddingsResolver,
    embeddingsPromise,
  };
}
