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

const RETRY: Remedy = { kind: "retry", label: "Reintentar" };

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
      title: "Ningún provider de la cadena puede ejecutar tools",
      detail: dropped ? `Descartado: ${dropped}` : text,
      remedies: [
        { kind: "pick-tool-capable-provider", label: "Elegir provider con tools" },
        { kind: "switch-executor-claude-code", label: "Cambiar executor a claude_code" },
        RETRY,
      ],
    };
  }

  if (text.includes("No available LLM provider for chain")) {
    return {
      title: "Ningún provider de la cadena está disponible",
      detail: text,
      remedies: [
        { kind: "configure-provider", label: "Configurar providers" },
        RETRY,
      ],
    };
  }

  // invalid_grant is a generic OAuth2 code (RFC 6749), not Google-specific.
  // Harmless today since no other integration emits it, but this ambiguity
  // matters when a second OAuth integration lands.
  if (/kernel_google_auth|invalid_grant|Authentication expired|Not authenticated|Token (refresh failed|has been expired or revoked)/i.test(text)) {
    return {
      title: "El token de Google venció",
      detail: text,
      remedies: [
        { kind: "reauth-google", label: "Re-autenticar Google" },
        RETRY,
      ],
    };
  }

  return { title: "El run falló", detail: text, remedies: [RETRY] };
}
