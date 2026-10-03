/**
 * Every LLM provider with its model list, as the model pickers want them.
 *
 * Same two calls the chat's picker makes (routes/chat/+page.svelte): the
 * status list, then each ready provider's models in parallel. Offline
 * providers are kept — dimmed, with their reason — because what could be
 * configured is exactly what someone reading a chain failure needs to see.
 * Never throws: a failed call yields the providers it got, without models.
 */
import { modelEntries } from '$lib/llm-models.js';
import type { ModelEntry } from '$lib/model-catalog.js';
import type { ProviderStatus } from '$lib/provider-health.js';

export type PickerProvider = ProviderStatus & { models?: ModelEntry[] };

export async function loadPickerProviders(): Promise<PickerProvider[]> {
  try {
    const r = await fetch('/api/llm-providers');
    if (!r.ok) return [];
    const body = await r.json();
    const list = (body.providers ?? []) as ProviderStatus[];
    return await Promise.all(
      list.map(async (p) => {
        if (!p.ready) return { ...p, models: [] };
        try {
          const mr = await fetch(`/api/llm-providers/${encodeURIComponent(p.slug)}/models`);
          if (!mr.ok) return { ...p, models: [] };
          const mb = await mr.json();
          return { ...p, models: modelEntries(mb.models) as ModelEntry[] };
        } catch {
          return { ...p, models: [] };
        }
      }),
    );
  } catch {
    return [];
  }
}
