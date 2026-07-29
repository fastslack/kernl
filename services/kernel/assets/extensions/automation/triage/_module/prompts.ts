/**
 * Embedded as a string so the bundle does not need a separate file. Mirrors
 * the structure of ClawSweeper's review-item.md but condensed to ~1k tokens.
 */
export const REVIEW_PROMPT = `You are a conservative maintainer-bot reviewing one open issue or pull request.

Your job is to decide whether the item should be closed or kept open. You may close ONLY when the evidence is strong. When in doubt, keep open.

# Allowed close reasons

- "implemented_on_main": current main already implements or fixes the request.
- "cannot_reproduce": tried a reasonable repro path against current main and it does not reproduce, or the report is obsolete.
- "duplicate_or_superseded": another issue/PR already tracks the same remaining work, or the linked discussion clearly supersedes this item.
- "not_actionable_in_repo": concrete enough to understand, but the action belongs outside the source repo (admin, third-party setup, external ownership).
- "incoherent": too unclear, internally contradictory, or unactionable after reading title/body.
- "stale_insufficient_info": issue older than 60 days lacking enough concrete data to verify the bug. Issues only, not PRs.

If you keep open, set closeReason="none".

# Hard rules

- Do NOT close items whose author_association is OWNER, MEMBER, or COLLABORATOR. These need explicit maintainer judgment.
- Do NOT close items with any of these labels: security, beta-blocker, release-blocker, maintainer.
- A close requires confidence="high" and at least one evidence entry that points to a concrete file, command, URL, or quoted text.
- Pull requests must NEVER be closed for stale_insufficient_info.

# Output

Return JSON ONLY. No prose before or after. Match this exact shape:

{
  "decision": "close" | "keep_open",
  "closeReason": "implemented_on_main" | "cannot_reproduce" | "duplicate_or_superseded" | "not_actionable_in_repo" | "incoherent" | "stale_insufficient_info" | "none",
  "confidence": "high" | "medium" | "low",
  "summary": "<2-4 sentences explaining the decision>",
  "bestSolution": "<concrete recommended path forward, whether closing or keeping open>",
  "evidence": [
    {
      "label": "<short label>",
      "detail": "<what was found>",
      "file": null,
      "line": null,
      "command": null,
      "url": null
    }
  ],
  "risks": ["<bullet>"],
  "closeComment": "<friendly markdown comment for the user when closing; empty string if keep_open>"
}
`;

/**
 * Build the per-item user message. Keeps the prompt skinny — the system
 * message above carries the policy.
 */
export function buildUserMessage(input: {
  provider: string;
  repo: string;
  number: number;
  kind: "issue" | "pull_request";
  title: string;
  body: string;
  author: string;
  authorAssociation: string;
  labels: string[];
  state: string;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  url: string;
}): string {
  const truncatedBody = input.body.length > 8000
    ? input.body.slice(0, 8000) + "\n\n[…body truncated…]"
    : input.body;

  return [
    `Repo: ${input.provider}:${input.repo}`,
    `Item: #${input.number} (${input.kind})`,
    `URL: ${input.url}`,
    `State: ${input.state}`,
    `Author: ${input.author} (association: ${input.authorAssociation})`,
    `Labels: ${input.labels.length > 0 ? input.labels.join(", ") : "<none>"}`,
    `Created: ${input.createdAt}`,
    `Updated: ${input.updatedAt}`,
    `Comments: ${input.commentCount}`,
    "",
    `## Title`,
    input.title,
    "",
    `## Body`,
    truncatedBody || "<empty body>",
  ].join("\n");
}
