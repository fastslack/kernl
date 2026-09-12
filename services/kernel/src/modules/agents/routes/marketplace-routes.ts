/**
 * Claude Code marketplaces and the extensions an agent can see: listing the
 * plugin repos cloned on the host, adding and refreshing them, and reading
 * back what they expose.
 *
 * Split out of `api-routes.ts` unchanged, together with the prompt-injection
 * scanner that guards it — cloned manifests and markdown are third-party text,
 * and it is the only caller.
 *
 * Note: `core/prompt-sanitizer.ts` exports a differently shaped
 * `INJECTION_PATTERNS` for a different job (sanitizing prompts, not scanning
 * cloned files). They are deliberately not merged.
 */

import { homedir } from "node:os";
import type { KernelHttpServer } from "../../../core/http-server.js";
import type { AgentService } from "../service.js";
import type { EventBus } from "../../../core/event-bus.js";
import { log } from "../../../core/logger.js";



/**
 * Conservative prompt-injection red-flag patterns scanned in cloned marketplace
 * skill/plugin manifests and markdown before they are surfaced to agents.
 */
const INJECTION_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "ignore-previous-instructions", re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i },
  { label: "disregard-instructions", re: /disregard\s+(?:all\s+)?(?:previous|prior|the\s+above)\s+(?:instructions|prompt)/i },
  { label: "override-system-prompt", re: /(?:override|replace|forget)\s+(?:your\s+)?(?:system\s+)?prompt/i },
  { label: "reveal-system-prompt", re: /(?:reveal|print|show|leak)\s+(?:your\s+)?system\s+prompt/i },
  { label: "embedded-tool-call", re: /<\/?(?:tool_call|function_call|antml:invoke)\b/i },
  { label: "embedded-kernel-tool-directive", re: /\b(?:call|invoke|run|execute)\s+(?:the\s+)?(?:tool\s+)?kernel_[a-z_]+/i },
  { label: "exfiltrate-secrets", re: /(?:exfiltrate|leak|send|upload)\b.{0,40}\b(?:api[\s_-]?key|secret|token|password|credential|\.env)/i },
];

/** Bounded recursive walk collecting manifest/markdown text and matching red flags. */
async function scanForPromptInjection(
  rootDir: string,
): Promise<Array<{ file: string; pattern: string; match: string }>> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { resolve: resolvePath, relative } = await import("node:path");
  const flags: Array<{ file: string; pattern: string; match: string }> = [];
  let filesScanned = 0;
  const MAX_FILES = 200;
  const MAX_BYTES = 256 * 1024;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8 || filesScanned >= MAX_FILES) return;
    let ents: import("node:fs").Dirent[];
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const ent of ents) {
      if (filesScanned >= MAX_FILES) return;
      if (ent.name === ".git" || ent.name === "node_modules") continue;
      const full = resolvePath(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!/\.(md|mdx|markdown|json|txt|ya?ml)$/i.test(ent.name)) continue;
      filesScanned++;
      let content: string;
      try {
        content = await readFile(full, { encoding: "utf-8" });
      } catch { continue; }
      if (content.length > MAX_BYTES) content = content.slice(0, MAX_BYTES);
      const rel = relative(rootDir, full);
      for (const { label, re } of INJECTION_PATTERNS) {
        const m = re.exec(content);
        if (m) {
          flags.push({ file: rel, pattern: label, match: m[0].slice(0, 120) });
        }
      }
    }
  }

  await walk(rootDir, 0);
  return flags;
}

export function registerMarketplaceRoutes(
  server: KernelHttpServer,
  service: AgentService,
  events?: EventBus,
): void {

  // ── Marketplaces (Claude Code plugin repos cloned on the host) ───────

  // GET /api/agents/marketplaces — lista marketplaces instalados
  server.get("/api/agents/marketplaces", async (_req, res) => {
    try {
      const { readdir, readFile } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const { execFileSync } = await import("node:child_process");

      const hostHome = process.env.HOST_HOME ?? homedir();
      const marketplacesDir = resolvePath(hostHome, ".claude/plugins/marketplaces");

      if (!existsSync(marketplacesDir)) {
        server.json(res, 200, { marketplaces: [], root: marketplacesDir });
        return;
      }

      const entries = await readdir(marketplacesDir, { withFileTypes: true });
      const items: Array<Record<string, unknown>> = [];

      for (const d of entries) {
        if (!d.isDirectory() || d.name.startsWith(".")) continue;
        const mpPath = resolvePath(marketplacesDir, d.name);
        let gitUrl = "";
        let lastCommit = "";
        try {
          gitUrl = execFileSync("git", ["-C", mpPath, "remote", "get-url", "origin"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        } catch { /* not a git repo */ }
        try {
          lastCommit = execFileSync("git", ["-C", mpPath, "log", "-1", "--format=%ci %h %s"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        } catch { /* no commits */ }

        let pluginCount = 0;
        const pluginsDir = resolvePath(mpPath, "plugins");
        if (existsSync(pluginsDir)) {
          try {
            pluginCount = (await readdir(pluginsDir, { withFileTypes: true }))
              .filter(e => e.isDirectory() && !e.name.startsWith(".")).length;
          } catch { /* ignore */ }
        }

        // Read optional .claude-plugin/marketplace.json for metadata
        let title = d.name;
        let description = "";
        try {
          const mf = JSON.parse(await readFile(resolvePath(mpPath, ".claude-plugin", "marketplace.json"), "utf-8"));
          title = mf.name ?? mf.title ?? d.name;
          description = mf.description ?? "";
        } catch { /* no manifest or invalid */ }

        items.push({
          id: d.name,
          name: d.name,
          title,
          description,
          git_url: gitUrl,
          last_commit: lastCommit,
          plugin_count: pluginCount,
          path: mpPath,
        });
      }

      items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      server.json(res, 200, { marketplaces: items, root: marketplacesDir });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/marketplaces — clone a marketplace from a git URL
  server.post("/api/agents/marketplaces", async (req, res) => {
    try {
      const body = await server.parseBody<{ url: string; name?: string; confirm?: boolean; acknowledged?: boolean }>(req);
      if (!body.url || typeof body.url !== "string") {
        server.json(res, 400, { error: "url required" });
        return;
      }
      // Allowlist: solo https GitHub/GitLab público (sin creds)
      const validProtocol = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\//.test(body.url);
      if (!validProtocol) {
        server.json(res, 400, { error: "Only https URLs from github.com, gitlab.com, codeberg.org, or bitbucket.org are accepted" });
        return;
      }

      // Explicit confirmation gate: cloned skills/plugins are later surfaced into
      // agent contexts (prompt-injection vector), so the caller must acknowledge
      // what is being pulled before we run the clone.
      const confirmed = body.confirm === true || body.acknowledged === true;
      if (!confirmed) {
        server.json(res, 428, {
          error: "confirmation_required",
          message: `Cloning a marketplace downloads third-party skills/plugins that are later exposed to agents. Re-send with \"confirm\": true to confirm cloning: ${body.url}`,
          requires_confirmation: true,
          url: body.url,
        });
        return;
      }

      const { existsSync, mkdirSync } = await import("node:fs");
      const { resolve: resolvePath, basename } = await import("node:path");
      const { execFileSync } = await import("node:child_process");

      const hostHome = process.env.HOST_HOME ?? homedir();
      const marketplacesDir = resolvePath(hostHome, ".claude/plugins/marketplaces");
      mkdirSync(marketplacesDir, { recursive: true });

      // Derive the dir name from the URL when it isn't supplied
      let dirName = body.name?.trim() || "";
      if (!dirName) {
        dirName = basename(body.url).replace(/\.git$/, "");
      }
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(dirName)) {
        server.json(res, 400, { error: "invalid marketplace name" });
        return;
      }

      const targetPath = resolvePath(marketplacesDir, dirName);
      if (existsSync(targetPath)) {
        server.json(res, 409, { error: `A marketplace with that name already exists: ${dirName}` });
        return;
      }

      // Clone (depth=1 for speed, re-fetch if tags turn out to be needed)
      try {
        execFileSync("git", ["clone", "--depth", "1", "--single-branch", body.url, targetPath], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        server.json(res, 500, { error: `git clone failed: ${msg.slice(0, 300)}` });
        return;
      }

      // Validate the minimum structure: must contain `plugins/` or `.claude-plugin/`
      const hasPlugins = existsSync(resolvePath(targetPath, "plugins"));
      const hasManifest = existsSync(resolvePath(targetPath, ".claude-plugin", "marketplace.json"));
      if (!hasPlugins && !hasManifest) {
        try { execFileSync("rm", ["-rf", targetPath]); } catch { /* ignore */ }
        server.json(res, 400, { error: "The repo doesn't look like a Claude Code marketplace (missing plugins/ or .claude-plugin/marketplace.json)" });
        return;
      }

      // Lightweight content scan of cloned manifests/markdown for obvious
      // prompt-injection red flags before this content is surfaced to agents.
      // Conservative: we log + flag, we do NOT block the clone.
      const injectionFlags = await scanForPromptInjection(targetPath);
      if (injectionFlags.length > 0) {
        log.warn(
          `[marketplace] prompt-injection red flags in cloned repo ${dirName} (${body.url}): ` +
            injectionFlags.map(f => `${f.file}: "${f.match}"`).join("; "),
        );
      }

      // Audit event — persisted to agent_event_log (queryable via kernel_audit_logs).
      try {
        service.logEvent({
          event_type: "marketplace",
          event_subtype: injectionFlags.length > 0 ? "clone_flagged" : "clone",
          detail: `Cloned marketplace ${dirName} from ${body.url}` +
            (injectionFlags.length > 0 ? ` — ${injectionFlags.length} injection flag(s)` : ""),
          raw_data: {
            url: body.url,
            name: dirName,
            path: targetPath,
            initiated_via: "POST /api/agents/marketplaces",
            confirmed: true,
            injection_flags: injectionFlags,
            timestamp: new Date().toISOString(),
          },
        });
      } catch (e) {
        log.warn(`[marketplace] failed to write audit event: ${e instanceof Error ? e.message : String(e)}`);
      }
      void events?.emit("data.changed", { module: "agents", action: "marketplace_cloned" });

      server.json(res, 200, {
        success: true,
        name: dirName,
        path: targetPath,
        injection_flags: injectionFlags,
        flagged: injectionFlags.length > 0,
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/marketplaces/:name/refresh — git pull
  server.post("/api/agents/marketplaces/:name/refresh", async (req, res) => {
    try {
      const name = (req as unknown as { params: Record<string, string> }).params?.name;
      if (!name || !/^[A-Za-z0-9_.-]{1,80}$/.test(name)) {
        server.json(res, 400, { error: "invalid name" });
        return;
      }
      const { existsSync } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const { execFileSync } = await import("node:child_process");
      const hostHome = process.env.HOST_HOME ?? homedir();
      const mpPath = resolvePath(hostHome, ".claude/plugins/marketplaces", name);
      if (!existsSync(mpPath)) {
        server.json(res, 404, { error: "marketplace not found" });
        return;
      }
      try {
        const output = execFileSync("git", ["-C", mpPath, "pull", "--ff-only"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        });
        server.json(res, 200, { success: true, output: output.slice(0, 500) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        server.json(res, 500, { error: `git pull failed: ${msg.slice(0, 300)}` });
      }
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // DELETE /api/agents/marketplaces/:name — remove a marketplace
  server.delete("/api/agents/marketplaces/:name", async (req, res) => {
    try {
      const name = (req as unknown as { params: Record<string, string> }).params?.name;
      if (!name || !/^[A-Za-z0-9_.-]{1,80}$/.test(name)) {
        server.json(res, 400, { error: "invalid name" });
        return;
      }
      const { existsSync } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const { execFileSync } = await import("node:child_process");
      const hostHome = process.env.HOST_HOME ?? homedir();
      const mpPath = resolvePath(hostHome, ".claude/plugins/marketplaces", name);
      if (!existsSync(mpPath)) {
        server.json(res, 404, { error: "marketplace not found" });
        return;
      }
      try {
        execFileSync("rm", ["-rf", mpPath]);
        server.json(res, 200, { success: true });
      } catch (err) {
        server.json(res, 500, { error: `rm failed: ${String(err)}` });
      }
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/extensions — inventario de skills/plugins/MCPs del host
  // available to mount inside the claude_code agent sandbox.
  server.get("/api/agents/extensions", async (_req, res) => {
    try {
      const { readdir, readFile, stat } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const { resolve: resolvePath, basename } = await import("node:path");

      const hostHome = process.env.HOST_HOME ?? homedir();
      const skillsDir = resolvePath(hostHome, ".claude/skills");
      const marketplacesDir = resolvePath(hostHome, ".claude/plugins/marketplaces");

      type SkillEntry = { name: string; source: "user" | "plugin"; plugin?: string; marketplace?: string; description: string; path: string };
      type PluginEntry = { name: string; marketplace: string; path: string; description: string; provides: { skills: string[]; agents: string[]; commands: string[] } };
      type McpEntry = { name: string; source: string; type: string; description: string };

      const skills: SkillEntry[] = [];
      const plugins: PluginEntry[] = [];
      const mcps: McpEntry[] = [];

      // Frontmatter parsing delegates to the LRU-cached sanitizer in core.
      // Files that fail the prompt-injection check return null and are
      // silently skipped — the dashboard already treats null as "skip".
      const { parseSkillMdFrontmatter } = await import("../../../core/prompt-sanitizer.js");
      async function parseSkillMd(filePath: string): Promise<{ name?: string; description?: string } | null> {
        return parseSkillMdFrontmatter(filePath);
      }

      // 1) User-level skills: ~/.claude/skills/<name>/SKILL.md
      if (existsSync(skillsDir)) {
        try {
          const dirs = await readdir(skillsDir, { withFileTypes: true });
          for (const d of dirs) {
            if (!d.isDirectory()) continue;
            const skillPath = resolvePath(skillsDir, d.name);
            const mdPath = resolvePath(skillPath, "SKILL.md");
            if (!existsSync(mdPath)) continue;
            const meta = await parseSkillMd(mdPath);
            skills.push({
              name: meta?.name ?? d.name,
              source: "user",
              description: meta?.description ?? "",
              path: skillPath,
            });
          }
        } catch { /* ignore */ }
      }

      // 2) Marketplaces: ~/.claude/plugins/marketplaces/<mp>/plugins/<plugin>/
      if (existsSync(marketplacesDir)) {
        let mpDirs: string[] = [];
        try {
          mpDirs = (await readdir(marketplacesDir, { withFileTypes: true }))
            .filter(d => d.isDirectory() && !d.name.startsWith("."))
            .map(d => d.name);
        } catch { /* ignore */ }

        for (const mpName of mpDirs) {
          const pluginsRoot = resolvePath(marketplacesDir, mpName, "plugins");
          if (!existsSync(pluginsRoot)) continue;
          let pluginDirs: string[] = [];
          try {
            pluginDirs = (await readdir(pluginsRoot, { withFileTypes: true }))
              .filter(d => d.isDirectory() && !d.name.startsWith("."))
              .map(d => d.name);
          } catch { continue; }

          for (const plName of pluginDirs) {
            const pluginPath = resolvePath(pluginsRoot, plName);
            const provides = { skills: [] as string[], agents: [] as string[], commands: [] as string[] };
            let pluginDescription = "";

            // Plugin manifest (opcional): .claude-plugin/plugin.json
            const manifestPath = resolvePath(pluginPath, ".claude-plugin", "plugin.json");
            if (existsSync(manifestPath)) {
              try {
                const mf = JSON.parse(await readFile(manifestPath, "utf-8"));
                pluginDescription = String(mf.description ?? "");
              } catch { /* ignore */ }
            }

            // Skills del plugin
            const pluginSkillsDir = resolvePath(pluginPath, "skills");
            if (existsSync(pluginSkillsDir)) {
              try {
                const ss = await readdir(pluginSkillsDir, { withFileTypes: true });
                for (const s of ss) {
                  if (!s.isDirectory()) continue;
                  const mdPath = resolvePath(pluginSkillsDir, s.name, "SKILL.md");
                  if (!existsSync(mdPath)) continue;
                  const meta = await parseSkillMd(mdPath);
                  const skillName = meta?.name ?? s.name;
                  provides.skills.push(skillName);
                  skills.push({
                    name: skillName,
                    source: "plugin",
                    plugin: plName,
                    marketplace: mpName,
                    description: meta?.description ?? "",
                    path: resolvePath(pluginSkillsDir, s.name),
                  });
                }
              } catch { /* ignore */ }
            }

            // Plugin agents (names only, for now)
            const pluginAgentsDir = resolvePath(pluginPath, "agents");
            if (existsSync(pluginAgentsDir)) {
              try {
                const as = await readdir(pluginAgentsDir, { withFileTypes: true });
                for (const a of as) if (a.isFile() && a.name.endsWith(".md")) {
                  provides.agents.push(a.name.replace(/\.md$/, ""));
                }
              } catch { /* ignore */ }
            }

            // Commands
            const pluginCmdsDir = resolvePath(pluginPath, "commands");
            if (existsSync(pluginCmdsDir)) {
              try {
                const cs = await readdir(pluginCmdsDir, { withFileTypes: true });
                for (const c of cs) if (c.isFile() && c.name.endsWith(".md")) {
                  provides.commands.push(c.name.replace(/\.md$/, ""));
                }
              } catch { /* ignore */ }
            }

            plugins.push({
              name: plName,
              marketplace: mpName,
              path: pluginPath,
              description: pluginDescription,
              provides,
            });
          }
        }
      }

      // 3) MCPs — manual inventory + minimal discovery
      // Kernel-internal: el propio kernl en 3086/mcp
      mcps.push({
        name: "kernl",
        source: "kernel-internal",
        type: "http",
        description: "Local kernel MCP server (every Kernl tool available over HTTP).",
      });

      // MCPs from the user's ~/.claude.json (when present)
      const userClaudeJson = resolvePath(hostHome, ".claude.json");
      if (existsSync(userClaudeJson)) {
        try {
          const cfg = JSON.parse(await readFile(userClaudeJson, "utf-8")) as { mcpServers?: Record<string, { type?: string; command?: string; url?: string; description?: string }> };
          if (cfg.mcpServers && typeof cfg.mcpServers === "object") {
            for (const [name, srv] of Object.entries(cfg.mcpServers)) {
              mcps.push({
                name,
                source: "user-config",
                type: srv.type ?? "stdio",
                description: srv.description ?? `${srv.type ?? "stdio"} MCP from ~/.claude.json`,
              });
            }
          }
        } catch { /* ignore */ }
      }

      // Ordenar
      skills.sort((a, b) => a.name.localeCompare(b.name));
      plugins.sort((a, b) => `${a.marketplace}/${a.name}`.localeCompare(`${b.marketplace}/${b.name}`));
      mcps.sort((a, b) => a.name.localeCompare(b.name));

      // Stats por conveniencia
      void stat; void basename;
      server.json(res, 200, {
        skills, plugins, mcps,
        counts: { skills: skills.length, plugins: plugins.length, mcps: mcps.length },
        home: hostHome,
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
}
