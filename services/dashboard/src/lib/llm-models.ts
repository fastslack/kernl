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
