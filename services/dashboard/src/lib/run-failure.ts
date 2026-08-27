/**
 * Turn a failed run's error text into the controls that fix it.
 *
 * The panel already did this once, for exactly one error: the "Re-auth
 * Google" button inside the result card (AgentWorld3D.svelte:8808). The
 * executor's chain failures name their own remedies in prose and both are
 * fields the drawer can now edit, so they get the same treatment.
 *
 * Deliberately a lookup table, not an engine. Two executor signatures today
 * (executor.ts:621 and :623) plus the Google one. When a third appears, add a
 * row.
 *
 * Titles and labels are English, and specifically the same English the rest
 * of the drawer already uses: "cannot run tools" is what RuntimeSection's
 * per-row health chip says (provider-health.ts) about the very providers this
 * failure names, and "Dropped:" is the executor's own word for them. This
 * file and VerdictLine were the last two Spanish surfaces in the drawer, and
 * they happen to be the first two blocks of the overview tab — the first
 * thing anyone reads.
 */

export type RemedyKind =
  | "pick-tool-capable-provider"
  | "switch-executor-claude-code"
  | "configure-provider"
  | "reauth-google"
  | "retry";

export interface Remedy {
  kind: RemedyKind;
  label: string;
}

export interface RunFailure {
  title: string;
  detail: string;
  remedies: Remedy[];
}

const RETRY: Remedy = { kind: "retry", label: "Retry" };

/** Providers the executor dropped, as named in the tool-blocked message. */
function droppedProviders(error: string): string {
  const m = /Dropped:\s*([^.]+)\./.exec(error);
  return m ? m[1].trim() : "";
}

export function analyzeRunFailure(error: string): RunFailure {
  const text = error ?? "";

  if (text.includes("No LLM provider in the chain can run tool calls")) {
    const dropped = droppedProviders(text);
    return {
      title: "No provider in the chain can run tools",
      detail: dropped ? `Dropped: ${dropped}` : text,
      remedies: [
        { kind: "pick-tool-capable-provider", label: "Pick a tool-capable provider" },
        { kind: "switch-executor-claude-code", label: "Switch executor to claude_code" },
        RETRY,
      ],
    };
  }

  if (text.includes("No available LLM provider for chain")) {
    return {
      title: "No provider in the chain is available",
      detail: text,
      remedies: [
        { kind: "configure-provider", label: "Configure providers" },
        RETRY,
      ],
    };
  }

  // Anchor on the tool name and concrete OAuth shapes, not English phrases.
  // "Not authenticated" in client.ts:616 is about Claude Code SDK login, not
  // Google. Matching on generic phrases sends the user down the wrong path.
  // invalid_grant is RFC 6749 OAuth2, not Google-specific, but no other
  // integration emits it today; matters when a second OAuth integration lands.
  if (/kernel_google_auth|invalid_grant|Token (refresh failed|has been expired or revoked)/i.test(text)) {
    return {
      title: "Google token expired",
      detail: text,
      remedies: [
        { kind: "reauth-google", label: "Re-authenticate Google" },
        RETRY,
      ],
    };
  }

  return { title: "The run failed", detail: text, remedies: [RETRY] };
}
