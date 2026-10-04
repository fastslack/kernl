/**
 * The model behind mail triage and analysis.
 *
 * `comms.llm.provider` (a provider slug, e.g. "minimax") pins both to that
 * provider; `comms.llm.model` picks one of its models, empty meaning the model
 * configured for the provider. Unset, mail runs on the kernel's default chain.
 *
 * A pinned call that fails — provider down, out of credit, disconnected —
 * falls back to the default chain, so a bad pick slows mail down instead of
 * stopping it.
 */

import { llm, createPinnedLlmClient, log, type SqliteDb, type KernelConfig } from "@kernl/extension-sdk";

export const MAIL_LLM_PROVIDER_KEY = "comms.llm.provider";
export const MAIL_LLM_MODEL_KEY = "comms.llm.model";

export interface MailChatOptions {
  system: string;
  user: string;
  caller: string;
  maxTokens?: number;
}

function setting(db: SqliteDb, key: string): string {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return (row?.value ?? "").trim();
  } catch {
    return "";
  }
}

export async function mailLlmChat(db: SqliteDb, config: KernelConfig, opts: MailChatOptions): Promise<string> {
  const provider = setting(db, MAIL_LLM_PROVIDER_KEY);
  if (provider) {
    const pinned = createPinnedLlmClient(provider, setting(db, MAIL_LLM_MODEL_KEY), config);
    if (pinned) {
      try {
        return (await pinned.chat(opts)).text;
      } catch (err) {
        log.warn(`${opts.caller}: ${provider} failed, using the default chain — ${err instanceof Error ? err.message.slice(0, 160) : err}`);
      }
    } else {
      log.warn(`${opts.caller}: ${provider} is not connected, using the default chain`);
    }
  }
  return (await llm().chat(opts)).text;
}
