/**
 * Office "home" helpers (migration v36).
 *
 * Every office (flow) has a home directory all its agents inherit as cwd. The
 * home is either a kernel workspace (data/workspaces/{id}/) auto-created with
 * the office, or — once promoted — a git repo on the host. This module owns:
 *
 *   • the on-disk folder convention seeded into a fresh home, and
 *   • the system-prompt block injected when an agent falls back to the home,
 *
 * so the model knows where to work and where to persist office knowledge.
 *
 * Pure + filesystem-only: no DB access. The DB side (column read/write,
 * workspace-row creation) lives in AgentService. Disk seeding is intentionally
 * kept out of createFlow so flow creation stays test-safe (in-memory SQLite);
 * the executor seeds lazily on first use, and set_repo seeds eagerly.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Stable name of the per-office workspace row created for the home. */
export const OFFICE_HOME_WORKSPACE_NAME = "office-home";

interface FlowLike {
  name: string;
  description?: string;
}

/**
 * Ensure the folder convention exists inside `dir`. Idempotent — never
 * overwrites an existing file, only fills in what's missing. Safe to call on
 * every run.
 */
export function seedOfficeHome(dir: string, flow: FlowLike): void {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "decisions"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });

  writeIfMissing(join(dir, "decisions", ".gitkeep"), "");
  writeIfMissing(join(dir, "docs", ".gitkeep"), "");

  writeIfMissing(
    join(dir, "CHARTER.md"),
    `# ${flow.name} — Office Charter\n\n` +
      `${flow.description?.trim() || "_(no description yet)_"}\n\n` +
      `## Mission\n\n` +
      `This is the charter for the **${flow.name}** office. Describe its mission, ` +
      `responsibilities, and success criteria here. Every agent in the office ` +
      `reads it when starting up.\n`,
  );

  writeIfMissing(
    join(dir, "MEMORY.md"),
    `# ${flow.name} — Office Memory\n\n` +
      `Persistent shared memory for the **${flow.name}** office. ` +
      `Agents store important facts here that must survive across runs ` +
      `(conventions, credential locations, project state, gotchas).\n\n` +
      `> One fact per line or section. Keep it concise and accurate.\n`,
  );
}

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content, "utf8");
  }
}

/**
 * System-prompt block telling a claude_code agent it's working inside its
 * office home, plus where to persist knowledge. Injected only when the agent
 * falls back to the office home (no per-agent cwd override).
 */
export function officeHomeGuidance(
  flow: FlowLike,
  homePath: string,
  lang: string,
): string {
  if (lang === "en") {
    return (
      `## Office home\n` +
      `You are working inside the **${flow.name}** office repo at \`${homePath}\`. ` +
      `This is the shared home for every agent in this office.\n` +
      `- Read \`CHARTER.md\` for the office's mission.\n` +
      `- Persist durable knowledge in \`MEMORY.md\`.\n` +
      `- Record important decisions as markdown files under \`decisions/\`.\n` +
      `- Keep working documents under \`docs/\`.\n` +
      `Use your native file tools (Read/Write/Edit) on these paths.`
    );
  }
  return (
    `## Office repo\n` +
    `You are working inside the **${flow.name}** office repo at \`${homePath}\`. ` +
    `It is the shared home of every agent in this office.\n` +
    `- Read \`CHARTER.md\` for the office mission.\n` +
    `- Store persistent knowledge in \`MEMORY.md\`.\n` +
    `- Record important decisions as markdown files under \`decisions/\`.\n` +
    `- Dejá documentos de trabajo en \`docs/\`.\n` +
    `Use your native file tools (Read/Write/Edit) on these paths.`
  );
}
