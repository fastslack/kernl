/**
 * storage module — database size and data retention.
 *
 * Collects `getRetentionPolicies()` from every module (its own core policies
 * included), applies the enabled ones nightly, measures table sizes and
 * compacts the file when enough space came free. Backs /system?tab=storage.
 *
 * Supersedes `script:cleanup`, which it retires on boot.
 */

import type { AgentDriver, KernelModule, ModuleContext, RetentionPolicy, ToolDefinition } from "../../core/types.js";
import type { RpcAction } from "../../core/mtw/rpc-handler.js";
import { runMigrations } from "../../core/db/migrations.js";
import { log } from "../../core/logger.js";
import { storageMigrations } from "./migrations.js";
import { corePolicies } from "./core-policies.js";
import { StorageService, compactRefusal } from "./service.js";

export interface StorageModule extends KernelModule {
  getService(): StorageService | null;
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function createStorageModule(listModules: () => KernelModule[]): StorageModule {
  let service: StorageService | null = null;
  let firstMeasure: ReturnType<typeof setTimeout> | null = null;
  const policies = corePolicies();

  const need = (): StorageService => {
    if (!service) throw new Error("storage module not initialised");
    return service;
  };

  /** Long work runs detached; the page follows it through `storage.progress.get`. */
  const detach = (label: string, work: () => Promise<unknown>) => {
    work().catch((err) => log.warn(`storage: ${label} failed: ${err instanceof Error ? err.message : String(err)}`));
    return { started: true };
  };

  const retentionRun = async (): Promise<string> => {
    const s = need();
    const summary = await s.run("cron");
    await s.measure();
    const lines = [
      `Retention: ${summary.deletedRows} rows (~${fmtBytes(summary.freedBytesEst)})${summary.vacuumed ? ", compacted" : ""}.`,
      ...summary.details.filter((d) => d.deleted > 0 || d.error).map((d) => `- ${d.label}: ${d.deleted}${d.error ? ` (error: ${d.error})` : ""}`),
      `DB: ${fmtBytes(summary.dbBytesBefore)} → ${fmtBytes(summary.dbBytesAfter)}`,
    ];
    return lines.join("\n");
  };

  return {
    name: "storage",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "storage", storageMigrations);
      service = new StorageService(ctx.sqlite, ctx.config.sqlite.path, listModules);
      // The page needs one measurement to show anything; take it shortly
      // after boot when today has none, off the boot path.
      firstMeasure = setTimeout(() => {
        const today = new Date().toISOString().slice(0, 10);
        if (!service || service.latestSnapshot()?.day === today) return;
        service.measure().catch((err) => log.warn("storage: first measurement failed", err));
      }, 90_000);
      firstMeasure.unref?.();
    },

    getTools(): ToolDefinition[] {
      return [];
    },

    getService: () => service,

    getRetentionPolicies(): RetentionPolicy[] {
      return policies;
    },

    getAgentDrivers(): AgentDriver[] {
      return [
        {
          handler: "storage:retention",
          name: "Data Retention",
          description: "Applies the data retention policies set on System › Storage, measures table sizes and compacts the database when enough space came free.",
          cron: "30 3 * * *",
          flow: "Automations",
          timeout_ms: 2 * 60 * 60 * 1000,
          run: retentionRun,
        },
        {
          // Superseded by storage:retention. Retired so its weekly agent row
          // gets parked instead of running hardcoded cutoffs behind the
          // user's settings; the handler stays so a hand-enabled row works.
          handler: "script:cleanup",
          name: "Data Cleanup",
          description: "Superseded by Data Retention (storage:retention).",
          retired: true,
          run: retentionRun,
        },
      ];
    },

    getRpcActions(): RpcAction[] {
      return [
        { name: "storage.get", handler: async () => need().overview() },
        { name: "storage.progress.get", handler: async () => ({ progress: need().getProgress() }) },
        {
          name: "storage.measure",
          handler: async () => {
            await need().measure();
            return need().overview();
          },
        },
        {
          name: "storage.run",
          handler: async (args) => {
            const only = typeof args.policy === "string" ? args.policy : undefined;
            const s = need();
            if (s.getProgress()) throw new Error("A cleanup or compaction is already running");
            return detach("cleanup", async () => {
              await s.run("manual", { only });
              await s.measure();
            });
          },
        },
        {
          name: "storage.compact",
          handler: async () => {
            const s = need();
            const check = s.compactCheck();
            if (!check.ok) throw new Error(compactRefusal(check.reason));
            if (s.getProgress()) throw new Error("A cleanup or compaction is already running");
            return detach("compact", async () => {
              await s.compact();
              await s.measure();
            });
          },
        },
        {
          name: "storage.policy.set",
          handler: async (args) => {
            const id = String(args.id ?? "");
            const patch: { enabled?: boolean; days?: number | null; cap?: number | null } = {};
            if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
            if (args.days !== undefined) patch.days = args.days === null ? null : Number(args.days);
            if (args.cap !== undefined) patch.cap = args.cap === null ? null : Number(args.cap);
            return need().setPolicy(id, patch);
          },
        },
        { name: "storage.policy.reset", handler: async (args) => need().resetPolicy(String(args.id ?? "")) ?? null },
        {
          name: "storage.preview.get",
          handler: async (args) =>
            need().preview(String(args.id ?? ""), args.days === undefined ? undefined : Number(args.days)),
        },
        { name: "storage.stray.delete", handler: async (args) => need().deleteStrayFile(String(args.name ?? "")) },
      ];
    },

    async shutdown() {
      if (firstMeasure) clearTimeout(firstMeasure);
      service = null;
    },
  };
}
