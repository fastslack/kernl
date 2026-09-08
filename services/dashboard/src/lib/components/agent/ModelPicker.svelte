<!--
  ModelPicker — one provider + model choice, with the reason a choice is dead.

  The ranking, grouping and matching are not reimplemented here: they live in
  `$lib/model-catalog.js` and `$lib/model-filter.js`, already proven against a
  67-model OpenAI account, and the chat's own picker consumes exactly the same
  three functions (routes/chat/+page.svelte:8). What is different here is the
  shape, not the logic — over there the menu is inline in a 12k-line page, here
  it is a component the runtime panel mounts once per chain row.

  A provider that cannot run a tool loop is rendered DISABLED WITH ITS REASON
  rather than filtered out. Hiding it would hide the exact provider named in
  "No LLM provider in the chain can run tool calls. Dropped: claude_code" —
  the user would go looking for the thing the error told them about and find
  an empty space.

  The menu is `position: fixed` off the trigger's rect because the drawer sets
  `overflow: hidden`; an absolutely-positioned dropdown gets clipped at the
  panel edge. Same reason, same fix as the chat picker.
-->
<script lang="ts">
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { buildCatalog, commonModels, rankModels, type ModelEntry } from '$lib/model-catalog.js';
  import { toolCapable, findProvider, type ProviderStatus } from '$lib/provider-health.js';
  import { bindListeners } from '$lib/outside-listeners.js';

  /** Provider name as the agent stores it — may be `claude_code`, not the slug. */
  export let provider = '';
  export let model = '';
  /** Statuses from GET /api/llm-providers, each enriched with its model list. */
  export let providers: Array<ProviderStatus & { models?: ModelEntry[] }> = [];
  /**
   * Does the run this picker configures need a tool loop? False for agents on
   * the claude_code executor, whose SDK runs tools inside itself.
   */
  export let requiresTools = true;
  export let disabled = false;
  /** Shown on the trigger when the write for this row is in flight. */
  export let busy = false;
  /** Non-empty paints the trigger red and titles it with the reason. */
  export let error = '';
  export let placeholder = 'choose a model';

  const dispatch = createEventDispatcher();

  let open = false;
  let trigger: HTMLButtonElement | null = null;
  let searchEl: HTMLInputElement | null = null;
  let query = '';
  let pos = { top: 0, left: 0, width: 320 };
  /** Providers whose full catalogue the user asked to see. */
  let expanded = new Set<string>();

  /** How many models to offer per provider before "show all". */
  const PREVIEW = 6;

  $: current = findProvider(providers, provider);
  $: currentLabel = provider || model
    ? `${provider || 'default'} / ${model || '(provider default)'}`
    : placeholder;

  /**
   * Move a node to <body> for as long as it is mounted.
   *
   * `position: fixed` is not enough on its own here. The drawer sets
   * `backdrop-filter` on `.info-panel`, and a filtered element becomes the
   * containing block for its fixed-position descendants — so viewport
   * coordinates were being measured against the viewport and then applied
   * relative to the panel, which pushed the menu ~570px right and off the
   * screen edge. Rendering it on <body> puts the two coordinate systems back
   * in agreement, and takes it out of the panel's stacking context as well.
   */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  function place() {
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const width = Math.max(300, Math.min(r.width, 460));
    // Flip above the trigger when there is no room below it — a fallback row
    // near the bottom of the drawer would otherwise open off-screen.
    const below = window.innerHeight - r.bottom;
    const top = below < 280 && r.top > below ? Math.max(8, r.top - Math.min(420, r.top - 8)) : r.bottom + 6;
    pos = { top, left: Math.min(r.left, window.innerWidth - width - 8), width };
  }

  /**
   * The window listeners this menu owns while it is open — and the only way
   * off them. Held in one handle so `close()` and `onDestroy` can both drop
   * them without either knowing whether the other already did.
   */
  let unbindOuter: (() => void) | null = null;

  /** Opened from outside — Task 10's `pick-tool-capable-provider` remedy. */
  export function openMenu(): void {
    if (disabled) return;
    query = '';
    expanded = new Set();
    place();
    open = true;
    void tick().then(() => searchEl?.focus());
    unbindOuter?.();
    unbindOuter = bindListeners(window, [
      { type: 'scroll', handler: onOuterScroll, options: { capture: true, passive: true } },
      { type: 'resize', handler: close },
    ]);
  }

  function close() {
    if (!open) return;
    open = false;
    unbindOuter?.();
    unbindOuter = null;
  }

  // A component can be destroyed with its menu still open: the drawer closes,
  // the selected agent changes, or a chain row is removed — and the rows are
  // keyed by index, so removing one destroys and rebuilds the components after
  // it. `close()` alone would never run in any of those, and both listeners
  // would stay on `window` holding this component and a detached trigger.
  onDestroy(() => {
    unbindOuter?.();
    unbindOuter = null;
  });

  /**
   * Follow the trigger, and only give up when it actually leaves.
   *
   * The chat's picker simply closed on any outer scroll, which is fine on a
   * static page. Here the menu opens over a live 3D world whose message
   * stream scrolls itself, and a blanket handler shut the menu in the same
   * frame it opened — the click looked like it did nothing at all. A scroll
   * that cannot move this control is not our business.
   */
  function onOuterScroll(e: Event) {
    const t = e.target as Node | null;
    if (t instanceof Element && t.closest('.mp-menu')) return;
    const movesUs =
      t instanceof Element ? !!trigger && t.contains(trigger) : true; // document/window scroll
    if (!movesUs) return;
    place();
    const r = trigger?.getBoundingClientRect();
    if (!r || r.bottom < 0 || r.top > window.innerHeight) close();
  }

  function toggle() {
    if (open) close();
    else openMenu();
  }

  function choose(slugOrName: string, nextModel: string) {
    close();
    if (slugOrName === provider && nextModel === model) return;
    dispatch('change', { provider: slugOrName, model: nextModel });
  }

  /**
   * The rows to show for one provider.
   *
   * Empty query: the handful worth offering before anyone scrolls, which is
   * what `commonModels` derives from the ids themselves. A query dissolves the
   * grouping into one ranked list — grouping is for browsing, ranking is for
   * finding.
   */
  function rowsFor(p: ProviderStatus & { models?: ModelEntry[] }, q: string, showAll: boolean) {
    const entries = p.models ?? [];
    if (q.trim()) return rankModels(entries, q).slice(0, 40);
    const groups = buildCatalog(entries);
    if (showAll) return groups.flatMap((g) => g.rows.map((r) => ({ id: r.id, traits: r.traits })));
    return commonModels(groups, [], PREVIEW).map((r) => ({ id: r.id, traits: r.traits }));
  }

  /** Total models a provider offers, for the "show all N" affordance. */
  function totalFor(p: ProviderStatus & { models?: ModelEntry[] }) {
    return (p.models ?? []).length;
  }

  /** A provider name is a match too — "grok" should reach xAI's catalogue. */
  function providerMatches(p: ProviderStatus, q: string): boolean {
    const s = q.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!s) return true;
    return (
      p.slug.toLowerCase().replace(/[^a-z0-9]/g, '').includes(s) ||
      p.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(s)
    );
  }

  /**
   * Providers to render, and why each one is offered or blocked. Never
   * filtered by capability — only annotated.
   */
  $: shown = providers.map((p) => {
    const capable = toolCapable(p);
    const blockedTools = requiresTools && capable === false;
    const rows = rowsFor(p, query, expanded.has(p.slug));
    return {
      p,
      blockedTools,
      blockedReason: blockedTools
        ? 'cannot run tools'
        : !p.ready
          ? (p.error || 'not configured')
          : p.exhausted
            ? 'quota exhausted'
            : '',
      rows,
      // With a query, a provider that matches nothing at all is dropped from
      // the list; without one every provider stays, offline ones included, so
      // it remains visible what could be configured.
      visible: !query.trim() || rows.length > 0 || providerMatches(p, query),
      total: totalFor(p),
    };
  });

  function showAll(slug: string) {
    const next = new Set(expanded);
    next.add(slug);
    expanded = next;
  }
</script>

<svelte:window on:keydown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(); } }} />

<button
  class="mp-trigger"
  class:mp-err={!!error}
  class:mp-busy={busy}
  bind:this={trigger}
  {disabled}
  title={error || currentLabel}
  aria-haspopup="listbox"
  aria-expanded={open}
  on:click|stopPropagation={toggle}
>
  <span class="mp-value" class:mp-placeholder={!provider && !model}>{currentLabel}</span>
  <span class="mp-caret" aria-hidden="true">{busy ? '◌' : '▾'}</span>
</button>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="mp-scrim" use:portal on:click={close}></div>
  <div class="mp-menu" use:portal style="top:{pos.top}px;left:{pos.left}px;width:{pos.width}px" role="listbox" tabindex="-1">
    <div class="mp-search">
      <input
        bind:this={searchEl}
        bind:value={query}
        type="text"
        placeholder="filter models…"
        spellcheck="false"
        autocomplete="off"
        on:click|stopPropagation
      />
    </div>
    <div class="mp-scroll">
      {#each shown as s (s.p.slug)}
        {#if s.visible}
          <div class="mp-group" class:mp-group-blocked={s.blockedTools || !s.p.ready}>
            <div class="mp-group-h">
              <span class="mp-group-n">{s.p.name}</span>
              {#if s.blockedReason}
                <span class="mp-group-why" class:mp-why-tools={s.blockedTools}>{s.blockedReason}</span>
              {/if}
            </div>
            <button
              class="mp-opt"
              class:mp-opt-on={s.p.slug === provider && model === ''}
              disabled={s.blockedTools}
              title={s.blockedTools ? `${s.p.name} cannot execute a tool loop` : 'Let the provider pick its default model'}
              on:click|stopPropagation={() => choose(s.p.slug, '')}
            >
              <span class="mp-opt-id mp-opt-dim">(provider default)</span>
            </button>
            {#each s.rows as r (r.id)}
              <button
                class="mp-opt"
                class:mp-opt-on={s.p.slug === provider && r.id === model}
                disabled={s.blockedTools}
                title={s.blockedTools ? `${s.p.name} cannot execute a tool loop` : r.id}
                on:click|stopPropagation={() => choose(s.p.slug, r.id)}
              >
                <span class="mp-opt-id">{r.id}</span>
              </button>
            {/each}
            {#if !query.trim() && !expanded.has(s.p.slug) && s.total > s.rows.length}
              <button class="mp-more" on:click|stopPropagation={() => showAll(s.p.slug)}>
                show all {s.total}
              </button>
            {/if}
            {#if s.p.ready && s.total === 0}
              <div class="mp-empty">no models discovered</div>
            {/if}
          </div>
        {/if}
      {/each}
      {#if shown.filter((s) => s.visible).length === 0}
        <div class="mp-empty">nothing matches “{query}”</div>
      {/if}
      {#if provider && !current}
        <div class="mp-group mp-group-blocked">
          <div class="mp-group-h">
            <span class="mp-group-n">{provider}</span>
            <span class="mp-group-why mp-why-tools">not installed</span>
          </div>
          <div class="mp-empty">This kernel has no provider by that name. Pick another row above.</div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .mp-trigger{
    display:flex;align-items:center;gap:8px;width:100%;
    padding:7px 10px;border-radius:6px;
    background:rgba(20,24,38,.85);
    border:1px solid rgba(120,130,160,.28);
    color:#dde0ea;cursor:pointer;text-align:left;
    font:500 11.5px 'JetBrains Mono',monospace;
    transition:border-color .12s,background .12s;
  }
  .mp-trigger:hover:not(:disabled){border-color:rgba(120,130,160,.55);background:rgba(26,31,48,.9)}
  .mp-trigger:disabled{opacity:.5;cursor:not-allowed}
  .mp-trigger.mp-err{border-color:rgba(239,93,110,.65);background:rgba(239,93,110,.08)}
  .mp-trigger.mp-busy{cursor:wait}
  .mp-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mp-placeholder{color:#6a6f82}
  .mp-caret{color:#6a6f82;font-size:10px;flex:none}

  .mp-scrim{position:fixed;inset:0;z-index:60}
  .mp-menu{
    position:fixed;z-index:61;max-height:420px;
    display:flex;flex-direction:column;
    background:rgba(14,17,26,.98);
    border:1px solid rgba(120,130,160,.28);
    border-radius:10px;
    box-shadow:0 24px 60px -20px rgba(0,0,0,.8);
    overflow:hidden;
  }
  .mp-search{padding:8px;border-bottom:1px solid rgba(120,130,160,.14)}
  .mp-search input{
    width:100%;box-sizing:border-box;
    background:rgba(0,0,0,.35);color:#dde0ea;
    border:1px solid rgba(120,130,160,.22);border-radius:6px;
    padding:6px 9px;outline:none;
    font:500 11.5px 'JetBrains Mono',monospace;
  }
  .mp-search input:focus{border-color:rgba(120,170,255,.55)}
  .mp-scroll{overflow-y:auto;padding:6px}

  .mp-group{margin-bottom:8px}
  .mp-group-blocked .mp-opt-id{opacity:.55}
  .mp-group-h{
    display:flex;align-items:center;gap:8px;justify-content:space-between;
    padding:4px 8px 5px;
    font:600 9px 'Syne',sans-serif;letter-spacing:1.2px;text-transform:uppercase;
    color:#8a8fa8;
  }
  .mp-group-n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mp-group-why{
    flex:none;letter-spacing:.3px;text-transform:none;
    font:600 9px 'JetBrains Mono',monospace;
    padding:2px 6px;border-radius:4px;
    color:#fbbf24;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.28);
  }
  .mp-why-tools{color:#ef5d6e;background:rgba(239,93,110,.1);border-color:rgba(239,93,110,.32)}

  .mp-opt{
    display:flex;align-items:center;gap:8px;width:100%;
    padding:5px 9px;border:none;border-radius:5px;background:none;
    color:#d8dae3;cursor:pointer;text-align:left;
    font:500 11.5px 'JetBrains Mono',monospace;
  }
  .mp-opt:hover:not(:disabled){background:rgba(120,130,160,.12)}
  .mp-opt:disabled{cursor:not-allowed}
  .mp-opt-on{background:rgba(120,170,255,.14);color:#f0f2f7}
  .mp-opt-id{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mp-opt-dim{color:#8a8fa8}
  .mp-more{
    background:none;border:none;cursor:pointer;
    padding:3px 9px;color:#7f93c8;
    font:600 10px 'JetBrains Mono',monospace;
  }
  .mp-more:hover{color:#a9bcf0;text-decoration:underline}
  .mp-empty{padding:6px 9px;color:#6a6f82;font:500 10.5px 'JetBrains Mono',monospace}
</style>
