/**
 * MCP `resources/*` providers exposed by the agents module.
 *
 *   1. `kernel-analysis://` — every published office workspace analysis,
 *      i.e. the `analyses/<date>-<slug>.md` files written by
 *      `kernel_workspace_analysis_save`. Resources are the right primitive
 *      here: they're read-only, content-shaped, and useful both to humans
 *      browsing in MCP Inspector and to agents pulling cross-team context
 *      without burning a tool slot.
 *
 *   2. `kernel-skill://` — Claude Code skills found at `~/.claude/skills/<n>/SKILL.md`
 *      and inside active plugins. Same idea: read-only docs that any MCP
 *      client (not just the Claude CLI) can now load.
 *
 * URI shape:
 *   kernel-analysis://<workspace-id>/<filename.md>
 *   kernel-skill://<source>/<name>            ('user' | 'plugin/<plugin-name>')
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve as resolvePath, join } from "node:path";
import { homedir } from "node:os";
import type { ResourceContent, ResourceListing, ResourceProvider } from "../../core/types.js";
import { log } from "../../core/logger.js";
import { WORKSPACE_ROOT } from "./workspace-constants.js";
import type { WorkspaceServiceLike } from "./advanced-types.js";
import { parseSkillMdFrontmatter, readSkillMd } from "../../core/prompt-sanitizer.js";

const ANALYSIS_SCHEME = "kernel-analysis";
const ANALYSES_SUBDIR = "analyses";

const SKILL_SCHEME = "kernel-skill";

/** Trim a scheme + double-slash off the front and split into segments. */
function parseUri(uri: string, expectedScheme: string): string[] | null {
  const prefix = `${expectedScheme}://`;
  if (!uri.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  if (!rest) return null;
  return rest.split("/").filter(Boolean);
}

/** Cheap inline frontmatter reader — same shape `workspace-tools` already uses. */
function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  if (!md.startsWith("---\n")) return { meta: {}, body: md };
  const end = md.indexOf("\n---", 4);
  if (end === -1) return { meta: {}, body: md };
  const raw = md.slice(4, end);
  const body = md.slice(end + 4).replace(/^\n/, "");
  const meta: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body };
}

// ── Workspace analyses ──────────────────────────────────────

export function createAnalysisResourceProvider(wsService: WorkspaceServiceLike): ResourceProvider {
  return {
    scheme: ANALYSIS_SCHEME,

    async list(): Promise<ResourceListing[]> {
      const out: ResourceListing[] = [];
      const workspaces = wsService.listAll();
      for (const ws of workspaces) {
        const dir = resolvePath(WORKSPACE_ROOT, ws.id, ANALYSES_SUBDIR);
        let entries: Array<{ name: string; isFile: () => boolean }>;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith(".md")) continue;
          const abs = join(dir, e.name);
          let meta: Record<string, string> = {};
          try {
            const raw = await readFile(abs, "utf-8");
            ({ meta } = parseFrontmatter(raw));
          } catch {
            // unreadable file — still expose the URI but with bare metadata
          }
          const title = meta.title || e.name.replace(/\.md$/, "");
          const author = meta.author ? ` · ${meta.author}` : "";
          const tags = meta.tags && meta.tags !== "[]" ? ` · tags: ${meta.tags}` : "";
          out.push({
            uri: `${ANALYSIS_SCHEME}://${ws.id}/${e.name}`,
            name: `[${ws.name}] ${title}`,
            description: `Office analysis${author}${tags}`,
            mimeType: "text/markdown",
          });
        }
      }
      return out;
    },

    async read(uri: string): Promise<ResourceContent | null> {
      const parts = parseUri(uri, ANALYSIS_SCHEME);
      if (!parts || parts.length !== 2) return null;
      const [workspaceId, file] = parts;
      // Sanity: filename must be a flat slug, no traversal.
      if (file.includes("..") || file.includes("/") || file.includes("\\")) return null;
      const ws = wsService.get(workspaceId);
      if (!ws) return null;
      const abs = resolvePath(WORKSPACE_ROOT, ws.id, ANALYSES_SUBDIR, file);
      // Belt and suspenders: ensure the resolved path is still inside the
      // workspace's analyses directory.
      const dir = resolvePath(WORKSPACE_ROOT, ws.id, ANALYSES_SUBDIR);
      if (!abs.startsWith(`${dir}/`) && abs !== dir) return null;
      try {
        await stat(abs);
        const text = await readFile(abs, "utf-8");
        return { uri, mimeType: "text/markdown", text };
      } catch {
        return null;
      }
    },
  };
}

// ── Claude Code skills ──────────────────────────────────────

interface SkillRef {
  source: "user" | "plugin";
  plugin?: string;
  name: string;
  filePath: string;
}

/** Walks ~/.claude/skills and active plugins to find every SKILL.md. */
async function collectSkills(claudeHome: string): Promise<SkillRef[]> {
  const skills: SkillRef[] = [];

  // 1. User-level
  const userDir = resolvePath(claudeHome, "skills");
  if (existsSync(userDir)) {
    try {
      const dirs = await readdir(userDir, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const file = resolvePath(userDir, d.name, "SKILL.md");
        if (!existsSync(file)) continue;
        skills.push({ source: "user", name: d.name, filePath: file });
      }
    } catch (err) {
      log.warn(`agents/resources: failed to scan ${userDir}`, err);
    }
  }

  // 2. Plugin-level — flat scan, agnostic to marketplace layout
  const pluginsRoot = resolvePath(claudeHome, "plugins");
  if (existsSync(pluginsRoot)) {
    try {
      // Two layouts seen in the wild: ~/.claude/plugins/<plugin>/skills/<name>/SKILL.md
      // and ~/.claude/plugins/<marketplace>/<plugin>/skills/<name>/SKILL.md.
      // Walk one level, then check both.
      const tier1 = await readdir(pluginsRoot, { withFileTypes: true });
      for (const a of tier1) {
        if (!a.isDirectory()) continue;
        const aPath = resolvePath(pluginsRoot, a.name);
        const aSkillsDir = resolvePath(aPath, "skills");
        if (existsSync(aSkillsDir)) {
          await collectPluginSkills(aSkillsDir, a.name, skills);
          continue;
        }
        // tier1 is a marketplace — descend.
        let tier2: Array<{ name: string; isDirectory: () => boolean }>;
        try {
          tier2 = await readdir(aPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const b of tier2) {
          if (!b.isDirectory()) continue;
          const bSkillsDir = resolvePath(aPath, b.name, "skills");
          if (existsSync(bSkillsDir)) {
            await collectPluginSkills(bSkillsDir, `${a.name}/${b.name}`, skills);
          }
        }
      }
    } catch (err) {
      log.warn(`agents/resources: failed to scan ${pluginsRoot}`, err);
    }
  }

  return skills;
}

async function collectPluginSkills(skillsDir: string, plugin: string, out: SkillRef[]): Promise<void> {
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const s of entries) {
      if (!s.isDirectory()) continue;
      const file = resolvePath(skillsDir, s.name, "SKILL.md");
      if (!existsSync(file)) continue;
      out.push({ source: "plugin", plugin, name: s.name, filePath: file });
    }
  } catch (err) {
    log.warn(`agents/resources: failed to scan ${skillsDir}`, err);
  }
}

function buildSkillUri(ref: SkillRef): string {
  if (ref.source === "user") return `${SKILL_SCHEME}://user/${ref.name}`;
  return `${SKILL_SCHEME}://plugin/${ref.plugin}/${ref.name}`;
}

export function createSkillResourceProvider(): ResourceProvider {
  // Honor HOST_HOME so the kernel inside docker still finds the operator's
  // ~/.claude even though the container's $HOME is /home/bun.
  const hostHome = process.env.HOST_HOME || homedir();
  const claudeHome = resolvePath(hostHome, ".claude");

  return {
    scheme: SKILL_SCHEME,

    async list(): Promise<ResourceListing[]> {
      const refs = await collectSkills(claudeHome);
      const out: ResourceListing[] = [];
      for (const ref of refs) {
        const meta = parseSkillMdFrontmatter(ref.filePath) ?? {};
        const label = meta.name || ref.name;
        const desc = meta.description || `Claude Code skill (${ref.source}${ref.plugin ? ` · ${ref.plugin}` : ""})`;
        out.push({
          uri: buildSkillUri(ref),
          name: label,
          description: desc,
          mimeType: "text/markdown",
        });
      }
      return out;
    },

    async read(uri: string): Promise<ResourceContent | null> {
      const parts = parseUri(uri, SKILL_SCHEME);
      if (!parts || parts.length < 2) return null;
      const refs = await collectSkills(claudeHome);
      const target = refs.find((r) => buildSkillUri(r) === uri);
      if (!target) return null;
      // readSkillMd applies prompt-injection sanitization + caching for free.
      const text = readSkillMd(target.filePath);
      if (text === null) return null;
      return { uri, mimeType: "text/markdown", text };
    },
  };
}
