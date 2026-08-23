/**
 * Normalise `/api/llm-providers/<slug>/models`.
 *
 * The endpoint returns entries as `{ id, traits }` objects, but three call
 * sites cast the array to `string[]` and interpolated it straight into the
 * markup — so every discovered model rendered as the literal text
 * "[object Object]" in the picker. Strings are still accepted because older
 * providers (and the tests) return the bare id.
 */
export function modelIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const m of raw) {
    if (typeof m === "string") {
      if (m) out.push(m);
      continue;
    }
    if (m && typeof m === "object") {
      const id = (m as { id?: unknown; name?: unknown }).id ?? (m as { name?: unknown }).name;
      if (typeof id === "string" && id) out.push(id);
    }
  }
  return out;
}

/**
 * The models worth offering, and the one to pick when there is no choice.
 *
 * A local runtime reports which models are held in memory. LM Studio listed
 * all thirteen it had downloaded — OCR engines among them — and picking an
 * unloaded one stalls for as long as it takes to page gigabytes off disk,
 * which reads as a hang. So when the runtime tells us what is loaded, that is
 * the list; when it cannot (every cloud provider), nothing changes.
 *
 * `auto` is set only when exactly one model is loaded: with one there is no
 * decision to make, and asking someone to confirm it is friction. With two or
 * more the choice is theirs.
 */
export function selectableModels(raw: unknown): { ids: string[]; auto: string | null } {
  const all = modelIds(raw);
  if (!Array.isArray(raw)) return { ids: all, auto: null };

  const loaded: string[] = [];
  let runtimeKnows = false;
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const entry = m as { id?: unknown; loaded?: unknown };
    if (typeof entry.loaded !== "boolean") continue;
    runtimeKnows = true;
    if (entry.loaded && typeof entry.id === "string" && entry.id) loaded.push(entry.id);
  }

  // Runtime cannot say, or says none are loaded: fall back to the full list
  // rather than showing an empty picker someone cannot escape from.
  if (!runtimeKnows || loaded.length === 0) return { ids: all, auto: null };
  return { ids: loaded, auto: loaded.length === 1 ? loaded[0] : null };
}

/**
 * Registry slug → the key `/api/config/ai/test` files its result under.
 *
 * Two naming conventions meet here and neither is going away: the registry and
 * `/api/llm-providers` use kebab-case slugs (`claude-code`), while stored agent
 * rows, `aiConfig` and the chat adapters use snake_case (`claude_code`).
 * Anthropic adds a third name — the registry calls it `claude`, the probe
 * reports it as `anthropic`.
 *
 * Getting this wrong is silent: `testResults[slug]` misses, the settings model
 * dropdown comes back empty, and the field degrades to a free-text box. That is
 * exactly what `claude_code` did — the provider the install was actually using
 * had no model list at all.
 */
export function providerTestId(slug: string): string {
  const s = (slug ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s === "claude" || s === "anthropic") return "anthropic";
  // Everything else differs only in the separator.
  return s.replace(/_/g, "-");
}

/**
 * Like `modelIds`, but keeps the capability tags the kernel already computed.
 *
 * `/api/llm-providers/<slug>/models` answers `{ id, traits }` per model —
 * vision / reasoning / fast / long-context, worked out in `model-traits.ts`.
 * Every consumer used to run it through `modelIds()` and throw the tags away,
 * so the pickers rendered bare ids and the person choosing had nothing to go on
 * but the name.
 */
export function modelEntries(raw: unknown): Array<{ id: string; traits?: Record<string, boolean> }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; traits?: Record<string, boolean> }> = [];
  for (const m of raw) {
    if (typeof m === "string") {
      if (m) out.push({ id: m });
      continue;
    }
    if (m && typeof m === "object") {
      const id = (m as { id?: unknown; name?: unknown }).id ?? (m as { name?: unknown }).name;
      if (typeof id !== "string" || !id) continue;
      const traits = (m as { traits?: unknown }).traits;
      out.push(traits && typeof traits === "object"
        ? { id, traits: traits as Record<string, boolean> }
        : { id });
    }
  }
  return out;
}
