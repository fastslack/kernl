/**
 * Kernel types an extension may name. Type-only: nothing here reaches a
 * bundle, so re-exporting them from the kernel's own files costs nothing and
 * keeps one definition of each.
 */

export type * from "../core/types.js";
export type { SqliteDb } from "../core/db/sqlite.js";
export type { Neo4jClient } from "../core/db/neo4j.js";
export type { GraphDriver, GraphResult } from "../core/db-drivers/graph-driver.js";
export type { EventBus } from "../core/event-bus.js";
export type { KernelConfig, KernelLanguage } from "../core/config.js";
export type { KernelHttpServer } from "../core/http-server.js";
export type { RpcAction } from "../core/mtw/rpc-handler.js";
export type { SystemRegistry } from "../core/system-registry.js";
export type { ModuleRegistry } from "../core/module-registry.js";
export type { Notifier } from "../core/notify/notifier.js";
export type {
  NotificationPayload,
  NotificationProvider,
  ProviderStatus,
  ProviderCapability,
  ConfigField,
} from "../core/notify/provider.js";
export type * from "../channels/types.js";
export type { EmbeddingsClient } from "../core/embeddings/client.js";
export type { LicenseService } from "../core/license/types.js";
export type { InlineButton } from "../core/extension-seams.js";
export type { RustBridge } from "../core/rust/bridge.js";
export type { Identity } from "../core/attestation.js";
export type { SandboxHandle, SandboxRunOptions } from "../core/sandbox/driver.js";
export type { SandboxDriverRegistry } from "../core/sandbox/registry.js";
export type { VoiceService } from "../voice/service.js";
export type { PeeringService } from "../core/peering/service.js";
export type { LlmClient } from "../core/llm/client.js";
export type { LlmStartInfo, LlmEndInfo, LlmFailInfo } from "../core/llm/logger.js";
export type { MediaTool, MediaToolStatus } from "../core/media-tools.js";
export type { KernelRequestContext } from "../core/request-context.js";
export type { ReminderServiceLike } from "../core/types/extensions/reminders.js";
export type { KernelEventsModuleEvents } from "../core/types/extensions/events.js";

// Google API shapes. Only google-sync and comms use them; they leave the
// kernel together with the Google extension.
export type * from "../core/integrations/google-types.js";
