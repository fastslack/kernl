/**
 * attachments module — images, documents and short videos attached to chat
 * messages, as input for the model.
 *
 * Owns the `attachments` table, the files under `<data>/attachments/`, the
 * upload/serve routes and the processing queue. Chat and agents reach it
 * through `getAttachmentService()` to bind ids on send and to read the
 * records back when building a prompt.
 */

import type { DashboardDescriptor, ExtensibleModule, ModuleContext, ToolDefinition } from "../../core/types.js";
import { runMigrations } from "../../core/db/migrations.js";
import { log } from "../../core/logger.js";
import { attachmentsMigrations } from "./migrations.js";
import { registerAttachmentRoutes } from "./routes.js";
import { AttachmentService } from "./service.js";

export type { AttachmentDerived, AttachmentKind, AttachmentMeta, AttachmentRecord, AttachmentStatus } from "./types.js";
export {
  AttachmentService,
  isAttachmentId,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AttachmentServiceOptions,
  type AttachmentLimits,
} from "./service.js";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let current: AttachmentService | null = null;

/** The live service, or null before the module initialised (or in a process without it). */
export function getAttachmentService(): AttachmentService | null {
  return current;
}

/** Test-only — install (or clear) the service chat and agents reach through getAttachmentService(). */
export function _setAttachmentServiceForTests(service: AttachmentService | null): void {
  current = service;
}

export interface AttachmentsModule extends ExtensibleModule {
  getService(): AttachmentService | null;
}

export function createAttachmentsModule(): AttachmentsModule {
  let service: AttachmentService | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  return {
    name: "attachments",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "attachments", attachmentsMigrations);
      service = new AttachmentService(ctx.sqlite, { voice: () => ctx.config.voice });
      current = service;

      const requeued = service.requeuePending();
      if (requeued) log.info(`attachments: re-queued ${requeued} attachment(s) left processing`);

      sweepTimer = setInterval(() => {
        service?.sweepOrphans().catch((err) => log.warn(`attachments: sweep failed: ${err instanceof Error ? err.message : String(err)}`));
      }, SWEEP_INTERVAL_MS);
      sweepTimer.unref?.();
    },

    getTools(): ToolDefinition[] {
      return [];
    },

    getService: () => service,

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        registerRoutes: (server) => {
          if (service) registerAttachmentRoutes(server, service);
        },
      };
    },

    async shutdown() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      service?.stop();
      if (current === service) current = null;
    },
  };
}
