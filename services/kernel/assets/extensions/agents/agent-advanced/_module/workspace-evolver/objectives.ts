/**
 * Objectives loader — reads EVOLUTION.md verbatim from a workspace.
 *
 * Returned text is plumbed into meta-LLM prompts. We intentionally do NOT
 * parse the markdown structure: the LLM reads it as-is, and humans edit it
 * as-is. If you need structured access (mission/invariants split), parse
 * downstream — don't bake a structure assumption here.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OBJECTIVES_RELPATH } from "./policy.js";

const MAX_OBJECTIVES_BYTES = 32_000;

export async function loadObjectives(workspaceDir: string): Promise<string | null> {
  const path = resolve(workspaceDir, OBJECTIVES_RELPATH);
  try {
    const raw = await readFile(path, "utf8");
    if (raw.length > MAX_OBJECTIVES_BYTES) {
      // A meta-LLM prompt must not balloon. Truncating with a marker beats
      // silently dropping content because the user can see it happened.
      return raw.slice(0, MAX_OBJECTIVES_BYTES) + "\n\n[…truncated]";
    }
    return raw;
  } catch {
    return null;
  }
}
