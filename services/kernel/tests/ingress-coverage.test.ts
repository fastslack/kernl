import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const KERNEL = resolve(import.meta.dir, "..");

/** Tools whose results carry third-party text: each handler must call wrapExternal. */
const INGRESS: Array<[file: string, tools: string[]]> = [
  ["assets/extensions/people/comms/_module/agent-tools.ts", ["kernel_email_search", "kernel_email_fetch", "kernel_email_thread", "kernel_email_inbox_recent"]],
  ["assets/extensions/people/comms/_module/tools.ts", ["kernel_comms_get", "kernel_comms_list", "kernel_comms_thread", "kernel_comms_search_inbox", "kernel_comms_fetch_email"]],
  ["assets/extensions/integration/rss-registry/_module/tools.ts", ["kernel_rss_items", "kernel_rss_fetch", "kernel_rss_get", "kernel_rss_search"]],
  ["assets/extensions/integration/google-sync/_module/agent-tools.ts", ["kernel_google_email_search"]],
  ["assets/extensions/integration/google-sync/_module/tools.ts", ["kernel_google_emails_search"]],
  ["assets/extensions/people/comms/_module/email-analysis-tools.ts", ["kernel_email_analyze", "kernel_email_pending"]],
  ["assets/extensions/channels/irc/_module/tools.ts", ["kernel_irc_history"]],
  ["assets/extensions/crm/twitter/_module/tools.ts", ["kernel_twitter_list_mentions"]],
  ["assets/extensions/social/reddit/_module/tools.ts", ["kernel_reddit_fetch_subreddit"]],
  ["../../../kernl-pro/assets/extensions/people/social/_module/tools.ts", ["kernel_social_timeline", "kernel_social_search"]],
  ["../../../kernl-pro/assets/extensions/ai/web-intel/_module/tools.ts", ["kernel_webintel_fetch_url"]],
  ["../../../kernl-pro/assets/extensions/system/mesh/_module/index.ts", ["kernel_mesh_list_remote_tools"]],
];

/** File-local helpers whose bodies call wrapExternal (verified below). */
const WRAPPING_HELPERS = ["extComm(", "wrapSubject(", "wrapBody(", "wrapPreview(", "commSummary(", "fmtSuggestion("];

function handlerBody(src: string, tool: string): string {
  const start = src.indexOf(`"${tool}"`);
  if (start < 0) throw new Error(`${tool} not found`);
  const next = src.slice(start + tool.length + 2).search(/name:\s*"kernel_/);
  return next < 0 ? src.slice(start) : src.slice(start, start + tool.length + 2 + next);
}

describe("ingress coverage", () => {
  for (const [file, tools] of INGRESS) {
    const path = resolve(KERNEL, file);
    if (!existsSync(path)) continue; // kernl-pro ausente en CI público
    const src = readFileSync(path, "utf8");
    for (const tool of tools) {
      it(`${tool} wraps third-party text`, () => {
        const body = handlerBody(src, tool);
        const direct = body.includes("wrapExternal(");
        const helper = WRAPPING_HELPERS.find((h) => body.includes(h));
        if (!direct && helper) {
          const def = src.match(new RegExp(`function ${helper.slice(0, -1)}\\([\\s\\S]*?\\n}\\n`));
          expect(def?.[0] ?? "").toContain("wrapExternal(");
        } else {
          expect(direct).toBe(true);
        }
      });
    }
  }
});
