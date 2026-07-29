import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { log } from "../../../../../src/core/logger.js";
import { AgentManifestSchema } from "./types.js";
import type { AgentDescriptor } from "./types.js";

/**
 * AgentLoader — discovers and validates agents in a directory.
 *
 * Expected layout:
 *   <agentsDir>/
 *     my-agent/
 *       manifest.json   ← required
 *       index.ts        ← default entry (or overridden by manifest.entry)
 *
 * Usage:
 *   const loader = new AgentLoader("/path/to/agents");
 *   const descriptors = await loader.discover();
 */
export class AgentLoader {
  constructor(private agentsDir: string) {}

  /**
   * Scan agentsDir for subdirectories containing a manifest.json.
   * Returns validated AgentDescriptors (skips invalid ones with warnings).
   */
  async discover(): Promise<AgentDescriptor[]> {
    const absDir = resolve(this.agentsDir);

    if (!existsSync(absDir)) {
      log.debug(`[AgentLoader] Agents directory not found: ${absDir} — no agents loaded`);
      return [];
    }

    let entries: string[];
    try {
      entries = await readdir(absDir);
    } catch (err) {
      log.warn(`[AgentLoader] Cannot read agents directory: ${err}`);
      return [];
    }

    const descriptors: AgentDescriptor[] = [];

    for (const entry of entries) {
      const agentDir = join(absDir, entry);
      const manifestPath = join(agentDir, "manifest.json");

      if (!existsSync(manifestPath)) {
        // Not an agent directory — skip silently
        continue;
      }

      const descriptor = await this.loadDescriptor(agentDir, manifestPath, entry);
      if (descriptor) {
        descriptors.push(descriptor);
      }
    }

    log.info(`[AgentLoader] Discovered ${descriptors.length} agent(s) in ${absDir}`);
    return descriptors;
  }

  private async loadDescriptor(
    agentDir: string,
    manifestPath: string,
    dirName: string,
  ): Promise<AgentDescriptor | null> {
    // Parse manifest
    let raw: unknown;
    try {
      const file = Bun.file(manifestPath);
      raw = await file.json();
    } catch (err) {
      log.warn(`[AgentLoader] Cannot parse ${manifestPath}: ${err}`);
      return null;
    }

    // Validate with Zod
    const parsed = AgentManifestSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn(
        `[AgentLoader] Invalid manifest at ${manifestPath}: ${parsed.error.message}`,
      );
      return null;
    }

    const manifest = parsed.data;

    // Name must match directory name
    if (manifest.name !== dirName) {
      log.warn(
        `[AgentLoader] manifest.name "${manifest.name}" must match directory name "${dirName}" — skipping`,
      );
      return null;
    }

    // Entry point must exist
    const entryPath = join(agentDir, manifest.entry);
    if (!existsSync(entryPath)) {
      log.warn(
        `[AgentLoader] Entry point not found: ${entryPath} — skipping agent "${manifest.name}"`,
      );
      return null;
    }

    log.debug(`[AgentLoader] Loaded agent "${manifest.name}" v${manifest.version}`);

    return { manifest, dir: agentDir, entryPath };
  }
}
