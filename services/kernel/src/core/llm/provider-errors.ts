/**
 * One vocabulary for "why did this provider fail".
 *
 * The dashboard turns the code into a sentence and a way out ("generate
 * another key", "use the fast model"). The raw provider message travels along
 * as `detail`, shown only on request — it is the evidence, not the explanation.
 * Order matters: a Claude Code CLI failure says both "401" and "/login", and
 * what the user must do is sign in, not replace a key.
 */

export type ProviderErrorCode =
  | "auth" | "quota" | "model" | "timeout" | "no_tools"
  | "unreachable" | "no_session" | "network" | "unknown";

export interface ProviderError { code: ProviderErrorCode; detail: string }

const RULES: Array<[RegExp, ProviderErrorCode]> = [
  // Scoped to the CLI's own wording: a cloud 401 saying "not authenticated"
  // needs a new key, not a sign-in.
  [/not logged in|\/login\b|no active session|claude-code-sdk/i, "no_session"],
  [/ACCESS_TOKEN_TYPE_UNSUPPORTED|\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ -]?api[_ -]?key|incorrect api key|authentication/i, "auth"],
  [/\b(402|429)\b|insufficient[_ ]?(quota|balance)|rate[_ ]?limit|exceeded your current quota|credit balance|quota/i, "quota"],
  [/\b404\b|model_not_found|invalid model identifier|model[^\n]{0,60}(not found|does not exist|not available)/i, "model"],
  [/timed? ?out|did not respond|no response in|TimeoutError|AbortError/i, "timeout"],
];

const REFUSED = /ECONNREFUSED|EHOSTUNREACH|Unable to connect|ConnectionRefused|fetch failed/i;
const NETWORK = /ENOTFOUND|getaddrinfo|ECONNRESET|ETIMEDOUT|socket|network|TLS|certificate/i;

export function classifyProviderError(err: unknown, opts: { local?: boolean } = {}): ProviderError {
  const detail = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const text = `${name} ${detail}`;
  for (const [re, code] of RULES) {
    if (re.test(text)) return { code, detail };
  }
  if (REFUSED.test(text)) return { code: opts.local ? "unreachable" : "network", detail };
  if (NETWORK.test(text)) return { code: "network", detail };
  return { code: "unknown", detail };
}
