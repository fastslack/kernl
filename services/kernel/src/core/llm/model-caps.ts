/**
 * Can this model call tools? Per (provider, model), from three sources.
 *
 * The Chief and every agent on the kernel's executor run a tool loop, and so
 * does the chat. A provider being tool-capable says nothing about each of its
 * models: NVIDIA lists 68, OpenAI 83, and some of them (completion-only
 * `babbage-002`, `chat-latest`, deep-research, video models) can never return
 * a tool call. Pickers that need tools filter on this; nothing here is a
 * guess presented as fact — no evidence stays `undefined` ("not verified").
 *
 * Sources, strongest first:
 *   1. observed  — this Kernl saw the model return a tool call (yes), or the
 *                  provider reject a request for its tools (no). Recorded from
 *                  every instrumented call (call-log.ts).
 *   2. litellm   — `supports_function_calling` in LiteLLM's model table, the
 *                  same download that prices models (model-prices.ts).
 *   3. rule      — the few families known by name never to take tools.
 */

import type { SqliteDb } from "../db/sqlite.js";

export type ToolSupport = boolean | undefined;

export function ensureModelCapsTable(db: SqliteDb): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS llm_model_caps (\n" +
      "  provider   TEXT NOT NULL,\n" +
      "  model      TEXT NOT NULL,\n" +
      "  tools      INTEGER NOT NULL,\n" +
      "  source     TEXT NOT NULL,\n" +
      "  updated_at TEXT NOT NULL,\n" +
      "  PRIMARY KEY (provider, model)\n" +
      ")",
  );
}

/** What this Kernl saw. Always wins over the table and the rules. */
export function observeToolSupport(db: SqliteDb, provider: string, model: string, tools: boolean): void {
  if (!provider || !model) return;
  ensureModelCapsTable(db);
  db.prepare(
    "INSERT INTO llm_model_caps (provider, model, tools, source, updated_at) VALUES (?, ?, ?, 'observed', ?) " +
      "ON CONFLICT (provider, model) DO UPDATE SET tools = excluded.tools, source = 'observed', updated_at = excluded.updated_at",
  ).run(provider, model.toLowerCase(), tools ? 1 : 0, new Date().toISOString());
}

/** LiteLLM's verdicts for one provider. Never overwrites an observation. */
export function storeLiteLlmToolSupport(db: SqliteDb, provider: string, verdicts: Map<string, boolean>): void {
  ensureModelCapsTable(db);
  const now = new Date().toISOString();
  const up = db.prepare(
    "INSERT INTO llm_model_caps (provider, model, tools, source, updated_at) VALUES (?, ?, ?, 'litellm', ?) " +
      "ON CONFLICT (provider, model) DO UPDATE SET tools = excluded.tools, updated_at = excluded.updated_at " +
      "WHERE llm_model_caps.source <> 'observed'",
  );
  db.transaction(() => {
    for (const [model, tools] of verdicts) up.run(provider, model.toLowerCase(), tools ? 1 : 0, now);
  })();
}

/**
 * Families that never take tools, by name. Deliberately short: a model
 * missing from here is "not verified", not "yes".
 */
export function toolsByRule(modelId: string): ToolSupport {
  const id = modelId.toLowerCase();
  if (/^(babbage|davinci)(-|$)/.test(id)) return false;                 // completion-only
  if (/(^|\/)gpt-3\.5-turbo-instruct/.test(id)) return false;          // completions endpoint
  if (/(^|\/)(chatgpt-4o-latest|chat-latest)$/.test(id)) return false; // ChatGPT alias, no function calling
  if (/deep-research/.test(id)) return false;                          // research models reject custom tools
  if (/(^|\/)sora(-|$)/.test(id)) return false;                        // video
  if (/(^|\/)o1-(mini|preview)/.test(id)) return false;                // shipped without tools
  return undefined;
}

/** The verdict per model for `provider`: observed > litellm > rule > unknown. */
export function toolSupportFor(db: SqliteDb | null, provider: string, modelIds: string[]): Map<string, ToolSupport> {
  const known = new Map<string, boolean>();
  if (db) {
    try {
      ensureModelCapsTable(db);
      const rows = db
        .prepare("SELECT model, tools FROM llm_model_caps WHERE provider = ?")
        .all(provider) as Array<{ model: string; tools: number }>;
      for (const r of rows) known.set(r.model, r.tools === 1);
    } catch {
      // No table, locked DB: the rules still answer.
    }
  }
  const out = new Map<string, ToolSupport>();
  for (const id of modelIds) {
    const stored = known.get(id.toLowerCase());
    out.set(id, stored !== undefined ? stored : toolsByRule(id));
  }
  return out;
}

/**
 * Did this failed request fail BECAUSE the model takes no tools? Only the
 * providers' own wording counts; a 400 for anything else says nothing.
 */
export function isToolsUnsupportedError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /(tool|function)[ _-]?(call(ing|s)?|use|choice)?[^.]{0,40}(not supported|unsupported|is not enabled|are not supported|does not support)/.test(m) ||
    /(does not|doesn't) support (tools|tool use|tool calling|function calling|functions)/.test(m) ||
    /tool use is not supported/.test(m) ||
    // vLLM-served models (NVIDIA NIM) started without tool parsing.
    /tool choice requires --enable-auto-tool-choice/.test(m)
  );
}
