<!--
  SkillInfo — the "i" next to a skill in the SKILLS tab. Hovering (or
  focusing) it opens a card with what the skill is for, in full: its
  description, who ships it, its tags, and why it was recommended for this
  agent. The rows themselves only have room for the match words, which say
  why a skill scored, not what it does.

  Catalogue skills carry their description only in the catalogue, and the
  whole catalogue is ~770 entries with a ~10 KB playbook each — so the card
  asks for the one skill it shows, the first time it is opened, and keeps the
  answer for the session. Installed skills pass their manifest in and never
  fetch.

  The card is moved to <body> and placed `position: fixed` against the icon.
  Left inside the drawer it was invisible: the panel's `backdrop-filter`
  makes it the containing block for fixed descendants, so viewport
  coordinates landed off-panel and `overflow: hidden` clipped the card.
-->
<script context="module" lang="ts">
  export type SkillManifest = {
    name?: string; description?: string; version?: string; author?: string;
    category?: string; tags?: string[]; icon?: string;
  };
  const cache = new Map<string, Promise<SkillManifest | null>>();
  /** Translations already paid for this session, by source text. */
  const translations = new Map<string, { text: string; model: string }>();

  function lookup(slug: string): Promise<SkillManifest | null> {
    let p = cache.get(slug);
    if (!p) {
      p = fetch(`/api/marketplace/catalog?type=skill&q=${encodeURIComponent(slug)}&limit=20`)
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((b) => {
          const hit = ((b.items ?? []) as Array<{ slug: string; manifest?: SkillManifest }>).find((i) => i.slug === slug);
          return hit?.manifest ?? null;
        })
        .catch(() => {
          cache.delete(slug); // a network blip should not stick for the session
          return null;
        });
      cache.set(slug, p);
    }
    return p;
  }
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { refreshPrices } from '$lib/model-prices.js';

  export let slug: string;
  /** The installed row's manifest, when there is one — then nothing is fetched. */
  export let manifest: SkillManifest | null = null;
  export let installed = false;
  /** Words from the agent's prompt that matched — why it was recommended. */
  export let matches: string[] = [];
  export let score: number | null = null;

  let open = false;
  let loading = false;
  let data: SkillManifest | null = manifest;
  let btn: HTMLButtonElement;
  let card: HTMLDivElement;
  let pos = { top: 0, left: 0, above: false };
  const cardId = `skill-info-${Math.random().toString(36).slice(2, 9)}`;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Translation (cheapest external model, POST /api/llm/translate) ──
  let showTranslated = false;
  let translating = false;
  let translateError = '';
  /** The kernel had no usable priced model (503): a price refresh may fix it. */
  let needsPrices = false;
  let refreshing = false;

  async function refreshAndRetry(): Promise<void> {
    refreshing = true;
    try {
      await refreshPrices();
      await translate();
    } catch (e) {
      translateError = (e as Error).message;
    } finally {
      refreshing = false;
    }
  }
  $: source = data?.description ?? '';
  $: translated = source ? translations.get(source) ?? null : null;

  async function translate(): Promise<void> {
    if (!source || translating) return;
    if (translated) { showTranslated = !showTranslated; return; }
    translating = true;
    translateError = '';
    needsPrices = false;
    try {
      const r = await fetch('/api/llm/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: source, to: 'es' }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) {
        needsPrices = r.status === 503;
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      translations.set(source, { text: String(b.text ?? ''), model: String(b.model ?? '') });
      translated = translations.get(source) ?? null;
      showTranslated = true;
    } catch (e) {
      translateError = (e as Error).message;
    } finally {
      translating = false;
      await place();
    }
  }

  $: if (manifest) data = manifest;

  async function show(): Promise<void> {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (open) return;
    open = true;
    if (!data) {
      loading = true;
      data = await lookup(slug);
      loading = false;
    }
    await place();
  }

  /** Small grace period so the pointer can travel from the icon into the card. */
  function hideSoon(): void {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { open = false; }, 120);
  }

  async function place(): Promise<void> {
    await tick();
    if (!btn || !card) return;
    const r = btn.getBoundingClientRect();
    const w = card.offsetWidth, h = card.offsetHeight;
    const margin = 8;
    const left = Math.min(Math.max(margin, r.left - 12), window.innerWidth - w - margin);
    const above = r.bottom + 6 + h > window.innerHeight - margin && r.top - 6 - h > margin;
    pos = { top: above ? r.top - 6 - h : r.bottom + 6, left, above };
  }

  /** Re-parent the node to <body> for as long as it lives. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && open) { open = false; btn?.focus(); }
  }
</script>

<svelte:window on:keydown={onKey} on:scroll|capture={() => open && place()} on:resize={() => open && place()} />

<button
  bind:this={btn}
  class="si-btn"
  class:si-on={open}
  type="button"
  aria-label={$t('agent.skills.info_aria', { slug })}
  aria-describedby={open ? cardId : undefined}
  aria-expanded={open}
  on:mouseenter={show}
  on:mouseleave={hideSoon}
  on:focus={show}
  on:blur={hideSoon}
  on:click|stopPropagation={() => (open ? (open = false) : show())}
>i</button>

{#if open}
  <div
    bind:this={card}
    use:portal
    id={cardId}
    class="si-card"
    class:si-above={pos.above}
    role="tooltip"
    style="top:{pos.top}px;left:{pos.left}px"
    on:mouseenter={show}
    on:mouseleave={hideSoon}
  >
    <div class="si-head">
      {#if data?.icon}<span class="si-ico" aria-hidden="true">{data.icon}</span>{/if}
      <div class="si-title">
        <span class="si-name">{data?.name || slug}</span>
        <span class="si-slug">{data?.version ? `${slug} · v${data.version}` : slug}</span>
      </div>
      <span class="si-badge" class:si-badge-in={installed}>
        {installed ? $t('agent.skills.info_installed') : $t('agent.skills.catalogue_word')}
      </span>
    </div>

    {#if loading}
      <p class="si-muted">{$t('agent.skills.info_loading')}</p>
    {:else if data?.description}
      <p class="si-desc" lang={showTranslated && translated ? 'es' : undefined}>
        {showTranslated && translated ? translated.text : data.description}
      </p>
      <div class="si-tr">
        <button class="si-tr-btn" type="button" on:click|stopPropagation={translate} disabled={translating}>
          {translating
            ? $t('agent.skills.info_translating')
            : showTranslated && translated
              ? $t('agent.skills.info_original')
              : $t('agent.skills.info_translate')}
        </button>
        {#if showTranslated && translated}
          <span class="si-tr-note">{$t('agent.skills.info_translated_with', { model: translated.model })}</span>
        {:else if translateError}
          <span class="si-tr-err">{needsPrices ? $t('agent.skills.info_no_prices') : translateError}</span>
          {#if needsPrices}
            <button class="si-tr-link" type="button" on:click|stopPropagation={refreshAndRetry} disabled={refreshing}>
              {refreshing ? $t('agent.prices.refreshing') : $t('agent.prices.refresh_retry')}
            </button>
          {/if}
        {/if}
      </div>
    {:else}
      <p class="si-muted">{$t('agent.skills.info_none')}</p>
    {/if}

    {#if data?.author || data?.category}
      <dl class="si-meta">
        {#if data?.category}<dt>{$t('agent.skills.info_category')}</dt><dd>{data.category}</dd>{/if}
        {#if data?.author}<dt>{$t('agent.skills.info_author')}</dt><dd>{data.author}</dd>{/if}
      </dl>
    {/if}

    {#if data?.tags?.length}
      <div class="si-chips">
        {#each data.tags.slice(0, 8) as tag (tag)}<span class="si-chip">{tag}</span>{/each}
      </div>
    {/if}

    {#if matches.length}
      <div class="si-why">
        <span class="si-why-l">
          {$t('agent.skills.info_why')}{#if score !== null}<span class="si-score">{score.toFixed(1)}</span>{/if}
        </span>
        <div class="si-chips">
          {#each matches as m (m)}<span class="si-chip si-chip-match">{m}</span>{/each}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .si-btn{
    display:inline-grid;place-items:center;flex:none;
    width:16px;height:16px;padding:0;border-radius:50%;
    font:700 10px/1 'Georgia',serif;font-style:italic;
    color:#8a8fa8;background:rgba(120,130,160,.1);border:1px solid rgba(120,130,160,.3);
    cursor:help;transition:color .12s, background .12s, border-color .12s;
    /* A 16px glyph, a 28px target. */
    position:relative;
  }
  .si-btn::after{content:'';position:absolute;inset:-6px}
  .si-btn:hover, .si-on{color:#0a0e14;background:#9fb4e8;border-color:#9fb4e8}
  .si-btn:focus-visible{outline:2px solid rgba(120,170,255,.7);outline-offset:2px}

  .si-card{
    position:fixed;z-index:2000;width:min(360px, calc(100vw - 16px));
    padding:12px 14px;border-radius:10px;
    background:#11131d;border:1px solid rgba(120,130,160,.28);
    box-shadow:0 18px 40px -12px rgba(0,0,0,.75);
    color:#d8dae3;font:500 12px/1.5 'Manrope',sans-serif;
    animation:si-in .14s ease-out;
  }
  .si-above{animation-name:si-in-up}
  @keyframes si-in{from{opacity:0;transform:translateY(-3px)}}
  @keyframes si-in-up{from{opacity:0;transform:translateY(3px)}}
  @media (prefers-reduced-motion: reduce){ .si-card{animation:none} }

  .si-head{display:flex;align-items:flex-start;gap:9px;margin-bottom:8px}
  .si-ico{font-size:18px;line-height:1.2}
  .si-title{display:flex;flex-direction:column;min-width:0;flex:1}
  .si-name{font:700 13px 'Manrope',sans-serif;color:#f0f2f7}
  .si-slug{font:500 10.5px 'JetBrains Mono',monospace;color:#7a7f92}
  .si-badge{
    flex:none;font:600 9.5px 'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.4px;
    padding:2px 7px;border-radius:5px;color:#9fb4e8;background:rgba(159,180,232,.1);border:1px solid rgba(159,180,232,.3);
  }
  .si-badge-in{color:#78dc8c;background:rgba(120,220,140,.1);border-color:rgba(120,220,140,.3)}

  .si-desc{margin:0 0 8px;color:#d8dae3;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
  .si-tr{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:-2px 0 8px}
  .si-tr-btn{
    height:24px;padding:0 9px;border-radius:6px;cursor:pointer;
    font:600 11px 'Manrope',sans-serif;color:#c4c8d6;
    background:rgba(255,255,255,.04);border:1px solid rgba(120,130,160,.25);
  }
  .si-tr-btn:hover:not(:disabled){background:rgba(255,255,255,.08);border-color:rgba(120,130,160,.45)}
  .si-tr-btn:disabled{opacity:.6;cursor:wait}
  .si-tr-btn:focus-visible{outline:2px solid rgba(120,170,255,.7);outline-offset:2px}
  .si-tr-note{font:500 10px 'JetBrains Mono',monospace;color:#7a7f92}
  .si-tr-link{
    background:none;border:none;padding:0;cursor:pointer;
    font:600 11px 'Manrope',sans-serif;color:#9fb4e8;text-decoration:underline;text-underline-offset:2px;
  }
  .si-tr-link:hover:not(:disabled){color:#c4d3f7}
  .si-tr-link:disabled{opacity:.6;cursor:wait}
  .si-tr-err{font:500 10.5px 'Manrope',sans-serif;color:#ef5d6e}
  .si-muted{margin:0 0 8px;color:#8a8fa8;font-style:italic}

  .si-meta{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0 0 8px;font-size:11px}
  .si-meta dt{color:#7a7f92}
  .si-meta dd{margin:0;color:#c4c8d6}

  .si-chips{display:flex;flex-wrap:wrap;gap:4px}
  .si-chip{
    font:500 10px 'JetBrains Mono',monospace;color:#b8bdd0;
    padding:1px 6px;border-radius:4px;background:rgba(120,130,160,.1);border:1px solid rgba(120,130,160,.16);
  }
  .si-why{margin-top:9px;padding-top:9px;border-top:1px solid rgba(120,130,160,.14)}
  .si-why-l{display:flex;align-items:center;gap:6px;margin-bottom:5px;font:600 10.5px 'Manrope',sans-serif;color:#8a8fa8}
  .si-score{font:600 10px 'JetBrains Mono',monospace;color:#c9a84c}
  .si-chip-match{color:#c9a84c;background:rgba(201,168,76,.08);border-color:rgba(201,168,76,.25)}
</style>
