/**
 * How the chat sidebar catalogues conversations: by where they were started
 * (the episode's `source`), with a readable model line instead of a raw
 * provider slug.
 */

export type EpisodeSource = 'office3d' | 'dashboard' | 'mcp' | 'platform' | 'setup';

/** Sidebar order: what the user opens most often first. */
export const SOURCE_ORDER: readonly EpisodeSource[] = ['office3d', 'dashboard', 'mcp', 'platform', 'setup'];

export const SOURCE_LABEL: Record<EpisodeSource, string> = {
  office3d: '3D office',
  dashboard: 'Chats',
  mcp: 'MCP / external',
  platform: 'Messaging',
  setup: 'Setup',
};

export type EpisodeLike = {
  id: string;
  title?: string;
  source?: string;
  source_label?: string;
  llm_provider?: string;
  llm_model?: string;
};

export function sourceOf(ep: EpisodeLike): EpisodeSource {
  return (SOURCE_ORDER as readonly string[]).includes(ep.source ?? '') ? (ep.source as EpisodeSource) : 'dashboard';
}

const PROVIDER_NAMES: Record<string, string> = {
  claude_code: 'Claude Code', 'claude-code': 'Claude Code', anthropic: 'Anthropic', claude: 'Anthropic',
  openai: 'OpenAI', nvidia: 'NVIDIA', ollama: 'Ollama', lmstudio: 'LM Studio', grok: 'Grok',
  gemini: 'Gemini', openrouter: 'OpenRouter', groq: 'Groq', mistral: 'Mistral', deepseek: 'DeepSeek',
};

export function providerName(slug: string | undefined): string {
  if (!slug) return 'Default model';
  return PROVIDER_NAMES[slug.toLowerCase()] ?? slug;
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-20250514" → "Sonnet 4".
 *  Anything that isn't a Claude id is shown as stored. */
export function modelName(id: string | undefined): string {
  if (!id) return '';
  const m = /^claude-([a-z]+)((?:-\d{1,2})*)(?:-\d{8})?$/i.exec(id);
  if (!m) return id;
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  const version = m[2].split('-').filter(Boolean).join('.');
  return version ? `${family} ${version}` : family;
}

/** "Opus 5.5 · Claude Code", or just the provider when no model was pinned. */
export function modelLine(ep: EpisodeLike): string {
  const model = modelName(ep.llm_model);
  const provider = providerName(ep.llm_provider);
  return model ? `${model} · ${provider}` : provider;
}

export type EpisodeGroup<T extends EpisodeLike> = { source: EpisodeSource; label: string; episodes: T[] };

/** Count per source, for the filter chips. Sources with nothing are omitted. */
export function countBySource(episodes: EpisodeLike[]): Array<{ source: EpisodeSource; count: number }> {
  const counts = new Map<EpisodeSource, number>();
  for (const ep of episodes) counts.set(sourceOf(ep), (counts.get(sourceOf(ep)) ?? 0) + 1);
  return SOURCE_ORDER.filter((s) => counts.has(s)).map((source) => ({ source, count: counts.get(source)! }));
}

/** Filters by source and query (title, agent/platform label or model), then
 *  groups in SOURCE_ORDER, keeping the incoming (most recent first) order
 *  inside each group. */
export function groupEpisodes<T extends EpisodeLike>(
  episodes: T[],
  opts: { source?: EpisodeSource | null; query?: string } = {},
): EpisodeGroup<T>[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const bySource = new Map<EpisodeSource, T[]>();
  for (const ep of episodes) {
    const src = sourceOf(ep);
    if (opts.source && src !== opts.source) continue;
    if (q) {
      const hay = `${ep.title ?? ''} ${ep.source_label ?? ''} ${modelLine(ep)}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    const list = bySource.get(src) ?? [];
    list.push(ep);
    bySource.set(src, list);
  }
  return SOURCE_ORDER.filter((s) => bySource.has(s)).map((source) => ({
    source,
    label: SOURCE_LABEL[source],
    episodes: bySource.get(source)!,
  }));
}
