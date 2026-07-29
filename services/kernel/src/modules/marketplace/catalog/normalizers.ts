/**
 * Normalizers — convert "native" manifest formats (SKILL.json, plugin
 * manifest.json) into the unified ExtensionManifest used by `installed_extensions`.
 *
 * The marketplace surfaces every installable artifact through one shape so
 * the dashboard, the install pipeline, and the audit log all speak the same
 * language. Adapters live here so the provider scanners stay dumb.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionManifest } from "../../extensions/schema.js";
import type {
  ExtensionPermission,
  ExtensionType,
} from "../../extensions/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Reverse-DNS ids are required by the manifest schema. Skills/plugins use
 * short ids; we namespace them under `bundled.kernl.<slug>` so the
 * schema validator is happy.
 */
function reverseDnsId(rawId: string, namespace: string): string {
  if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(rawId)) return rawId;
  return `${namespace}.${slugify(rawId)}`;
}

function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s.length >= 3 ? s : `item-${s || "x"}`;
}

function ensureSemver(v: string | undefined): string {
  if (v && /^\d+\.\d+\.\d+/.test(v)) return v;
  return "0.0.1";
}

const SAFE_PERMS = new Set<string>([
  "read:contacts", "write:contacts",
  "read:tasks", "write:tasks",
  "read:reminders", "write:reminders",
  "read:events", "write:events",
  "read:finance", "write:finance",
  "read:health", "write:health",
  "network", "filesystem", "notifications", "voice",
]);

function normalizePermissions(raw: unknown): ExtensionPermission[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is string => typeof p === "string")
    .filter((p) => SAFE_PERMS.has(p) || /^module:[a-z][a-z0-9-]*$/.test(p))
    .map((p) => p as ExtensionPermission);
}

// ── SKILL.json → ExtensionManifest ───────────────────────────────────

interface SkillManifestRaw {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  homepage?: string;
  icon?: string;
  category?: string;
  permissions?: unknown;
  tags?: unknown;
  main?: string;
  configSchema?: Record<string, unknown>;
  minKernelVersion?: string;
  dependencies?: string[];
}

/**
 * Read a skill directory and emit an ExtensionManifest with type='skill'.
 * The resulting manifest carries `permissions` from SKILL.json and tags the
 * `main` entry (e.g. "index.js") via `backend.entry` so the install path can
 * find it. The skill-installer in extensions/installer.ts then routes through
 * SkillRegistry.install({type:"bundled", id: slug}).
 */
export async function readSkillAsExtensionManifest(
  skillDir: string,
): Promise<ExtensionManifest> {
  const raw = await readFile(join(skillDir, "SKILL.json"), "utf-8");
  const parsed = JSON.parse(raw) as SkillManifestRaw;

  const slug = slugify(parsed.id);
  const id = reverseDnsId(parsed.id, "bundled.kernl.skill");

  return {
    $schema: "kernl://extension/v1",
    id,
    slug,
    name: parsed.name ?? slug,
    version: ensureSemver(parsed.version),
    type: "skill",
    description: parsed.description ?? "",
    author: parsed.author ?? "unknown",
    license: "Unknown",
    icon: parsed.icon,
    category: parsed.category ?? "utility",
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === "string")
      : [],
    permissions: normalizePermissions(parsed.permissions),
    homepage: parsed.homepage,
    backend: parsed.main ? { entry: parsed.main } : undefined,
    dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
  } as ExtensionManifest;
}

// ── plugin manifest.json → ExtensionManifest ─────────────────────────

interface PluginManifestRaw {
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  entry?: string;
  permissions?: unknown;
  tools?: unknown;
  timeoutMs?: number;
  autoStart?: boolean;
  env?: Record<string, string>;
}

// ── SKILL.md (Anthropic Claude Code convention) → ExtensionManifest ──
//
// Anthropic skills (and most community skill repos like
// coreyhaines31/marketingskills) follow this layout:
//   <repo>/
//     <skill-name>/
//       SKILL.md              <- YAML frontmatter + markdown body
//       references/...        <- optional supporting files
//       scripts/...           <- optional helper scripts
//
// The SKILL.md frontmatter looks like:
//   ---
//   name: skill-name
//   description: One-line summary
//   license: MIT
//   ---
//   # Long-form body in markdown
//
// We normalize this into an ExtensionManifest of type='skill'. The body
// becomes long_description so the dashboard can render the docs inline.

interface SkillMdFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  category?: string;
  icon?: string;
  permissions?: unknown;
  tags?: unknown;
  homepage?: string;
}

/**
 * Tiny YAML-frontmatter parser. Handles:
 *   - top-level scalar key: value
 *   - quoted strings ("foo" / 'foo')
 *   - YAML list inline ([a, b, c]) and block (- item)
 * Doesn't handle nested objects — skills don't need them.
 *
 * Returns null when the document doesn't start with `---`. Called for every
 * .md file under a discovered repo, so any non-skill markdown is silently
 * skipped.
 */
function parseFrontmatter(raw: string): { fm: SkillMdFrontmatter; body: string } | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return null;
  const fmText = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, "");

  const fm: Record<string, unknown> = {};
  let currentListKey: string | null = null;
  let currentList: string[] | null = null;

  for (const lineRaw of fmText.split("\n")) {
    const line = lineRaw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Block-list continuation: "  - item"
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentList) {
      currentList.push(stripQuotes(listItem[1].trim()));
      continue;
    }
    // Close any open list when we see a new top-level key.
    currentListKey = null;
    currentList = null;

    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const valueRaw = m[2].trim();

    if (valueRaw === "" || valueRaw === "|" || valueRaw === ">") {
      // Block list opener: "permissions:"  followed by "  - item" lines
      currentListKey = key;
      currentList = [];
      fm[key] = currentList;
      continue;
    }

    // Inline list "[a, b, c]"
    if (valueRaw.startsWith("[") && valueRaw.endsWith("]")) {
      fm[key] = valueRaw.slice(1, -1)
        .split(",")
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0);
      continue;
    }

    fm[key] = stripQuotes(valueRaw);
  }

  return { fm: fm as SkillMdFrontmatter, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Read a Claude-Code-style SKILL.md and produce an ExtensionManifest.
 * The body becomes `long_description` so the dashboard can render the docs.
 */
export async function readSkillMdAsExtensionManifest(
  skillDir: string,
): Promise<ExtensionManifest> {
  const raw = await readFile(join(skillDir, "SKILL.md"), "utf-8");
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new Error(`SKILL.md missing YAML frontmatter: ${skillDir}`);
  }
  const { fm, body } = parsed;
  const inferredName =
    fm.name && fm.name.length > 0 ? fm.name : skillDir.split("/").pop() ?? "unnamed-skill";
  const slug = slugify(inferredName);
  const id = reverseDnsId(inferredName, "git.community.skill");

  return {
    $schema: "kernl://extension/v1",
    id,
    slug,
    name: inferredName,
    version: ensureSemver(fm.version),
    type: "skill",
    description: (fm.description ?? "").slice(0, 500) || `(no description) — ${inferredName}`,
    long_description: body.slice(0, 10_000),
    author: fm.author ?? "community",
    license: fm.license ?? "Unknown",
    icon: fm.icon,
    homepage: fm.homepage,
    category: fm.category ?? "community",
    tags: Array.isArray(fm.tags)
      ? (fm.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    permissions: normalizePermissions(fm.permissions),
  } as ExtensionManifest;
}

/**
 * Legacy `assets/plugins/*` use a flat manifest.json that long predates
 * the unified extension format. Map them into a minimal `module`-typed
 * ExtensionManifest so the marketplace and install registry can show them.
 *
 * NOTE: these plugins were originally subprocess agents (JSON-RPC over
 * stdio). Today they install as `module` extensions for visibility; if a
 * future runtime wants to start them as subprocesses, it can read the raw
 * manifest from the install_path.
 */
export async function readPluginAsExtensionManifest(
  pluginDir: string,
): Promise<ExtensionManifest> {
  const raw = await readFile(join(pluginDir, "manifest.json"), "utf-8");
  const parsed = JSON.parse(raw) as PluginManifestRaw;

  const slug = slugify(parsed.name);
  const id = reverseDnsId(parsed.name, "bundled.kernl.plugin");

  return {
    $schema: "kernl://extension/v1",
    id,
    slug,
    name: parsed.displayName ?? parsed.name,
    version: ensureSemver(parsed.version),
    type: "module" as ExtensionType,
    description: parsed.description ?? "",
    author: "Kernl",
    license: "Unknown",
    category: "utility",
    permissions: normalizePermissions(parsed.permissions),
    backend: parsed.entry ? { entry: parsed.entry } : undefined,
  } as ExtensionManifest;
}
