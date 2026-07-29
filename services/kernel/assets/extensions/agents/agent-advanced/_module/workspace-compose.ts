/**
 * Workspace compose stacks — per-workspace long-lived Bun containers.
 *
 * Each workspace may own a docker-compose stack that keeps a single `shell`
 * container warm. Bind-mounted volume means `bun install` populates
 * `node_modules` once, and subsequent execs (including the offline
 * one-shot `docker run --network=none` path) reuse it from disk.
 *
 * Lifecycle:
 *   • Created lazily on the first `kernel_workspace_exec` call that requests
 *     `network: true` (the typical `bun install` case).
 *   • Subsequent calls reuse the container via `docker compose exec`.
 *   • An idle reaper tears stacks down after IDLE_MS with no activity.
 *   • `shutdownAllCompose()` runs on kernel shutdown to drain gracefully.
 *
 * Fallback: when `docker compose` is not available (older Docker installs,
 * missing plugin, or Docker itself down), `composeUp` returns null and
 * callers fall back to the original one-shot `docker run` path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { log } from "../../../../../src/core/logger.js";
import { WORKSPACE_ROOT } from "./workspace-service.js";

const execFileAsync = promisify(execFile);

const COMPOSE_DIR = resolve(WORKSPACE_ROOT, ".compose");
const COMPOSE_SERVICE = "shell";
const COMPOSE_UP_TIMEOUT = 30_000;
const COMPOSE_DOWN_TIMEOUT = 30_000;

const DEFAULT_IDLE_MS = 30 * 60_000;   // 30 min
const DEFAULT_REAP_INTERVAL_MS = 10 * 60_000; // 10 min

let composeAvailabilityCache: boolean | null = null;
const lastExec = new Map<string, number>(); // wsId → Date.now()

export const COMPOSE_IMAGE = "oven/bun:1";

export async function isComposeAvailable(): Promise<boolean> {
  if (composeAvailabilityCache !== null) return composeAvailabilityCache;
  try {
    await execFileAsync("docker", ["compose", "version"], { timeout: 5000 });
    composeAvailabilityCache = true;
  } catch {
    composeAvailabilityCache = false;
  }
  return composeAvailabilityCache;
}

function composeFilePath(wsId: string): string {
  return resolve(COMPOSE_DIR, `${wsId}.yml`);
}

function projectName(wsId: string): string {
  return `mtw-ws-${wsId.slice(0, 8)}`;
}

function composeTemplate(wsId: string, workDir: string): string {
  return [
    `name: ${projectName(wsId)}`,
    `services:`,
    `  ${COMPOSE_SERVICE}:`,
    `    image: ${COMPOSE_IMAGE}`,
    `    container_name: ${projectName(wsId)}-shell`,
    `    working_dir: /workspace`,
    `    volumes:`,
    `      - ${workDir}:/workspace`,
    `    command: ["tail", "-f", "/dev/null"]`,
    `    mem_limit: 512m`,
    `    cpus: 1.0`,
    `    pids_limit: 200`,
    ``,
  ].join("\n");
}

async function ensureComposeFile(wsId: string, workDir: string): Promise<string> {
  await mkdir(COMPOSE_DIR, { recursive: true });
  const file = composeFilePath(wsId);
  const desired = composeTemplate(wsId, workDir);
  try {
    const existing = await readFile(file, "utf8");
    if (existing === desired) return file;
  } catch {
    // file doesn't exist yet — write fresh
  }
  await writeFile(file, desired, "utf8");
  return file;
}

export interface ComposeHandle {
  file: string;
  service: string;
}

export async function composeUp(wsId: string, workDir: string): Promise<ComposeHandle | null> {
  if (!(await isComposeAvailable())) return null;
  try {
    const file = await ensureComposeFile(wsId, workDir);
    await execFileAsync(
      "docker",
      ["compose", "-f", file, "up", "-d", "--remove-orphans"],
      { timeout: COMPOSE_UP_TIMEOUT, maxBuffer: 1024 * 1024 },
    );
    lastExec.set(wsId, Date.now());
    return { file, service: COMPOSE_SERVICE };
  } catch (err) {
    log.warn(`compose up failed for ${wsId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export interface ComposeExecResult {
  stdout: string;
  stderr: string;
}

export async function composeExec(
  wsId: string,
  handle: ComposeHandle,
  command: string,
  timeoutMs: number,
): Promise<ComposeExecResult> {
  const { stdout, stderr } = await execFileAsync(
    "docker",
    ["compose", "-f", handle.file, "exec", "-T", handle.service, "sh", "-c", command],
    { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
  );
  lastExec.set(wsId, Date.now());
  return { stdout, stderr };
}

export function markExec(wsId: string): void {
  lastExec.set(wsId, Date.now());
}

export async function composeDown(wsId: string, { removeVolumes = true }: { removeVolumes?: boolean } = {}): Promise<void> {
  const file = composeFilePath(wsId);
  try {
    await access(file);
  } catch {
    lastExec.delete(wsId);
    return; // nothing to tear down
  }
  const args = ["compose", "-f", file, "down"];
  if (removeVolumes) args.push("-v");
  try {
    await execFileAsync("docker", args, { timeout: COMPOSE_DOWN_TIMEOUT, maxBuffer: 1024 * 1024 });
  } catch (err) {
    log.warn(`compose down failed for ${wsId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await rm(file, { force: true });
  } catch { /* ignore */ }
  lastExec.delete(wsId);
}

export async function shutdownAllCompose(): Promise<void> {
  const ids = Array.from(lastExec.keys());
  if (ids.length === 0) return;
  log.info(`Workspace compose: shutting down ${ids.length} stack(s) on exit`);
  await Promise.allSettled(ids.map((id) => composeDown(id, { removeVolumes: false })));
}

let reaperTimer: NodeJS.Timeout | null = null;

/** Periodically tears down compose stacks that have been idle for more than idleMs. */
export function startIdleReaper(opts?: { idleMs?: number; intervalMs?: number }): void {
  if (reaperTimer) return;
  const idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
  const intervalMs = opts?.intervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  reaperTimer = setInterval(() => {
    const now = Date.now();
    const stale: string[] = [];
    for (const [id, ts] of lastExec.entries()) {
      if (now - ts > idleMs) stale.push(id);
    }
    if (stale.length === 0) return;
    log.info(`Workspace compose reaper: tearing down ${stale.length} idle stack(s)`);
    for (const id of stale) {
      void composeDown(id).catch(() => { /* already logged */ });
    }
  }, intervalMs);
  reaperTimer.unref?.();
}

export function stopIdleReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}
