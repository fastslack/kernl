<!-- src/lib/components/panels/PanelDetail.svelte -->
<script lang="ts">
  /**
   * One record (a card opened from a board or table) or one summary (a detail
   * view of its own). Values are laid out by what they are, not as a column of
   * labels: the name on top, states as chips, contact data as links you can
   * click, numbers as tiles you read at a glance, a breakdown as a bar.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { locale } from '$lib/i18n/index.js';
  import { textOf } from '$lib/panels/template.js';
  import { pollSource } from '$lib/panels/client.js';
  import { jsonHtml } from '$lib/json-view.js';
  import { humanize, kindOf, hrefOf, tone, hueOf, type FieldKind } from '$lib/panels/look.js';
  import type { PanelSpec, PanelView } from '$lib/panels/types.js';
  import Icon from '$lib/components/ui/Icon.svelte';
  import PanelForm from './PanelForm.svelte';
  export let flowId: string;
  export let view: PanelView;
  export let spec: PanelSpec;
  /** The opened record, or null when this detail is a tab of its own (no back button, no key). */
  export let rowKey: string | null;
  const dispatch = createEventDispatcher<{ back: void }>();
  let row: Record<string, unknown> | null = null;
  let error = '';
  let openAction: string | null = null;
  const [source, select] = (view.data ?? '').split(/:(.*)/s);
  const stop = pollSource(flowId, source, { select, ...(rowKey ? { key: rowKey } : {}) }, (d) => { row = (d as Record<string, unknown>) ?? null; }, (m) => (error = m));
  onDestroy(stop);

  type Field = { key: string; label: string; value: unknown; text: string; kind: FieldKind };
  const present = (v: unknown) => v !== undefined && v !== null && v !== '';
  $: en = $locale.startsWith('en');
  $: labelOf = (key: string) => {
    const f = view.fields?.find((x) => x.key === key);
    return (f?.label && textOf(f.label, $locale)) || humanize(key);
  };
  $: keys = view.sections ?? Object.keys(row ?? {}).filter((k) => !k.startsWith('_') && k !== 'created_at' && k !== 'updated_at');
  $: all = row ? keys.filter((k) => present(row?.[k])).map((key): Field => {
    const value = row?.[key];
    return { key, label: labelOf(key), value, text: typeof value === 'object' ? '' : String(value), kind: kindOf(key, value) };
  }) : [];
  // An opened record leads with its name: the first plain text it has.
  $: title = rowKey ? all.find((f) => f.kind === 'text' || f.kind === 'long') ?? null : null;
  $: rest = all.filter((f) => f !== title);
  $: chips = rest.filter((f) => f.kind === 'status');
  $: contact = rest.filter((f) => f.kind === 'email' || f.kind === 'phone' || f.kind === 'url');
  $: numbers = rest.filter((f) => f.kind === 'number' || f.kind === 'percent');
  $: breakdowns = rest.filter((f) => f.kind === 'breakdown');
  $: longs = rest.filter((f) => f.kind === 'long');
  $: plain = rest.filter((f) => f.kind === 'text');
  $: objects = rest.filter((f) => f.kind === 'object');

  // A status whose value only repeats its name ("vencido": "vencido") reads as the flag it is.
  const chipText = (f: Field) => (f.text.toLowerCase() === f.key.toLowerCase() ? f.label : f.text);
  const contactIcon = (k: FieldKind) => (k === 'email' ? 'mail' : k === 'phone' ? 'phone' : 'globe');
  const numHue = (f: Field) => (/overdue|vencid|lost|perdid|fail|error/i.test(f.key) && Number(f.text) > 0 ? tone('overdue') : hueOf(f.key));
  const fmtNum = (f: Field) => {
    const n = Number(f.text);
    return Number.isNaN(n) ? f.text : n.toLocaleString(en ? 'en' : 'es');
  };
  const parts = (f: Field) => Object.entries(f.value as Record<string, number>);
  const sum = (f: Field) => parts(f).reduce((a, [, n]) => a + n, 0);
</script>

<div class="pd">
  {#if rowKey || title || chips.length}
    <header class="pd-head">
      {#if rowKey}
        <button class="pd-back" type="button" on:click={() => dispatch('back')} aria-label={en ? 'Back' : 'Volver'}>
          <Icon name="arrow-l" size={15} />
        </button>
      {/if}
      <div class="pd-head-txt">
        {#if title}<h3 class="pd-title">{title.text}</h3>{/if}
        {#if chips.length}
          <div class="pd-chips">
            {#each chips as f (f.key)}
              <span class="pd-chip" style="--tone:{tone(f.text)}" title={f.label}><i aria-hidden="true"></i>{chipText(f)}</span>
            {/each}
          </div>
        {/if}
      </div>
    </header>
  {/if}

  {#if error}<p class="pd-err" role="alert">{error}</p>{/if}
  {#if !row && !error}<div class="pd-skel" aria-hidden="true"><span></span><span></span><span></span></div>{/if}

  {#if contact.length}
    <div class="pd-contact">
      {#each contact as f (f.key)}
        {@const href = hrefOf(f.kind, f.text)}
        <a class="pd-link pd-link--{f.kind}" href={href} target={f.kind === 'url' ? '_blank' : undefined} rel="noopener noreferrer" title={f.label}>
          <span class="pd-link-ic"><Icon name={contactIcon(f.kind)} size={14} /></span>
          <span class="pd-link-v">{f.text}</span>
        </a>
      {/each}
    </div>
  {/if}

  {#if numbers.length}
    <div class="pd-kpis">
      {#each numbers as f (f.key)}
        <div class="pd-kpi" style="--hue:{numHue(f)}">
          <span class="pd-kpi-k">{f.label}</span>
          <span class="pd-kpi-v">{fmtNum(f)}{#if f.kind === 'percent'}<small>%</small>{/if}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#each breakdowns as f (f.key)}
    {@const total = sum(f)}
    <section class="pd-card">
      <h4 class="pd-h">{f.label}<span class="pd-h-n">{total.toLocaleString(en ? 'en' : 'es')}</span></h4>
      <div class="pd-bar" role="img" aria-label={parts(f).map(([k, n]) => `${k}: ${n}`).join(', ')}>
        {#each parts(f) as [k, n] (k)}
          {#if n > 0}<span style="flex:{n};--tone:{tone(k)}" title="{k}: {n}"></span>{/if}
        {/each}
        {#if total === 0}<span class="pd-bar-empty"></span>{/if}
      </div>
      <div class="pd-legend">
        {#each parts(f) as [k, n] (k)}
          <span class="pd-leg" class:pd-leg--zero={n === 0} style="--tone:{tone(k)}"><i aria-hidden="true"></i>{humanize(k)}<b>{n.toLocaleString(en ? 'en' : 'es')}</b></span>
        {/each}
      </div>
    </section>
  {/each}

  {#if plain.length}
    <div class="pd-facts">
      {#each plain as f (f.key)}
        <div class="pd-fact" style="--hue:{hueOf(f.key)}">
          <span class="pd-fact-k">{#if /alta|created|fecha|date|proximo|next|when/i.test(f.key)}<Icon name="clock" size={11} />{/if}{f.label}</span>
          <span class="pd-fact-v">{f.text}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#each longs as f (f.key)}
    <section class="pd-card pd-note" style="--hue:{hueOf(f.key)}">
      <h4 class="pd-h">{f.label}</h4>
      <p>{f.text}</p>
    </section>
  {/each}

  {#each objects as f (f.key)}
    <section class="pd-card">
      <h4 class="pd-h">{f.label}</h4>
      <div class="pd-json">{@html jsonHtml(f.value)}</div>
    </section>
  {/each}

  {#if view.actions?.length}
    <div class="pd-acts">
      {#each view.actions as a, i (a)}
        {#if spec.actions?.[a]}
          <button type="button" class:on={openAction === a} style="--hue:{hueOf(a + i)}" on:click={() => (openAction = openAction === a ? null : a)}>
            <Icon name="spark" size={13} />{textOf(spec.actions[a].label, $locale)}
          </button>
        {/if}
      {/each}
    </div>
    {#if openAction && spec.actions?.[openAction]}
      <div class="pd-card">
        {#key `${rowKey}:${openAction}`}<PanelForm {flowId} actionId={openAction} action={spec.actions[openAction]} preset={rowKey ? { key: rowKey } : {}} />{/key}
      </div>
    {/if}
  {/if}
</div>

<style>
  .pd { display: flex; flex-direction: column; gap: 12px; font-family: 'Manrope', sans-serif; }

  .pd-head { display: flex; align-items: flex-start; gap: 12px; }
  .pd-back {
    flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; cursor: pointer;
    color: #22D3EE; background: color-mix(in srgb, #22D3EE 12%, var(--surface-2)); border: 1px solid color-mix(in srgb, #22D3EE 40%, var(--border));
    transition: transform .2s ease-out, box-shadow .2s, background .2s;
  }
  .pd-back:hover { transform: translateX(-2px); background: color-mix(in srgb, #22D3EE 22%, var(--surface-2)); box-shadow: 0 8px 18px -12px #22D3EE; }
  .pd-back:focus-visible { outline: 2px solid #22D3EE; outline-offset: 2px; }
  .pd-head-txt { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .pd-title { margin: 0; font: 800 19px/1.25 var(--font-display, 'Manrope'), sans-serif; color: var(--text-1); overflow-wrap: anywhere; }
  .pd-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .pd-chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px;
    font: 800 10px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .05em;
    color: color-mix(in srgb, var(--tone) 70%, white); background: color-mix(in srgb, var(--tone) 18%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 45%, transparent);
  }
  .pd-chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 8px var(--tone); }

  .pd-contact { display: flex; flex-wrap: wrap; gap: 8px; }
  .pd-link {
    --c: #22D3EE;
    display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 4px 12px 4px 4px; border-radius: 10px; text-decoration: none; min-width: 0;
    background: linear-gradient(160deg, color-mix(in srgb, var(--c) 14%, var(--surface-1)), var(--surface-1) 75%);
    border: 1px solid color-mix(in srgb, var(--c) 34%, var(--border)); color: var(--text-1);
    transition: transform .2s ease-out, box-shadow .2s, border-color .2s;
  }
  .pd-link--phone { --c: #34D399; }
  .pd-link--url { --c: #A78BFA; }
  .pd-link:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--c) 65%, var(--border)); box-shadow: 0 10px 22px -14px var(--c); }
  .pd-link:focus-visible { outline: 2px solid var(--c); outline-offset: 2px; }
  .pd-link-ic { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; color: var(--c); background: color-mix(in srgb, var(--c) 20%, transparent); flex: none; }
  .pd-link-v { font: 600 12.5px 'Manrope', sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .pd-kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
  .pd-kpi, .pd-fact {
    display: flex; flex-direction: column; gap: 2px; padding: 9px 12px; border-radius: 12px; min-width: 0;
    background: linear-gradient(160deg, color-mix(in srgb, var(--hue) 14%, var(--surface-1)), var(--surface-1) 70%);
    border: 1px solid color-mix(in srgb, var(--hue) 32%, var(--border));
    transition: transform .2s ease-out, box-shadow .2s, border-color .2s;
  }
  .pd-kpi:hover, .pd-fact:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--hue) 60%, var(--border)); box-shadow: 0 10px 22px -16px var(--hue); }
  .pd-kpi-k, .pd-fact-k {
    display: flex; align-items: center; gap: 4px;
    font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: var(--hue);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .pd-kpi-v { font: 800 22px/1.15 'Manrope', sans-serif; color: var(--text-1); font-variant-numeric: tabular-nums; }
  .pd-kpi-v small { font-size: 13px; font-weight: 700; color: var(--text-3); margin-left: 1px; }

  .pd-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
  .pd-fact-v { font: 600 13px/1.4 'Manrope', sans-serif; color: var(--text-1); overflow-wrap: anywhere; }

  .pd-card { display: flex; flex-direction: column; gap: 8px; padding: 11px 13px; border-radius: 12px; background: var(--surface-1); border: 1px solid var(--border); }
  .pd-h { margin: 0; display: flex; align-items: center; gap: 7px; font: 800 10.5px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .06em; color: var(--text-2); }
  .pd-h::before { content: ''; width: 3px; height: 11px; border-radius: 2px; background: linear-gradient(#22D3EE, #A78BFA); flex: none; }
  .pd-h-n { margin-left: auto; font-size: 12px; color: var(--text-1); }
  .pd-note { background: linear-gradient(160deg, color-mix(in srgb, var(--hue) 9%, var(--surface-1)), var(--surface-1) 60%); border-color: color-mix(in srgb, var(--hue) 26%, var(--border)); }
  .pd-note p { margin: 0; font: 500 13px/1.6 'Manrope', sans-serif; color: var(--text-1); white-space: pre-wrap; }
  .pd-json { font-size: 12px; overflow-x: auto; }

  .pd-bar { display: flex; gap: 2px; height: 12px; border-radius: 999px; overflow: hidden; background: var(--surface-2); }
  .pd-bar span { background: linear-gradient(90deg, var(--tone), color-mix(in srgb, var(--tone) 70%, white)); box-shadow: 0 0 10px -2px var(--tone); }
  .pd-bar .pd-bar-empty { flex: 1; background: none; box-shadow: none; }
  .pd-legend { display: flex; flex-wrap: wrap; gap: 6px; }
  .pd-leg {
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font: 700 11px 'Manrope', sans-serif;
    color: color-mix(in srgb, var(--tone) 70%, white); background: color-mix(in srgb, var(--tone) 14%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 40%, transparent);
  }
  .pd-leg i { width: 7px; height: 7px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 6px var(--tone); }
  .pd-leg b { color: var(--text-1); font-weight: 800; }
  .pd-leg--zero { opacity: .5; }

  .pd-skel { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .pd-skel span { height: 58px; border-radius: 12px; background: linear-gradient(90deg, var(--surface-1), var(--surface-2), var(--surface-1)); background-size: 200% 100%; animation: pd-shimmer 1.2s ease-in-out infinite; }
  @keyframes pd-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }

  .pd-err { margin: 0; padding: 8px 12px; border-radius: 10px; background: color-mix(in srgb, #F43F5E 12%, transparent); border: 1px solid color-mix(in srgb, #F43F5E 40%, transparent); color: #ff9fb5; font: 600 12px 'Manrope', sans-serif; }

  .pd-acts { display: flex; gap: 8px; flex-wrap: wrap; }
  .pd-acts button {
    display: inline-flex; align-items: center; gap: 6px; padding: 0 14px; min-height: 36px; border-radius: 10px; cursor: pointer;
    font: 700 12px 'Manrope', sans-serif; color: var(--text-1);
    background: linear-gradient(160deg, color-mix(in srgb, var(--hue) 16%, var(--surface-1)), var(--surface-1) 75%);
    border: 1px solid color-mix(in srgb, var(--hue) 40%, var(--border));
    transition: transform .2s ease-out, box-shadow .2s, border-color .2s;
  }
  .pd-acts button :global(svg) { color: var(--hue); }
  .pd-acts button:hover, .pd-acts button.on { transform: translateY(-1px); border-color: var(--hue); box-shadow: 0 10px 22px -14px var(--hue); }
  .pd-acts button:focus-visible { outline: 2px solid var(--hue); outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) {
    .pd-back, .pd-link, .pd-kpi, .pd-fact, .pd-acts button { transition: none; }
    .pd-back:hover, .pd-link:hover, .pd-kpi:hover, .pd-fact:hover, .pd-acts button:hover { transform: none; }
    .pd-skel span { animation: none; }
  }
</style>
