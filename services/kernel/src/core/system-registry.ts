import { newId, isoNow } from "./helpers.js";

// ── Types ─────────────────────────────────────

export type ProcessType = "interval" | "event-listener" | "cache" | "watcher";
export type ProcessStatus = "running" | "stopped" | "idle";

export interface SystemProcess {
  id: string;
  name: string;
  type: ProcessType;
  module: string;
  description: string;
  intervalMs?: number;
  event?: string;
  ttlMs?: number;
  status: ProcessStatus;
  startedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  runCount: number;
  metadata?: Record<string, unknown>;
}

export interface SystemStats {
  total: number;
  running: number;
  byType: Record<ProcessType, number>;
  byModule: Record<string, number>;
}

type RegisterInput = Omit<SystemProcess, "id" | "startedAt" | "runCount" | "status"> & {
  status?: ProcessStatus;
};

// ── Registry ──────────────────────────────────

export class SystemRegistry {
  private processes = new Map<string, SystemProcess>();

  register(entry: RegisterInput): string {
    const id = newId();
    this.processes.set(id, {
      ...entry,
      id,
      status: entry.status ?? "running",
      startedAt: isoNow(),
      runCount: 0,
    });
    return id;
  }

  unregister(id: string): void {
    this.processes.delete(id);
  }

  recordRun(id: string): void {
    const proc = this.processes.get(id);
    if (!proc) return;
    const now = isoNow();
    proc.lastRunAt = now;
    proc.runCount++;
    if (proc.type === "interval" && proc.intervalMs) {
      proc.nextRunAt = new Date(Date.now() + proc.intervalMs).toISOString();
    }
  }

  recordCacheHit(id: string): void {
    const proc = this.processes.get(id);
    if (!proc) return;
    proc.runCount++;
  }

  recordCacheRefresh(id: string): void {
    const proc = this.processes.get(id);
    if (!proc) return;
    const now = new Date();
    proc.lastRunAt = now.toISOString();
    if (proc.ttlMs) {
      proc.nextRunAt = new Date(now.getTime() + proc.ttlMs).toISOString();
    }
  }

  updateStatus(id: string, status: ProcessStatus): void {
    const proc = this.processes.get(id);
    if (!proc) return;
    proc.status = status;
  }

  get(id: string): SystemProcess | undefined {
    return this.processes.get(id);
  }

  list(): SystemProcess[] {
    return [...this.processes.values()];
  }

  getStats(): SystemStats {
    const byType: Record<string, number> = {};
    const byModule: Record<string, number> = {};
    let running = 0;

    for (const proc of this.processes.values()) {
      byType[proc.type] = (byType[proc.type] ?? 0) + 1;
      byModule[proc.module] = (byModule[proc.module] ?? 0) + 1;
      if (proc.status === "running") running++;
    }

    return {
      total: this.processes.size,
      running,
      byType: byType as Record<ProcessType, number>,
      byModule,
    };
  }

  clear(): void {
    this.processes.clear();
  }
}

/** Singleton instance shared across the kernel */
export const systemRegistry = new SystemRegistry();
