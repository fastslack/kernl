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
  /** i18n key for the button. Resolved by the component, not here. */
  labelKey: string;
}

export interface RunFailure {
  /** i18n key for the heading. */
  titleKey: string;
  /**
   * The kernel's own error text, or a short phrase built from it. NOT a
   * translation key: this is the machine's words, and translating them would
   * hide the string an operator needs to search for. `droppedKey` covers the
   * one part that is ours.
   */
  detail: string;
  /** i18n key wrapping `detail` when the executor named dropped providers. */
  droppedKey?: string;
  remedies: Remedy[];
}

const RETRY: Remedy = { kind: "retry", labelKey: "agent.failure.retry" };

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
      titleKey: "agent.failure.no_tool_capable",
      detail: dropped || text,
      droppedKey: dropped ? "agent.failure.dropped" : undefined,
      remedies: [
        { kind: "pick-tool-capable-provider", labelKey: "agent.failure.pick_provider" },
        { kind: "switch-executor-claude-code", labelKey: "agent.failure.switch_executor" },
        RETRY,
      ],
    };
  }

  if (text.includes("No available LLM provider for chain")) {
    return {
      titleKey: "agent.failure.no_provider_available",
      detail: text,
      remedies: [
        { kind: "configure-provider", labelKey: "agent.failure.configure_providers" },
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
      titleKey: "agent.failure.google_expired",
      detail: text,
      remedies: [
        { kind: "reauth-google", labelKey: "agent.failure.reauth_google" },
        RETRY,
      ],
    };
  }

  return { titleKey: "agent.failure.generic", detail: text, remedies: [RETRY] };
}
