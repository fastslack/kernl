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
