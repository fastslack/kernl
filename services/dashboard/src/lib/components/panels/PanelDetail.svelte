<!-- src/lib/components/panels/PanelDetail.svelte -->
<script lang="ts">
  /**
   * One record (a card opened from a board or table) or one summary (a detail
   * view of its own). Values are laid out by what they are, not as a column of
   * labels: the name on top with its states and flags, links as buttons, the
   * stages it goes through as a stepper (the view's `order`), numbers as tiles,
   * a list of records as rows you can open, a dated list as a history, a long
   * text as a card (an error or a question stands out).
   *
   * The view's actions are a toolbar: an action whose input is only the record's
   * key runs in one click (or two, when it asks for confirmation), with keys
   * 1–9; one that needs more opens its form inline. A record names the buttons
   * that would do nothing on it now in `_off` (the verb of a record action's key,
   * `unblock` of `unblock:{{key}}`), and those are greyed out. `_of` gives a
   * number its total (`{ pos: 34 }` reads "10 / 34"). Opened from a list, ←/→
   * walk the list and Esc goes back.
   */
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { locale } from '$lib/i18n/index.js';
  import { textOf } from '$lib/panels/template.js';
  import { pollSource, runAction } from '$lib/panels/client.js';
  import { jsonHtml } from '$lib/json-view.js';
  import { humanize, kindOf, hrefOf, tone, hueOf, isLive, RED, type FieldKind } from '$lib/panels/look.js';
  import type { PanelAction, PanelSpec, PanelView } from '$lib/panels/types.js';
  import Icon from '$lib/components/ui/Icon.svelte';
  import PanelForm from './PanelForm.svelte';
  export let flowId: string;
  export let view: PanelView;
  export let spec: PanelSpec;
  /** The opened record, or null when this detail is a tab of its own (no back button, no key). */
  export let rowKey: string | null;
  /** The keys of the list it was opened from, in its order: ←/→ walk them. */
  export let siblings: string[] = [];
  const dispatch = createEventDispatcher<{ back: void; open: string }>();
  let row: Record<string, unknown> | null = null;
  let error = '';
  let openAction: string | null = null;
  const [source, select] = (view.data ?? '').split(/:(.*)/s);

  // The record is read again whenever it changes (←/→, a part opened) and right after an action ran.
  let stop: (() => void) | null = null;
  let polled = '';
  function poll() {
    stop?.();
    error = '';
    stop = pollSource(flowId, source, { select, ...(rowKey ? { key: rowKey } : {}) }, (d) => { row = (d as Record<string, unknown>) ?? null; }, (m) => (error = m));
  }
  $: if (`${flowId}|${rowKey}` !== polled) { polled = `${flowId}|${rowKey}`; row = null; openAction = null; confirming = ''; poll(); }
  let gone = false;
  let again: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => { gone = true; stop?.(); clearTimeout(toastTimer); clearTimeout(again); });

  type Kind = FieldKind | 'flag' | 'tags' | 'list' | 'history';
  type Field = { key: string; label: string; value: unknown; text: string; kind: Kind };
  const present = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
  $: en = $locale.startsWith('en');
  $: lang = en ? 'en' : 'es';
  $: labelOf = (key: string) => {
    const f = view.fields?.find((x) => x.key === key);
    return (f?.label && textOf(f.label, $locale)) || humanize(key);
  };
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  function kindFor(key: string, value: unknown): Kind {
    if (value === true || value === 'yes') return 'flag';
    if (Array.isArray(value)) {
      if (value.every((x) => typeof x !== 'object')) return 'tags';
      if (value.every(isObj)) return value.some((x) => 'at' in x) ? 'history' : 'list';
      return 'object';
    }
    const k = kindOf(key, value);
    // A long name with no spaces (a branch, a path) is a fact to copy, not a text to read.
    return k === 'long' && !/\s/.test(String(value)) ? 'text' : k;
  }
  $: keys = view.sections ?? Object.keys(row ?? {}).filter((k) => !k.startsWith('_') && k !== 'created_at' && k !== 'updated_at');
  $: all = row ? keys.filter((k) => present(row?.[k])).map((key): Field => {
    const value = row?.[key];
    return { key, label: labelOf(key), value, text: typeof value === 'object' ? '' : String(value), kind: kindFor(key, value) };
  }) : [];
  // An opened record leads with its name: a field called so, else its first plain text that is not its key.
  $: title = rowKey
    ? all.find((f) => /^(title|name|nombre|titulo|título)$/i.test(f.key)) ?? all.find((f) => (f.kind === 'text' || f.kind === 'long') && f.text !== rowKey) ?? null
    : null;
  $: rest = all.filter((f) => f !== title && !(f.key === 'key' && f.text === rowKey));
  $: chips = rest.filter((f) => f.kind === 'status');
  $: flags = rest.filter((f) => f.kind === 'flag');
  $: links = rest.filter((f) => f.kind === 'url');
  $: contact = rest.filter((f) => f.kind === 'email' || f.kind === 'phone');
  $: numbers = rest.filter((f) => f.kind === 'number' || f.kind === 'percent');
  $: breakdowns = rest.filter((f) => f.kind === 'breakdown');
  // A long text that only repeats the start of another (a summary of the error) is shown once.
  $: longsAll = rest.filter((f) => f.kind === 'long');
  $: longs = longsAll.filter((f) => !longsAll.some((o) => o !== f && o.text.length > f.text.length && o.text.startsWith(f.text.replace(/…$/, ''))));
  $: alerts = longs.filter((f) => alertTone(f.key));
  $: notes = longs.filter((f) => !alertTone(f.key));
  $: plain = rest.filter((f) => f.kind === 'text');
  $: tags = rest.filter((f) => f.kind === 'tags');
  $: lists = rest.filter((f) => f.kind === 'list');
  $: histories = rest.filter((f) => f.kind === 'history');
  $: objects = rest.filter((f) => f.kind === 'object');
  $: ofTotals = isObj(row?._of) ? (row?._of as Record<string, number>) : {};
  $: off = new Set(Array.isArray(row?._off) ? (row?._off as unknown[]).map(String) : []);

  // The stages the record goes through, when the view lists them: where it is, what it went past.
  $: stageField = view.order?.length ? chips.find((f) => view.order?.includes(f.text)) ?? null : null;
  $: stageAt = stageField ? (view.order ?? []).indexOf(stageField.text) : -1;
  // The stage already reads in the stepper: its chip is not repeated in the head.
  $: headChips = stageField && stageAt >= 0 ? chips.filter((f) => f !== stageField) : chips;

  const alertTone = (key: string): string | null =>
    /error|fail|fallo/i.test(key) ? RED : /question|pregunta|feedback|blocked|bloque/i.test(key) ? '#FBBF24' : null;
  const chipText = (f: Field) => (f.text.toLowerCase() === f.key.toLowerCase() ? f.label : f.text);
  const numHue = (f: Field) => (/overdue|vencid|lost|perdid|fail|error|escalat|retr/i.test(f.key) && Number(f.text) > 0 ? tone('overdue') : hueOf(f.key));
  const fmtNum = (f: Field) => {
    const n = Number(f.text);
    // An id or a number that names something (MR #1767) is not a quantity: no thousands separator.
    return Number.isNaN(n) || /number|_id$|^id$|#|year|año/i.test(f.key) ? f.text : n.toLocaleString(lang);
  };
  const parts = (f: Field) => Object.entries(f.value as Record<string, number>);
  const sum = (f: Field) => parts(f).reduce((a, [, n]) => a + n, 0);
  const code = (s: string) => /^[\w./#:@-]{3,}$/.test(s) && !/^\d+$/.test(s) && /[\/#:_-]/.test(s);
  const items = (f: Field) => f.value as Array<Record<string, unknown>>;
  const strs = (f: Field) => [...new Set((f.value as unknown[]).map(String))];
  const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  /** The row of a list: its name, a second line, its state, how long. */
  // A part that only repeats the opened record's title reads by its own name.
  $: repeats = (it: Record<string, unknown>) => !!title && !!it.title && s(it.title).slice(0, 40) === title.text.slice(0, 40);
  $: itemName = (it: Record<string, unknown>) => (repeats(it) ? s(it.part || it.key) : s(it.title || it.name || it.part || it.key));
  $: itemSub = (it: Record<string, unknown>) => (it.key && s(it.key) !== itemName(it) ? s(it.key) : '');
  const itemState = (it: Record<string, unknown>) => s(it.state || it.status || it.stage);
  $: doneOf = (f: Field) => items(f).filter((it) => /done|closed|complete|merged/i.test(itemState(it))).length;

  function ago(iso: string): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
    const v = m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
    return en ? `${v} ago` : `hace ${v}`;
  }
  const when = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' }) : iso;
  };

  // ---- copy
  let copied = '';
  async function copy(text: string, id: string) {
    try { await navigator.clipboard.writeText(text); copied = id; setTimeout(() => { if (copied === id) copied = ''; }, 1400); } catch { /* no clipboard */ }
  }

  // ---- long texts fold past a few lines
  let unfolded = new Set<string>();
  const long = (t: string) => t.split('\n').length > 8 || t.length > 700;
  const toggleFold = (k: string) => { unfolded.has(k) ? unfolded.delete(k) : unfolded.add(k); unfolded = unfolded; };

  // ---- actions
  type Act = { id: string; a: PanelAction; verb: string; quick: boolean; disabled: boolean; hotkey: number };
  const verbOf = (a: PanelAction) => (a.key ?? '').split(':')[0] || '';
  /** Runs in one click: every input it requires is the record's key. */
  const isQuick = (a: PanelAction) => !!rowKey && (a.input?.required ?? []).every((r) => r === 'key') && Object.keys(a.input?.properties ?? {}).every((p) => p === 'key');
  $: acts = (view.actions ?? []).filter((id) => spec.actions?.[id]).map((id): Act => {
    const a = spec.actions![id];
    const verb = verbOf(a);
    return { id, a, verb, quick: isQuick(a), disabled: !!verb && off.has(verb), hotkey: 0 };
  });
  // The queue's moves together, then holding it, then unblocking it, then the rest; keys 1–9 in the order shown.
  const GROUP: Record<string, number> = { first: 0, up: 0, down: 0, last: 0, to: 0, pause: 1, resume: 1, unblock: 2 };
  $: groups = [0, 1, 2, 3].map((g) => acts.filter((x) => (GROUP[x.verb] ?? 3) === g)).filter((g) => g.length);
  $: groups.flat().forEach((x, i) => (x.hotkey = i < 9 ? i + 1 : 0));
  const GLYPH: Record<string, string> = {
    first: 'M6 5h12M12 19V9m-5 5 5-5 5 5', last: 'M6 19h12M12 5v10m-5-5 5 5 5-5',
    up: 'M12 19V5m-6 6 6-6 6 6', down: 'M12 5v14m-6-6 6 6 6-6',
    pause: 'M9 5v14M15 5v14', resume: 'M8 5l11 7-11 7z',
    unblock: 'M7 11V8a5 5 0 0 1 9.6-2M5 11h14v9H5z', to: 'M4 12h12m-4-5 5 5-5 5M20 5v14',
  };
  /** Holding and unblocking read by their verb alone ("Pausar este issue" → "Pausar"); the full label is the tooltip. */
  const shortLabel = (x: Act, label: string) => ((GROUP[x.verb] ?? 3) === 1 || (GROUP[x.verb] ?? 3) === 2 ? label.split(/\s+/)[0] : label);
  const actHue = (x: Act) => (x.verb === 'unblock' ? '#34D399' : x.verb === 'pause' ? '#FBBF24' : x.verb === 'resume' ? '#22D3EE' : GROUP[x.verb] === 0 ? '#A78BFA' : hueOf(x.id));

  let busy = '';
  let confirming = '';
  let toast: { ok: boolean; text: string } | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function say(ok: boolean, text: string) {
    toast = { ok, text };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), ok ? 3500 : 8000);
  }
  async function act(x: Act) {
    if (x.disabled || busy) return;
    if (!x.quick) { openAction = openAction === x.id ? null : x.id; return; }
    if (x.a.confirm && confirming !== x.id) { confirming = x.id; return; }
    confirming = '';
    busy = x.id;
    try {
      const r = await runAction(flowId, x.id, { key: rowKey });
      say(r.ok !== false, `${textOf(x.a.label, $locale)} · ${r.result || (en ? 'done' : 'listo')}`);
    } catch (e) {
      say(false, e instanceof Error ? e.message : String(e));
    } finally {
      busy = '';
      // The engine applies a queue command on its next tick: read the record again now and a moment later.
      if (!gone) poll();
      clearTimeout(again);
      again = setTimeout(() => { if (!gone) poll(); }, 6000);
    }
  }

  // ---- walking the list
  $: at = rowKey ? siblings.indexOf(rowKey) : -1;
  $: prevKey = at > 0 ? siblings[at - 1] : '';
  $: nextKey = at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : '';
  const go = (k: string) => { if (k) dispatch('open', k); };

  let root: HTMLElement;
  // ---- the stages, zoomed: every name, one above the line and the next below
  let zoom = false;
  $: if (polled) zoom = false;
  /** Mounts the zoomed view on <body>: the drawer around the panel clips and transforms what is inside it. */
  /** The current stage, scrolled to the middle when the track is wider than the card. */
  function centerIf(node: HTMLElement, on: boolean) {
    if (on) requestAnimationFrame(() => node.scrollIntoView({ inline: 'center', block: 'nearest' }));
  }
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  function onKey(e: KeyboardEvent) {
    if (!root?.isConnected || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (zoom) { if (e.key === 'Escape') { zoom = false; e.preventDefault(); e.stopPropagation(); } return; }
    if (e.key === 'Escape' && rowKey) { if (confirming) confirming = ''; else if (openAction) openAction = null; else dispatch('back'); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft' && prevKey) { go(prevKey); e.preventDefault(); return; }
    if (e.key === 'ArrowRight' && nextKey) { go(nextKey); e.preventDefault(); return; }
    const n = Number(e.key);
    if (n >= 1 && n <= 9) {
      const x = acts.find((y) => y.hotkey === n);
      if (x) { e.preventDefault(); void act(x); void tick(); }
    }
  }
</script>

<!-- Capture: Escape on the zoomed stages must reach here before the drawer around the panel closes. -->
<svelte:window on:keydown|capture={onKey} />

<div class="pd" bind:this={root}>
  <!-- Everything you act on stays in one block on top, pinned while the record scrolls under it. -->
  <div class="pd-top" class:pinned={!!rowKey}>
    {#if rowKey || headChips.length || flags.length || links.length}
      <div class="pd-line">
        {#if rowKey}
          <button class="pd-back" type="button" on:click={() => dispatch('back')} aria-label={en ? 'Back' : 'Volver'} title={en ? 'Back (Esc)' : 'Volver (Esc)'}>
            <Icon name="arrow-l" size={14} />
          </button>
          <button class="pd-key" type="button" on:click={() => copy(rowKey ?? '', '__key')} title={en ? 'Copy' : 'Copiar'}>
            <span>{rowKey}</span>{#if copied === '__key'}<Icon name="check" size={11} />{/if}
          </button>
        {/if}
        {#each headChips as f (f.key)}
          <span class="pd-chip" style="--tone:{tone(f.text)}" title={f.label}><i aria-hidden="true"></i>{chipText(f)}</span>
        {/each}
        {#each flags as f (f.key)}
          <span class="pd-chip pd-chip--flag" class:live={isLive(f.key)} style="--tone:{isLive(f.key) ? tone('working') : /held|paus|hold/i.test(f.key) ? '#FBBF24' : hueOf(f.key)}"><i aria-hidden="true"></i>{f.label}</span>
        {/each}
        {#each links as f (f.key)}
          <a class="pd-btnlink" href={hrefOf('url', f.text)} target="_blank" rel="noopener noreferrer" title={f.text} style="--hue:{hueOf(f.key)}">
            <Icon name="globe" size={12} />{f.label}<span aria-hidden="true">↗</span>
          </a>
        {/each}
        {#if rowKey && siblings.length > 1 && at >= 0}
          <div class="pd-walk">
            <button type="button" disabled={!prevKey} on:click={() => go(prevKey)} aria-label={en ? 'Previous' : 'Anterior'} title="←"><Icon name="arrow-l" size={12} /></button>
            <span>{at + 1}<small>/{siblings.length}</small></span>
            <button type="button" class="pd-next" disabled={!nextKey} on:click={() => go(nextKey)} aria-label={en ? 'Next' : 'Siguiente'} title="→"><Icon name="arrow-l" size={12} /></button>
          </div>
        {/if}
      </div>
    {/if}

    {#if title}<h3 class="pd-title" title={title.text}>{title.text}</h3>{/if}

    {#if (stageField && stageAt >= 0) || acts.length}
      <div class="pd-ctl">
        {#if stageField && stageAt >= 0}
          {@const order = view.order ?? []}
          <!-- The compact stepper opens its full, labelled view on click (or Enter/Space). -->
          <div class="pd-stage" style="--tone:{tone(stageField.text)}" role="button" tabindex="0"
            aria-label={`${stageField.label}: ${humanize(stageField.text)} (${stageAt + 1}/${order.length}). ${en ? 'Show every stage' : 'Ver todas las etapas'}`}
            title={en ? 'Show every stage' : 'Ver todas las etapas'}
            on:click={() => (zoom = true)} on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); zoom = true; } }}>
            <span class="pd-stage-now"><i aria-hidden="true"></i>{humanize(stageField.text)}<small>{stageAt + 1}/{order.length}</small></span>
            <ol class="pd-steps" aria-hidden="true">
              {#each order as st, i (st)}
                <li class:past={i < stageAt} class:now={i === stageAt} style="--tone:{tone(st)}"><i></i></li>
              {/each}
            </ol>
            <span class="pd-stage-zoom" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2M11 8.5v5M8.5 11h5" /></svg>
            </span>
          </div>
          {#if zoom}
            <div class="pd-zoom" use:portal role="presentation" on:click|self={() => (zoom = false)}>
              <div class="pd-zoom-card" role="dialog" aria-modal="true" aria-label={stageField.label} style="--n:{order.length}">
                <header class="pd-zoom-head">
                  <h4>{stageField.label}</h4>
                  <span class="pd-stage-now" style="--tone:{tone(stageField.text)}"><i aria-hidden="true"></i>{humanize(stageField.text)}<small>{stageAt + 1}/{order.length}</small></span>
                  <button type="button" class="pd-zoom-x" on:click={() => (zoom = false)} aria-label={en ? 'Close' : 'Cerrar'} title={en ? 'Close (Esc)' : 'Cerrar (Esc)'}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
                  </button>
                </header>
                <div class="pd-zoom-scroll">
                  <ol class="pd-zoom-steps">
                    {#each order as st, i (st)}
                      <li class:past={i < stageAt} class:now={i === stageAt} class:up={i % 2 === 0} style="--tone:{tone(st)}" use:centerIf={i === stageAt}>
                        <span class="pd-zl" title={humanize(st)}><b>{i + 1}</b>{humanize(st)}</span>
                        <i aria-hidden="true">{#if i < stageAt}<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>{/if}</i>
                      </li>
                    {/each}
                  </ol>
                </div>
                <footer class="pd-zoom-legend">
                  <span><i class="lg-past"></i>{en ? 'Done' : 'Hecha'}</span>
                  <span><i class="lg-now" style="--tone:{tone(stageField.text)}"></i>{en ? 'Now' : 'Ahora'}</span>
                  <span><i class="lg-next"></i>{en ? 'Next' : 'Pendiente'}</span>
                </footer>
              </div>
            </div>
          {/if}
        {/if}

        {#if acts.length}
          <div class="pd-bar-acts" role="toolbar" aria-label={en ? 'Actions' : 'Acciones'}>
            {#each groups as g, gi (gi)}
              <div class="pd-grp">
                {#each g as x (x.id)}
                  {@const label = textOf(x.a.label, $locale)}
                  <button type="button" class="pd-act" class:icon={GROUP[x.verb] === 0 && confirming !== x.id} class:on={openAction === x.id} class:ask={confirming === x.id} class:busy={busy === x.id}
                    disabled={x.disabled || (!!busy && busy !== x.id)} style="--hue:{actHue(x)}" on:click={() => act(x)}
                    aria-label={label} aria-keyshortcuts={x.hotkey ? String(x.hotkey) : undefined}
                    title={x.disabled ? `${label} · ${en ? 'does nothing on this one now' : 'no aplica ahora'}` : x.hotkey ? `${label} (${x.hotkey})` : label}>
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d={GLYPH[x.verb] ?? 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z'} /></svg>
                    <span class="pd-act-l">{confirming === x.id ? textOf(x.a.confirm, $locale) || (en ? 'Sure?' : '¿Seguro?') : shortLabel(x, label)}</span>
                    {#if x.hotkey && !x.disabled}<kbd aria-hidden="true">{x.hotkey}</kbd>{/if}
                  </button>
                {/each}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if toast}
      <p class="pd-toast" class:ok={toast.ok} role="status"><Icon name={toast.ok ? 'check' : 'alert'} size={13} />{toast.text}</p>
    {/if}
    {#if openAction && spec.actions?.[openAction]}
      <div class="pd-form">
        {#key `${rowKey}:${openAction}`}<PanelForm {flowId} actionId={openAction} action={spec.actions[openAction]} preset={rowKey ? { key: rowKey } : {}} />{/key}
      </div>
    {/if}
  </div>

  {#if error}<p class="pd-err" role="alert">{error}</p>{/if}
  {#if !row && !error}<div class="pd-skel" aria-hidden="true"><span></span><span></span><span></span></div>{/if}
  <div class="pd-grid" class:solo={!numbers.length && !plain.length && !tags.length && !contact.length}>
    <div class="pd-main">
      {#each alerts as f (f.key)}
        {@const folded = long(f.text) && !unfolded.has(f.key)}
        <section class="pd-card pd-alert" style="--hue:{alertTone(f.key)}">
          <h4 class="pd-h">
            <Icon name={/error|fail/i.test(f.key) ? 'alert' : 'help'} size={13} />{f.label}
            <button type="button" class="pd-mini" on:click={() => copy(f.text, f.key)}>{copied === f.key ? (en ? 'Copied' : 'Copiado') : (en ? 'Copy' : 'Copiar')}</button>
          </h4>
          <pre class:folded>{f.text}</pre>
          {#if long(f.text)}<button type="button" class="pd-more" on:click={() => toggleFold(f.key)}>{folded ? (en ? 'Show all' : 'Ver todo') : (en ? 'Show less' : 'Ver menos')}</button>{/if}
        </section>
      {/each}

      {#each lists as f (f.key)}
        {@const done = doneOf(f)}
        <section class="pd-card">
          <h4 class="pd-h">{f.label}<span class="pd-h-n">{done}/{items(f).length}</span></h4>
          <div class="pd-prog" aria-hidden="true"><span style="width:{(done / Math.max(1, items(f).length)) * 100}%"></span></div>
          <ul class="pd-list">
            {#each items(f) as it, i (s(it.key) || i)}
              {@const st = itemState(it)}
              <li>
                <svelte:element this={it.key && rowKey ? 'button' : 'div'} type={it.key && rowKey ? 'button' : undefined} class="pd-li"
                  on:click={() => it.key && rowKey && go(s(it.key))} role={it.key && rowKey ? undefined : 'group'}>
                  <span class="pd-li-dot" class:live={s(it.working) === 'yes'} style="--tone:{tone(st)}"></span>
                  <span class="pd-li-txt"><b>{itemName(it)}</b>{#if itemSub(it)}<small>{itemSub(it)}</small>{/if}</span>
                  {#if st}<span class="pd-chip pd-chip--sm" style="--tone:{tone(st)}">{humanize(st)}</span>{/if}
                  {#if it.waiting}<span class="pd-li-t"><Icon name="clock" size={11} />{s(it.waiting)}</span>{/if}
                  {#if it.key && rowKey}<span class="pd-li-go" aria-hidden="true">›</span>{/if}
                </svelte:element>
              </li>
            {/each}
          </ul>
        </section>
      {/each}

      {#each breakdowns as f (f.key)}
        {@const total = sum(f)}
        <section class="pd-card">
          <h4 class="pd-h">{f.label}<span class="pd-h-n">{total.toLocaleString(lang)}</span></h4>
          <div class="pd-bar" role="img" aria-label={parts(f).map(([k, n]) => `${k}: ${n}`).join(', ')}>
            {#each parts(f) as [k, n] (k)}
              {#if n > 0}<span style="flex:{n};--tone:{tone(k)}" title="{k}: {n}"></span>{/if}
            {/each}
            {#if total === 0}<span class="pd-bar-empty"></span>{/if}
          </div>
          <div class="pd-legend">
            {#each parts(f) as [k, n] (k)}
              <span class="pd-leg" class:pd-leg--zero={n === 0} style="--tone:{tone(k)}"><i aria-hidden="true"></i>{humanize(k)}<b>{n.toLocaleString(lang)}</b></span>
            {/each}
          </div>
        </section>
      {/each}

      {#each notes as f (f.key)}
        {@const folded = long(f.text) && !unfolded.has(f.key)}
        <section class="pd-card pd-note" style="--hue:{hueOf(f.key)}">
          <h4 class="pd-h">{f.label}</h4>
          <p class:folded>{f.text}</p>
          {#if long(f.text)}<button type="button" class="pd-more" on:click={() => toggleFold(f.key)}>{folded ? (en ? 'Show all' : 'Ver todo') : (en ? 'Show less' : 'Ver menos')}</button>{/if}
        </section>
      {/each}

      {#each histories as f (f.key)}
        <section class="pd-card">
          <h4 class="pd-h">{f.label}<span class="pd-h-n">{items(f).length}</span></h4>
          <ol class="pd-hist">
            {#each items(f) as it, i (i)}
              {@const k = s(it.kind || it.type)}
              <li style="--tone:{tone(k || 'x')}">
                <i aria-hidden="true"></i>
                <div>
                  <p>{#if k}<span class="pd-hk">{humanize(k)}</span>{/if}{s(it.text || it.summary || it.title)}</p>
                  <time datetime={s(it.at)} title={when(s(it.at))}>{ago(s(it.at))}</time>
                </div>
              </li>
            {/each}
          </ol>
        </section>
      {/each}

      {#each objects as f (f.key)}
        <section class="pd-card">
          <h4 class="pd-h">{f.label}</h4>
          <div class="pd-json">{@html jsonHtml(f.value)}</div>
        </section>
      {/each}
    </div>

    {#if numbers.length || plain.length || tags.length || contact.length}
      <aside class="pd-side">
        {#if numbers.length}
          <div class="pd-kpis">
            {#each numbers as f (f.key)}
              {@const n = Number(f.text)}
              <div class="pd-kpi" class:zero={n === 0} style="--hue:{numHue(f)}">
                <span class="pd-kpi-k">{f.label}</span>
                <span class="pd-kpi-v">{fmtNum(f)}{#if f.kind === 'percent'}<small>%</small>{/if}{#if ofTotals[f.key]}<small> / {ofTotals[f.key].toLocaleString(lang)}</small>{/if}</span>
              </div>
            {/each}
          </div>
        {/if}

        {#if contact.length}
          <div class="pd-contact">
            {#each contact as f (f.key)}
              <a class="pd-link pd-link--{f.kind}" href={hrefOf(f.kind === "email" ? "email" : "phone", f.text)} title={f.label}>
                <span class="pd-link-ic"><Icon name={f.kind === 'email' ? 'mail' : 'phone'} size={14} /></span>
                <span class="pd-link-v">{f.text}</span>
              </a>
            {/each}
          </div>
        {/if}

        {#if plain.length}
          <dl class="pd-facts">
            {#each plain as f (f.key)}
              <div class="pd-fact" style="--hue:{hueOf(f.key)}">
                <dt>{#if /alta|created|fecha|date|proximo|next|when|wait|espera|age|antig/i.test(f.key)}<Icon name="clock" size={11} />{/if}{f.label}</dt>
                <dd>
                  {#if rowKey && f.text !== rowKey && siblings.includes(f.text)}
                    <button type="button" class="pd-go mono" on:click={() => go(f.text)}>{f.text} ›</button>
                  {:else}
                    <span class:mono={code(f.text)}>{f.text}</span>
                  {/if}
                  <button type="button" class="pd-cp" on:click={() => copy(f.text, f.key)} aria-label={en ? `Copy ${f.label}` : `Copiar ${f.label}`}>
                    {#if copied === f.key}<Icon name="check" size={11} />{:else}<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></svg>{/if}
                  </button>
                </dd>
              </div>
            {/each}
          </dl>
        {/if}

        {#each tags as f (f.key)}
          <div class="pd-tags">
            <span class="pd-tags-k">{f.label}</span>
            <div>
              {#each strs(f) as t (t)}
                {#if rowKey && siblings.includes(t)}
                  <button type="button" class="pd-tag pd-tag--go" style="--tone:{hueOf(t)}" on:click={() => go(t)}>{t} ›</button>
                {:else}
                  <span class="pd-tag" style="--tone:{tone(t.split('::').pop() ?? t)}">{t}</span>
                {/if}
              {/each}
            </div>
          </div>
        {/each}
      </aside>
    {/if}
  </div>
</div>

<style>
  .pd { display: flex; flex-direction: column; gap: 10px; font-family: 'Manrope', sans-serif; container-type: inline-size; }

  /* ---- the command block: one line of identity, the title, one line of control. Pinned on an opened record. */
  .pd-top { display: flex; flex-direction: column; gap: 7px; }
  .pd-top.pinned {
    position: sticky; top: -4px; z-index: 4; margin: -4px -6px 0; padding: 6px 6px 9px;
    background: color-mix(in srgb, var(--surface-1) 94%, transparent); backdrop-filter: blur(10px);
    border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  }
  .pd-line { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .pd-back {
    flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; cursor: pointer;
    color: #22D3EE; background: color-mix(in srgb, #22D3EE 12%, var(--surface-2)); border: 1px solid color-mix(in srgb, #22D3EE 40%, var(--border));
    transition: transform .2s ease-out, box-shadow .2s, background .2s;
  }
  .pd-back:hover { transform: translateX(-2px); background: color-mix(in srgb, #22D3EE 22%, var(--surface-2)); box-shadow: 0 8px 18px -12px #22D3EE; }
  .pd-key {
    display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border-radius: 7px; cursor: copy;
    font: 700 11.5px ui-monospace, 'JetBrains Mono', monospace; color: var(--text-1);
    background: var(--surface-2); border: 1px solid var(--border);
  }
  .pd-key :global(svg) { color: #34D399; }
  .pd-key:hover { border-color: color-mix(in srgb, #22D3EE 50%, var(--border)); }
  .pd-walk { margin-left: auto; display: inline-flex; align-items: center; gap: 1px; padding: 1px; border-radius: 8px; background: color-mix(in srgb, var(--surface-1) 70%, #000); border: 1px solid var(--border); }
  .pd-walk span { padding: 0 5px; font: 800 11.5px 'Manrope', sans-serif; color: var(--text-1); font-variant-numeric: tabular-nums; }
  .pd-walk small { color: var(--text-3, var(--text-2)); font-weight: 600; }
  .pd-walk button { display: grid; place-items: center; width: 24px; height: 22px; border: 0; border-radius: 6px; cursor: pointer; background: transparent; color: var(--text-2); }
  .pd-walk button:hover:not(:disabled) { background: var(--surface-2); color: var(--text-1); }
  .pd-walk button:disabled { opacity: .3; cursor: default; }
  .pd-walk .pd-next :global(svg) { transform: scaleX(-1); }
  .pd-back:focus-visible, .pd-key:focus-visible, .pd-walk button:focus-visible { outline: 2px solid #22D3EE; outline-offset: 2px; }

  .pd-title {
    margin: 0; font: 800 15.5px/1.3 var(--font-display, 'Manrope'), sans-serif; color: var(--text-1); overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .pd-chips, .pd-links { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .pd-chip {
    display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px; white-space: nowrap;
    font: 800 9.5px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .05em;
    color: color-mix(in srgb, var(--tone) 70%, white); background: color-mix(in srgb, var(--tone) 18%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 45%, transparent);
  }
  .pd-chip i { width: 6px; height: 6px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 8px var(--tone); }
  .pd-chip--flag { text-transform: none; letter-spacing: 0; font-size: 11px; font-weight: 700; }
  .pd-chip--flag.live i { animation: pd-pulse 1.4s ease-in-out infinite; }
  .pd-chip--sm { height: 18px; padding: 0 7px; font-size: 9px; }
  @keyframes pd-pulse { 50% { opacity: .35; } }
  .pd-btnlink {
    display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 7px; text-decoration: none;
    font: 700 11px 'Manrope', sans-serif; color: var(--text-1);
    background: color-mix(in srgb, var(--hue) 12%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--hue) 38%, var(--border)); transition: border-color .2s, box-shadow .2s;
  }
  .pd-btnlink :global(svg), .pd-btnlink span { color: var(--hue); }
  .pd-btnlink:hover { border-color: var(--hue); box-shadow: 0 8px 18px -12px var(--hue); }
  .pd-btnlink:focus-visible { outline: 2px solid var(--hue); outline-offset: 2px; }

  /* ---- control line: where it is in its stages, and what you can do to it */
  .pd-ctl { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; }
  .pd-stage {
    flex: 1 1 240px; min-width: 0; display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 6px 0 4px;
    border-radius: 11px; background: color-mix(in srgb, var(--surface-1) 70%, #000); border: 1px solid var(--border);
    cursor: zoom-in; transition: border-color .15s, box-shadow .15s, background .15s;
  }
  .pd-stage:hover { border-color: color-mix(in srgb, #22D3EE 45%, var(--border)); background: color-mix(in srgb, #22D3EE 5%, color-mix(in srgb, var(--surface-1) 70%, #000)); box-shadow: 0 8px 20px -14px #22D3EE; }
  .pd-stage:focus-visible { outline: 2px solid #22D3EE; outline-offset: 2px; }
  .pd-stage-zoom {
    flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; color: var(--text-3, var(--text-2));
    transition: color .15s, background .15s, transform .15s;
  }
  .pd-stage:hover .pd-stage-zoom, .pd-stage:focus-visible .pd-stage-zoom { color: #22D3EE; background: color-mix(in srgb, #22D3EE 16%, transparent); transform: scale(1.08); }
  .pd-stage-now {
    flex: none; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px; border-radius: 8px; white-space: nowrap;
    font: 800 10px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .05em;
    color: color-mix(in srgb, var(--tone) 72%, white); background: color-mix(in srgb, var(--tone) 18%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 45%, transparent);
  }
  .pd-stage-now i { width: 7px; height: 7px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 8px var(--tone); }
  .pd-stage-now small { font-size: 10px; font-weight: 700; letter-spacing: 0; color: var(--text-3, var(--text-2)); }
  .pd-steps { list-style: none; margin: 0; padding: 0; flex: 1; min-width: 0; display: flex; align-items: center; }
  .pd-steps li { position: relative; flex: 1 1 0; min-width: 7px; height: 14px; display: grid; place-items: center; }
  .pd-steps li::before { content: ''; position: absolute; top: 6px; right: 50%; width: 100%; height: 2px; background: var(--border); }
  .pd-steps li:first-child::before { display: none; }
  .pd-steps li.past::before, .pd-steps li.now::before { background: linear-gradient(90deg, color-mix(in srgb, #22D3EE 60%, transparent), color-mix(in srgb, #A78BFA 60%, transparent)); }
  .pd-steps i { position: relative; z-index: 1; width: 8px; height: 8px; border-radius: 50%; background: var(--surface-2); border: 1.5px solid var(--border); transition: transform .15s; }
  .pd-steps li.past i { background: color-mix(in srgb, #22D3EE 60%, var(--surface-2)); border-color: transparent; }
  .pd-steps li.now i { width: 11px; height: 11px; background: var(--tone); border-color: color-mix(in srgb, var(--tone) 50%, white); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 22%, transparent), 0 0 10px var(--tone); }

  /* ---- action bar: the queue moves as icons, holding and unblocking with their verb; keys 1–9 as tiny badges */
  .pd-bar-acts { flex: 0 1 auto; display: flex; flex-wrap: wrap; gap: 6px; }
  .pd-grp { display: inline-flex; gap: 1px; padding: 2px; border-radius: 11px; background: color-mix(in srgb, var(--surface-1) 70%, #000); border: 1px solid var(--border); box-shadow: inset 0 1px 2px rgba(0, 0, 0, .35); }
  .pd-act {
    position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; min-width: 32px; padding: 0 10px; border: 0; border-radius: 8px; cursor: pointer; white-space: nowrap;
    font: 700 12px 'Manrope', sans-serif; color: var(--text-1); background: transparent;
    transition: background .15s, box-shadow .15s, color .15s;
  }
  .pd-act.icon { padding: 0; width: 32px; }
  .pd-act.icon .pd-act-l { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .pd-act svg { color: var(--hue); flex: none; }
  .pd-act kbd {
    display: grid; place-items: center; min-width: 14px; height: 14px; padding: 0 2px; border-radius: 4px;
    font: 700 9px ui-monospace, monospace; color: var(--text-3, var(--text-2)); background: var(--surface-2); border: 1px solid var(--border);
  }
  .pd-act.icon kbd { position: absolute; right: 1px; bottom: 1px; min-width: 11px; height: 11px; font-size: 8px; border-radius: 3px; opacity: .85; }
  .pd-act:hover:not(:disabled), .pd-act.on {
    background: linear-gradient(180deg, color-mix(in srgb, var(--hue) 22%, var(--surface-2)), color-mix(in srgb, var(--hue) 10%, var(--surface-2)));
    box-shadow: 0 1px 0 rgba(255, 255, 255, .06) inset, inset 0 -2px 0 var(--hue);
  }
  .pd-act.ask { background: color-mix(in srgb, #F43F5E 22%, var(--surface-2)); box-shadow: inset 0 -2px 0 #F43F5E; }
  .pd-act.busy svg { animation: pd-spin .8s linear infinite; }
  .pd-act:disabled { opacity: .3; cursor: not-allowed; }
  .pd-act:focus-visible { outline: 2px solid var(--hue); outline-offset: 1px; }
  @keyframes pd-spin { to { transform: rotate(360deg); } }
  .pd-toast {
    margin: 0; display: flex; align-items: center; gap: 7px; padding: 6px 10px; border-radius: 9px; font: 600 12px 'Manrope', sans-serif;
    color: #ff9fb5; background: color-mix(in srgb, #F43F5E 12%, transparent); border: 1px solid color-mix(in srgb, #F43F5E 35%, transparent);
    animation: pd-in .2s ease-out;
  }
  .pd-toast.ok { color: #34D399; background: color-mix(in srgb, #34D399 12%, transparent); border-color: color-mix(in srgb, #34D399 35%, transparent); }
  .pd-form { max-height: 46vh; overflow-y: auto; }
  @keyframes pd-in { from { opacity: 0; transform: translateY(-3px); } }

  /* ---- body: main column, side column */
  .pd-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; align-items: start; }
  /* The side column (numbers, facts, labels) sits beside the work from a mid width on, not under it. */
  @container (min-width: 600px) { .pd-grid:not(.solo) { grid-template-columns: minmax(0, 1fr) minmax(210px, 280px); } .pd-side { order: 2; } }
  .pd-main, .pd-side { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .pd-main:empty { display: none; }

  .pd-card { display: flex; flex-direction: column; gap: 7px; padding: 9px 11px; border-radius: 12px; background: var(--surface-1); border: 1px solid var(--border); min-width: 0; }
  .pd-h { margin: 0; display: flex; align-items: center; gap: 7px; font: 800 10.5px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .06em; color: var(--text-2); }
  .pd-h::before { content: ''; width: 3px; height: 11px; border-radius: 2px; background: linear-gradient(#22D3EE, #A78BFA); flex: none; }
  .pd-h-n { margin-left: auto; font-size: 12px; color: var(--text-1); }
  .pd-mini { margin-left: auto; height: 22px; padding: 0 8px; border-radius: 6px; cursor: pointer; font: 700 10.5px 'Manrope', sans-serif; text-transform: none; letter-spacing: 0; color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border); }
  .pd-mini:hover { color: var(--text-1); }
  .pd-more { align-self: flex-start; padding: 0; border: 0; background: none; cursor: pointer; font: 700 11.5px 'Manrope', sans-serif; color: #22D3EE; }

  .pd-alert { background: linear-gradient(160deg, color-mix(in srgb, var(--hue) 13%, var(--surface-1)), var(--surface-1) 65%); border-color: color-mix(in srgb, var(--hue) 40%, var(--border)); }
  .pd-alert .pd-h { color: color-mix(in srgb, var(--hue) 75%, white); }
  .pd-alert .pd-h::before { background: var(--hue); }
  .pd-alert pre { margin: 0; font: 500 12px/1.55 ui-monospace, 'JetBrains Mono', monospace; color: var(--text-1); white-space: pre-wrap; overflow-wrap: anywhere; }
  .folded { max-height: 6.4em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }

  .pd-note { background: linear-gradient(160deg, color-mix(in srgb, var(--hue) 9%, var(--surface-1)), var(--surface-1) 60%); border-color: color-mix(in srgb, var(--hue) 26%, var(--border)); }
  .pd-note p { margin: 0; font: 500 13px/1.6 'Manrope', sans-serif; color: var(--text-1); white-space: pre-wrap; }
  .pd-json { font-size: 12px; overflow-x: auto; }

  /* ---- a list of records (parts) */
  .pd-prog { height: 5px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
  .pd-prog span { display: block; height: 100%; background: linear-gradient(90deg, #22D3EE, #34D399); box-shadow: 0 0 10px -2px #34D399; }
  .pd-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
  .pd-li {
    width: 100%; display: flex; align-items: center; gap: 8px; padding: 5px 9px; border-radius: 8px; text-align: left;
    font: inherit; color: var(--text-1); background: var(--surface-2); border: 1px solid transparent;
  }
  button.pd-li { cursor: pointer; transition: border-color .15s, background .15s; }
  button.pd-li:hover { border-color: color-mix(in srgb, #22D3EE 45%, var(--border)); background: color-mix(in srgb, #22D3EE 7%, var(--surface-2)); }
  button.pd-li:focus-visible { outline: 2px solid #22D3EE; outline-offset: 1px; }
  .pd-li-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 8px var(--tone); }
  .pd-li-dot.live { animation: pd-pulse 1.4s ease-in-out infinite; }
  .pd-li-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .pd-li-txt b { font: 700 12.5px 'Manrope', sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pd-li-txt small { font: 600 10.5px ui-monospace, monospace; color: var(--text-3, var(--text-2)); }
  .pd-li-t { display: inline-flex; align-items: center; gap: 4px; font: 600 11px 'Manrope', sans-serif; color: var(--text-2); white-space: nowrap; }
  .pd-li-go { color: var(--text-3, var(--text-2)); font-size: 16px; }

  /* ---- history */
  .pd-hist { list-style: none; margin: 0; padding: 0 0 0 4px; display: flex; flex-direction: column; max-height: 300px; overflow-y: auto; scrollbar-width: thin; }
  .pd-hist li { position: relative; display: flex; gap: 10px; padding: 0 0 10px; }
  .pd-hist li::before { content: ''; position: absolute; left: 4px; top: 12px; bottom: 0; width: 1px; background: var(--border); }
  .pd-hist li:last-child::before { display: none; }
  .pd-hist i { flex: none; width: 9px; height: 9px; margin-top: 4px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 7px var(--tone); }
  .pd-hist div { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .pd-hist p { margin: 0; font: 500 12.5px/1.45 'Manrope', sans-serif; color: var(--text-1); overflow-wrap: anywhere; }
  .pd-hk { display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: 5px; font: 800 9.5px/16px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .04em; color: color-mix(in srgb, var(--tone) 70%, white); background: color-mix(in srgb, var(--tone) 16%, transparent); }
  .pd-hist time { font: 600 10.5px 'Manrope', sans-serif; color: var(--text-3, var(--text-2)); }

  /* ---- side: numbers, facts, tags */
  .pd-kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; }
  .pd-kpi {
    display: flex; flex-direction: column; gap: 1px; padding: 7px 10px; border-radius: 10px; min-width: 0;
    background: linear-gradient(160deg, color-mix(in srgb, var(--hue) 14%, var(--surface-1)), var(--surface-1) 70%);
    border: 1px solid color-mix(in srgb, var(--hue) 32%, var(--border));
  }
  .pd-kpi.zero { opacity: .55; }
  .pd-kpi-k { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: var(--hue); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pd-kpi-v { font: 800 19px/1.15 'Manrope', sans-serif; color: var(--text-1); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pd-kpi-v small { font-size: 11.5px; font-weight: 700; color: var(--text-3, var(--text-2)); }

  .pd-facts { margin: 0; display: flex; flex-direction: column; border-radius: 12px; background: var(--surface-1); border: 1px solid var(--border); overflow: hidden; }
  .pd-fact { display: grid; grid-template-columns: minmax(84px, 38%) minmax(0, 1fr); align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
  .pd-fact:first-child { border-top: 0; }
  .pd-fact dt { display: flex; align-items: center; gap: 4px; font: 800 9.5px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .05em; color: var(--hue); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pd-fact dd { margin: 0; display: flex; align-items: center; gap: 4px; min-width: 0; }
  .pd-fact dd span { flex: 1; min-width: 0; font: 600 12.5px/1.35 'Manrope', sans-serif; color: var(--text-1); overflow-wrap: anywhere; }
  .pd-fact dd span.mono { font: 600 11.5px/1.35 ui-monospace, 'JetBrains Mono', monospace; }
  .pd-go { flex: 1; min-width: 0; padding: 0; border: 0; background: none; cursor: pointer; text-align: left; font: 700 11.5px ui-monospace, monospace; color: #22D3EE; }
  .pd-go:hover { text-decoration: underline; }
  .pd-cp { flex: none; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; cursor: pointer; border: 0; background: transparent; color: var(--text-3, var(--text-2)); opacity: 0; transition: opacity .15s, background .15s; }
  .pd-fact:hover .pd-cp, .pd-cp:focus-visible { opacity: 1; }
  .pd-cp:hover { background: var(--surface-2); color: var(--text-1); }

  .pd-tags { display: flex; flex-direction: column; gap: 5px; padding: 9px 10px; border-radius: 12px; background: var(--surface-1); border: 1px solid var(--border); }
  .pd-tags-k { font: 800 9.5px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .05em; color: var(--text-2); }
  .pd-tags div { display: flex; flex-wrap: wrap; gap: 5px; }
  .pd-tag { padding: 2px 8px; border-radius: 6px; font: 700 11px 'Manrope', sans-serif; color: color-mix(in srgb, var(--tone) 70%, white); background: color-mix(in srgb, var(--tone) 14%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 35%, transparent); }
  button.pd-tag--go { cursor: pointer; font-family: ui-monospace, monospace; }
  button.pd-tag--go:hover { border-color: var(--tone); }

  .pd-contact { display: flex; flex-wrap: wrap; gap: 6px; }
  .pd-link {
    --c: #22D3EE;
    display: inline-flex; align-items: center; gap: 8px; min-height: 34px; padding: 3px 12px 3px 3px; border-radius: 10px; text-decoration: none; min-width: 0;
    background: linear-gradient(160deg, color-mix(in srgb, var(--c) 14%, var(--surface-1)), var(--surface-1) 75%);
    border: 1px solid color-mix(in srgb, var(--c) 34%, var(--border)); color: var(--text-1);
  }
  .pd-link--phone { --c: #34D399; }
  .pd-link-ic { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: var(--c); background: color-mix(in srgb, var(--c) 20%, transparent); flex: none; }
  .pd-link-v { font: 600 12.5px 'Manrope', sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ---- breakdown bar */
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


  /* ---- the stages, zoomed: a wide track, names alternating above and below so every one reads in full */
  .pd-zoom {
    position: fixed; inset: 0; z-index: 1000; display: grid; grid-template-columns: minmax(0, 1fr); place-items: center; padding: 24px 16px;
    background: rgba(3, 6, 12, .62); backdrop-filter: blur(6px); animation: pd-fade .16s ease-out;
  }
  .pd-zoom-card {
    width: min(calc(var(--n) * 66px + 100px), 1240px, 100%); min-width: 0; max-height: calc(100vh - 48px); display: flex; flex-direction: column; gap: 14px;
    padding: 16px 18px 14px; border-radius: 16px; font-family: 'Manrope', sans-serif;
    background: linear-gradient(170deg, color-mix(in srgb, #22D3EE 6%, var(--surface-1)), var(--surface-1) 40%);
    border: 1px solid color-mix(in srgb, #22D3EE 22%, var(--border)); box-shadow: 0 30px 80px -30px rgba(0, 0, 0, .9);
    animation: pd-pop .2s cubic-bezier(.2, .9, .3, 1.2);
  }
  .pd-zoom-head { display: flex; align-items: center; gap: 10px; }
  .pd-zoom-head h4 { margin: 0; font: 800 11px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .07em; color: var(--text-2); display: flex; align-items: center; gap: 7px; }
  .pd-zoom-head h4::before { content: ''; width: 3px; height: 12px; border-radius: 2px; background: linear-gradient(#22D3EE, #A78BFA); }
  .pd-zoom-x {
    margin-left: auto; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; cursor: pointer;
    color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border); transition: color .15s, border-color .15s;
  }
  .pd-zoom-x:hover { color: var(--text-1); border-color: color-mix(in srgb, #F43F5E 50%, var(--border)); }
  .pd-zoom-x:focus-visible { outline: 2px solid #22D3EE; outline-offset: 2px; }
  .pd-zoom-scroll { overflow-x: auto; overflow-y: hidden; padding: 4px 0 8px; scrollbar-width: thin; }
  .pd-zoom-steps { list-style: none; margin: 0; padding: 0 22px; display: grid; grid-template-columns: repeat(var(--n), minmax(64px, 1fr)); min-width: calc(var(--n) * 64px); }
  .pd-zoom-steps li { position: relative; height: 128px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; }
  .pd-zoom-steps li.up { justify-content: flex-start; }
  /* the track, through the middle of every column */
  .pd-zoom-steps li::before { content: ''; position: absolute; top: 63px; left: 0; right: 0; height: 2px; background: var(--border); }
  .pd-zoom-steps li:first-child::before { left: 50%; }
  .pd-zoom-steps li:last-child::before { right: 50%; }
  .pd-zoom-steps li.past::before { background: linear-gradient(90deg, #22D3EE, #A78BFA); }
  .pd-zoom-steps li.now::before { background: linear-gradient(90deg, #A78BFA 50%, var(--border) 50%); }
  .pd-zoom-steps i {
    position: absolute; top: 56px; left: 50%; z-index: 1; width: 16px; height: 16px; margin-left: -8px; border-radius: 50%;
    display: grid; place-items: center; color: #04121a; background: var(--surface-2); border: 2px solid var(--border);
  }
  .pd-zoom-steps li.past i { background: #22D3EE; border-color: color-mix(in srgb, #22D3EE 60%, white); }
  .pd-zoom-steps li.now i {
    top: 52px; width: 24px; height: 24px; margin-left: -12px; background: var(--tone); border: 3px solid color-mix(in srgb, var(--tone) 45%, white);
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--tone) 20%, transparent), 0 0 22px var(--tone); animation: pd-glow 2s ease-in-out infinite;
  }
  /* a stem joins each name to its dot */
  .pd-zoom-steps li::after { content: ''; position: absolute; left: 50%; width: 1px; background: color-mix(in srgb, var(--border) 80%, transparent); }
  .pd-zoom-steps li.up::after { top: 32px; height: 22px; }
  .pd-zoom-steps li:not(.up)::after { top: 74px; height: 22px; }
  .pd-zoom-steps li.now::after { background: var(--tone); }
  .pd-zl {
    position: relative; z-index: 1; max-width: 134px; overflow: hidden; text-overflow: ellipsis; display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 8px; white-space: nowrap;
    font: 700 11.5px 'Manrope', sans-serif; color: var(--text-3, var(--text-2)); background: var(--surface-2); border: 1px solid var(--border);
  }
  .pd-zl b { display: grid; place-items: center; min-width: 16px; height: 16px; padding: 0 3px; border-radius: 5px; font: 800 9.5px ui-monospace, monospace; color: var(--text-3, var(--text-2)); background: color-mix(in srgb, var(--surface-1) 70%, #000); }
  .pd-zoom-steps li.past .pd-zl { color: var(--text-1); border-color: color-mix(in srgb, #22D3EE 30%, var(--border)); }
  .pd-zoom-steps li.past .pd-zl b { color: #22D3EE; }
  .pd-zoom-steps li.now .pd-zl {
    font-weight: 800; color: color-mix(in srgb, var(--tone) 75%, white); background: color-mix(in srgb, var(--tone) 18%, var(--surface-2));
    border-color: color-mix(in srgb, var(--tone) 60%, transparent); box-shadow: 0 8px 22px -12px var(--tone);
  }
  .pd-zoom-steps li.now .pd-zl b { color: #04121a; background: var(--tone); }
  .pd-zoom-legend { display: flex; justify-content: center; gap: 18px; font: 600 11px 'Manrope', sans-serif; color: var(--text-3, var(--text-2)); }
  .pd-zoom-legend span { display: inline-flex; align-items: center; gap: 6px; }
  .pd-zoom-legend i { width: 9px; height: 9px; border-radius: 50%; }
  .lg-past { background: #22D3EE; }
  .lg-now { background: var(--tone); box-shadow: 0 0 8px var(--tone); }
  .lg-next { background: var(--surface-2); border: 1.5px solid var(--border); }
  @keyframes pd-fade { from { opacity: 0; } }
  @keyframes pd-pop { from { opacity: 0; transform: scale(.94) translateY(6px); } }
  @keyframes pd-glow { 50% { box-shadow: 0 0 0 9px color-mix(in srgb, var(--tone) 12%, transparent), 0 0 26px var(--tone); } }

  @media (prefers-reduced-motion: reduce) {
    .pd-back, .pd-btnlink, .pd-act, .pd-steps i, .pd-cp, button.pd-li { transition: none; }
    .pd-back:hover, .pd-steps li:hover i { transform: none; }
    .pd-skel span, .pd-chip--flag.live i, .pd-li-dot.live, .pd-act.busy svg, .pd-toast, .pd-zoom, .pd-zoom-card, .pd-zoom-steps li.now i { animation: none; }
    .pd-stage, .pd-stage-zoom { transition: none; }
  }
</style>
