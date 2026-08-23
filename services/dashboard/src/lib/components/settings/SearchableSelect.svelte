<script lang="ts">
  /**
   * A select for lists too long to scan. Same matching as the chat's model
   * picker (`$lib/model-filter`), so a query behaves identically wherever it is
   * typed: separator-insensitive ("gpt5" finds "gpt-5"), with the literal hit
   * highlighted.
   *
   * Below `threshold` options it renders the plain `SelectField` — a native
   * select is the better control for a short list, and it stays consistent with
   * the rest of the settings form.
   */
  import { tick } from 'svelte';
  import SelectField from './SelectField.svelte';
  import { rankModels, buildCatalog, type ModelEntry } from '$lib/model-catalog.js';
  import ModelTraitBadges from '$lib/components/ModelTraitBadges.svelte';

  export let value = '';
  export let options: Array<{ value: string; label: string }> = [];
  /** Capability tags by model id, straight from the probe. Optional: without
   *  them the control still groups and ranks, it just shows no badges. */
  export let traits: Record<string, Record<string, boolean>> = {};
  export let disabled = false;
  export let id = '';
  export let placeholder = 'Search…';
  /** Fewer options than this and a native select is friendlier. */
  export let threshold = 12;

  let open = false;
  let query = '';
  let active = 0;
  let root: HTMLDivElement | null = null;
  let input: HTMLInputElement | null = null;

  $: rich = options.length >= threshold;
  $: entries = options.map((o): ModelEntry => ({ id: o.value || o.label, traits: traits[o.value || o.label] }));
  // Same two shapes as the chat picker: a catalogue while browsing, one ranked
  // list the moment there is a query. Ordering lives in $lib/model-catalog.
  type Shown = {
    value: string;
    label: string;
    hi?: [number, number];
    traits?: Record<string, boolean>;
    snapshot?: boolean;
    /** Set on the first row of a family, which is where the divider is drawn. */
    family?: string;
  };
  $: searching = query.trim().length > 0;
  $: shown = (searching
    ? rankModels(entries, query).map((m): Shown => ({
        value: m.id, label: m.id,
        ...(m.hi ? { hi: m.hi } : {}),
        ...(m.traits ? { traits: m.traits as Record<string, boolean> } : {}),
        ...(m.snapshot ? { snapshot: true } : {}),
      }))
    : buildCatalog(entries).flatMap((g) =>
        g.rows.flatMap((r): Shown[] => [
          { value: r.id, label: r.id, traits: r.traits as Record<string, boolean> | undefined, family: g.family },
          ...r.snapshots.map((sn): Shown => ({
            value: sn.id, label: sn.id,
            traits: sn.traits as Record<string, boolean> | undefined,
            snapshot: true,
          })),
        ]),
      )) as Shown[];
  // Re-ranking invalidates the old cursor position.
  $: query, (active = 0);
  $: currentLabel = options.find((o) => o.value === value)?.label ?? value;

  async function openMenu() {
    if (disabled) return;
    query = '';
    open = true;
    await tick();
    input?.focus();
    // Start on the current value so ↑↓ moves relative to where you are.
    const at = shown.findIndex((o) => o.value === value);
    if (at >= 0) setActive(at);
  }

  function close() {
    open = false;
    query = '';
  }

  function setActive(i: number) {
    if (shown.length === 0) return;
    active = Math.max(0, Math.min(shown.length - 1, i));
    void tick().then(() => {
      root?.querySelector(`#${id || 'ss'}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
    });
  }

  function pick(v: string) {
    value = v;
    close();
  }

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(shown.length ? (active + 1) % shown.length : 0); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(shown.length ? (active - 1 + shown.length) % shown.length : 0); return; }
    if (e.key === 'Home') { e.preventDefault(); setActive(0); return; }
    if (e.key === 'End') { e.preventDefault(); setActive(shown.length - 1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const o = shown[active];
      if (o) pick(o.value);
    }
  }

  function onWindowClick(e: MouseEvent) {
    if (!open) return;
    if (root && !root.contains(e.target as Node)) close();
  }
</script>

<svelte:window on:click={onWindowClick} />

{#if !rich}
  <SelectField {id} bind:value {options} {disabled} on:change />
{:else}
  <div class="ss" bind:this={root} on:keydown={onKey} role="presentation">
    <button
      type="button"
      class="ss-trigger"
      class:ss-open={open}
      {id}
      {disabled}
      aria-haspopup="listbox"
      aria-expanded={open}
      on:click={() => (open ? close() : openMenu())}
    >
      <span class="ss-value" class:ss-empty={!value}>{currentLabel || '(default)'}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="11" height="11" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>

    {#if open}
      <div
        class="ss-menu"
        role="listbox"
        tabindex="-1"
        aria-activedescendant={shown.length ? `${id || 'ss'}-opt-${active}` : undefined}
      >
        <input
          class="ss-search"
          type="text"
          {placeholder}
          aria-label={placeholder}
          autocomplete="off"
          spellcheck="false"
          bind:value={query}
          bind:this={input}
        />
        <div class="ss-count">{shown.length} of {options.length}</div>
        <div class="ss-list">
          {#each shown as o, i (o.value)}
            <!-- Only when the family groups more than one row; a header over a
                 lone model repeats its name. -->
            {#if o.family && o.family !== shown[i - 1]?.family && shown[i + 1]?.family === o.family}
              <div class="ss-fam">{o.family}</div>
            {/if}
            <button
              type="button"
              id="{id || 'ss'}-opt-{i}"
              class="ss-opt"
              class:ss-opt-active={i === active}
              class:ss-opt-current={o.value === value}
              class:ss-opt-snap={o.snapshot}
              role="option"
              aria-selected={o.value === value}
              on:click={() => pick(o.value)}
              on:mousemove={() => (active = i)}
            >
              <span class="ss-opt-name">
                {#if o.hi}
                  {o.label.slice(0, o.hi[0])}<mark>{o.label.slice(o.hi[0], o.hi[1])}</mark>{o.label.slice(o.hi[1])}
                {:else}
                  {o.label}
                {/if}
              </span>
              <ModelTraitBadges traits={o.traits} />
            </button>
          {:else}
            <div class="ss-none">No model matches “{query}”.</div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .ss { position: relative; width: 100%; }
  .ss-trigger {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    width: 100%; padding: 6px 10px; border-radius: 6px; font-size: 12px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    font-family: var(--font-body); cursor: pointer; box-sizing: border-box; text-align: left;
  }
  .ss-trigger:focus, .ss-open { outline: none; border-color: var(--teal); }
  .ss-trigger:disabled { opacity: 0.5; cursor: default; }
  .ss-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, monospace); }
  .ss-empty { color: var(--text-3); font-family: var(--font-body); }

  .ss-menu {
    position: absolute; z-index: 60; top: calc(100% + 4px); left: 0; right: 0;
    display: flex; flex-direction: column; max-height: 320px;
    background: var(--surface-1, #14181f); border: 1px solid var(--border);
    border-radius: 8px; box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
    padding: 6px;
  }
  .ss-search {
    width: 100%; padding: 6px 8px; border-radius: 5px; font-size: 12px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    font-family: var(--font-body); outline: none; box-sizing: border-box;
  }
  .ss-search:focus { border-color: var(--teal); }
  .ss-count {
    padding: 5px 4px 3px; font-size: 10px; color: var(--text-3);
    font-family: var(--font-mono, monospace);
  }
  .ss-list { overflow-y: auto; min-height: 0; }
  .ss-fam {
    padding: 6px 8px 3px;
    font-family: var(--font-mono, monospace);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--text-3) 65%, transparent);
  }
  .ss-opt-snap { padding-left: 18px; opacity: 0.8; }
  .ss-opt-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ss-opt {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    width: 100%; text-align: left; border: 0; background: transparent;
    color: var(--text-2); font-family: var(--font-mono, monospace); font-size: 11px;
    padding: 5px 8px; border-radius: 5px; cursor: pointer;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ss-opt-active { background: color-mix(in srgb, var(--teal) 14%, transparent); color: var(--text-1); }
  .ss-opt-current { color: var(--teal); font-weight: 700; }
  .ss-opt mark {
    background: color-mix(in srgb, var(--teal) 32%, transparent);
    color: inherit; border-radius: 2px; padding: 0 1px;
  }
  .ss-none { padding: 10px 8px; font-size: 11px; color: var(--text-3); }
</style>
