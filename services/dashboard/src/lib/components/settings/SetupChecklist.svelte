<script lang="ts">
  /**
   * SetupChecklist — "what's left to configure" summary.
   *
   * Standalone: fetches its own data on mount so it can be dropped into any
   * page (the /setup wizard's Done step today; /settings?welcome=1 later via
   * a one-line import in settings/+page.svelte).
   *
   * Derivation:
   *   GET /api/settings/catalog       → catalog items (core + extension sections)
   *   GET /api/config/ai/providers    → registry provider rows
   *
   * Items:
   *   LLM provider  → some provider ready / has a key         → ?section=ai
   *   Web search    → SEARXNG_* or BRAVE_* key configured     → ?section=ai
   *   Channels      → some `notifications` item configured    → ?section=channels
   *   Google        → some GOOGLE_* key configured            → ?section=integrations
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n/index.js';

  /** Base path for section links (kept overridable for embedding contexts). */
  export let settingsBase = '/settings';

  interface CatalogItem {
    key: string;
    category: string;
    configured: boolean;
    extension?: string;
  }
  interface ProviderRow {
    slug: string;
    ready: boolean;
    schema?: Array<{ key: string; type: string }>;
    values?: Record<string, string>;
  }
  interface CheckItem {
    id: string;
    labelKey: string;
    done: boolean;
    section: string;
  }

  let loading = true;
  let error = '';
  let items: CheckItem[] = [];

  function providerConfigured(p: ProviderRow): boolean {
    if (p.ready) return true;
    return (p.schema ?? []).some(
      (f) =>
        f.type === 'password' &&
        (p.values?.[f.key] ?? '') !== '' &&
        p.values?.[f.key] !== '(not set)',
    );
  }

  async function jfetch(url: string): Promise<any> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function load(): Promise<void> {
    loading = true;
    error = '';
    const [catRes, provRes] = await Promise.allSettled([
      jfetch('/api/settings/catalog'),
      jfetch('/api/config/ai/providers'),
    ]);

    let all: CatalogItem[] = [];
    if (catRes.status === 'fulfilled') {
      const data = catRes.value as {
        settings?: CatalogItem[];
        extensionSections?: Array<{ fields?: CatalogItem[] }>;
      };
      all = [
        ...(data.settings ?? []),
        ...(data.extensionSections ?? []).flatMap((s) => s.fields ?? []),
      ];
    }

    let providers: ProviderRow[] = [];
    if (provRes.status === 'fulfilled') {
      providers = (provRes.value as { providers?: ProviderRow[] }).providers ?? [];
    }

    if (catRes.status === 'rejected' && provRes.status === 'rejected') {
      error = $t('setup.check_error');
      loading = false;
      return;
    }

    const cfg = (pred: (i: CatalogItem) => boolean) => all.some((i) => i.configured && pred(i));

    items = [
      {
        id: 'llm',
        labelKey: 'welcome.setup_llm_title',
        done: providers.some(providerConfigured),
        section: 'ai',
      },
      {
        id: 'search',
        labelKey: 'setup.check_search',
        done: cfg((i) => i.key.startsWith('SEARXNG') || i.key.startsWith('BRAVE')),
        section: 'ai',
      },
      {
        id: 'channels',
        labelKey: 'setup.check_channels',
        done: cfg((i) => i.category === 'notifications'),
        section: 'channels',
      },
      {
        id: 'google',
        labelKey: 'setup.check_google',
        done: cfg((i) => i.key.startsWith('GOOGLE_')),
        section: 'integrations',
      },
    ];
    loading = false;
  }

  onMount(load);
</script>

<div class="checklist">
  <div class="ck-title">{$t('setup.check_title')}</div>

  {#if loading}
    <div class="ck-loading">{$t('welcome.setup_llm_loading')}</div>
  {:else if error}
    <div class="ck-error">{error}</div>
  {:else}
    <ul>
      {#each items as it (it.id)}
        <li class:done={it.done}>
          <span class="ck-mark" aria-hidden="true">{it.done ? '✓' : '○'}</span>
          <span class="ck-label">{$t(it.labelKey)}</span>
          <a class="ck-link" href={`${settingsBase}?section=${encodeURIComponent(it.section)}`}>
            {it.done ? $t('setup.check_done') : $t('setup.check_open')}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .checklist {
    text-align: left;
    background: var(--surface-1, rgba(255, 255, 255, 0.02));
    border: 1px solid var(--border, #232742);
    border-radius: 10px;
    padding: 14px 16px;
  }
  .ck-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-2, #b8bdd1);
    margin-bottom: 10px;
  }
  .ck-loading,
  .ck-error {
    font-size: 12px;
    color: var(--text-3, #8b91a8);
    padding: 4px 0;
  }
  .ck-error {
    color: #f87171;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--surface-2, rgba(0, 0, 0, 0.15));
    font-size: 13px;
    color: var(--text-2, #d4d8e8);
  }
  .ck-mark {
    width: 18px;
    text-align: center;
    font-weight: 700;
    color: var(--text-3, #6c7191);
    flex-shrink: 0;
  }
  li.done .ck-mark {
    color: #22c55e;
  }
  .ck-label {
    flex: 1;
    min-width: 0;
  }
  li.done .ck-label {
    color: var(--text-3, #8b91a8);
  }
  .ck-link {
    font-size: 12px;
    color: var(--teal, #3dd6c8);
    text-decoration: none;
    white-space: nowrap;
  }
  .ck-link:hover {
    text-decoration: underline;
  }
</style>
