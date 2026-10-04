/**
 * The published form of a Kernl bug: a GitHub issue that follows the repo's
 * own bug template (.github/ISSUE_TEMPLATE/bug_report.md), and the few REST
 * calls that create it and keep it current.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KernlBug, KernlBugService } from "./kernl-bugs-service.js";

/** Kernl's version, from the kernel package.json next to the running process. */
export function kernlVersion(): string {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  for (const p of [join(process.cwd(), "package.json"), join(process.cwd(), "services/kernel/package.json")]) {
    try { return String(JSON.parse(readFileSync(p, "utf8")).version ?? "unknown"); } catch { /* next */ }
  }
  return "unknown";
}

const fence = (s: string) => "```\n" + s.replace(/```/g, "ˋˋˋ") + "\n```";

export function renderIssue(bug: KernlBug, env: { version: string }): { title: string; body: string; labels: string[] } {
  const ctx = bug.context as Record<string, unknown>;
  const error = String(ctx.error ?? "");
  const logs = JSON.stringify({ error, last_steps: ctx.last_steps ?? [] }, null, 2);
  const body = [
    "## Description",
    bug.title,
    bug.area ? `\n**Area:** \`${bug.area}\`` : "",
    bug.diagnosis ? `\n${bug.diagnosis}` : "",
    "",
    "## Steps to Reproduce",
    bug.repro || "Seen in a live agent run; see Logs.",
    "",
    "## Expected Behavior",
    "The run completes, or fails with an error the operator can act on.",
    "",
    "## Actual Behavior",
    error || bug.title,
    "",
    "## Environment",
    `- Kernl: ${env.version}`,
    `- Executor: ${String(ctx.executor ?? "unknown")}`,
    `- Model: ${String(ctx.model ?? "unknown")}`,
    "- Docker: yes",
    "",
    "## Logs",
    fence(logs),
    "",
    "---",
    `Reported by the Kernl chief · occurrences: ${bug.occurrences} · first seen ${bug.created_at} · last seen ${bug.last_seen_at}`,
  ].filter((l) => l !== undefined).join("\n");
  return { title: `[Bug] ${bug.title}`, body, labels: ["bug", "reported-by-chief"] };
}

export class GitHubIssues {
  constructor(
    private readonly token: string,
    private readonly repo: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async call(path: string, init: { method: string; body?: unknown }): Promise<Record<string, unknown>> {
    if (!this.token) throw new Error("No GitHub token configured — add one in the chief's office, Kernl tab.");
    const res = await this.fetchFn(`https://api.github.com/repos/${this.repo}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return json;
    const detail = String(json.message ?? "");
    if (res.status === 401) throw new Error("GitHub rejected the token (401). Paste a new one.");
    if (res.status === 403) throw new Error(`The token cannot write issues in ${this.repo} (403). It needs Issues: read & write.`);
    if (res.status === 404) throw new Error(`Repo ${this.repo} not found or not visible to the token (404).`);
    if (res.status === 410) throw new Error(`Issues are disabled in ${this.repo} (410).`);
    if (res.status === 422) throw new Error(`GitHub refused the issue (422): ${detail}`);
    throw new Error(`GitHub error ${res.status}: ${detail}`);
  }

  async createIssue(issue: { title: string; body: string; labels: string[] }): Promise<{ url: string; number: number }> {
    const r = await this.call("/issues", { method: "POST", body: issue });
    return { url: String(r.html_url ?? ""), number: Number(r.number ?? 0) };
  }

  async addComment(issueUrl: string, body: string): Promise<void> {
    const n = /\/issues\/(\d+)/.exec(issueUrl)?.[1];
    if (!n) throw new Error(`Not an issue url: ${issueUrl}`);
    await this.call(`/issues/${n}/comments`, { method: "POST", body: { body } });
  }

  async checkAccess(): Promise<void> {
    await this.call("", { method: "GET" });
  }
}


/** A published bug was seen again: say so on its issue. Never throws. */
export async function commentOnRepeat(bugs: KernlBugService, bug: KernlBug, fetchFn: typeof fetch = fetch): Promise<void> {
  if (bug.status !== "published" || !bug.issue_url) return;
  try {
    const gh = new GitHubIssues(bugs.getToken(), bugs.getSettings().repo, fetchFn);
    await gh.addComment(bug.issue_url, `Seen again — occurrences: ${bug.occurrences} (last ${bug.last_seen_at}${bug.run_id ? `, run ${bug.run_id}` : ""}).`);
  } catch { /* the local count is already up to date */ }
}
