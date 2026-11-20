<script lang="ts" context="module">
  export interface WorkingItem {
    id: string;
    name: string;
    /** The agent's office colour, for its dot. */
    color: string;
    /** The issue it is on, when its run names one ("web #2942"). */
    tag?: string;
    /** What it is doing, when there is no issue to name. */
    text?: string;
    /** The issue's title, shown whole when the row is open. */
    title?: string;
    /** Its office, and that office's colour. */
    office?: string;
    officeColor?: string;
    /** "Claude Code · claude-sonnet-5-5". */
    model?: string;
    /** When its run started (ISO). */
    startedAt?: string;
    /** The newest step of its run. */
    last?: { type: string; icon: string; label: string; text: string; at: string };
    /** Tool calls and tokens of the run so far. */
    tools?: number;
    tokens?: number;
  }
</script>

<script lang="ts">
  /**
   * The 3D world's WORKING list: who is running now and what on. A flat rectangle over the scene's corner, one row
   * per agent. What the agent is on comes two ways: an issue ("web #2942") reads as a chip at the row's end; a
   * sentence (what a run without an issue does) takes a second line the full width of the row, two lines at most,
   * so more of it fits than a chip ever held.
   *
   * Measured to the pixel (see the style block): 300 px wide, 6 px corners, a 26 px header, 7/10 px row padding,
   * a 6 px dot, 12/16 px names, 11/14 px descriptions. The system UI face with negative tracking keeps the text
   * plain and packs more of it in.
   *
   * A click opens the row in place, one at a time: the whole sentence or issue title, the office, the model, how
   * long it has run, its newest step, and its tool and token counts; "Open agent" there selects it in the world.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { t, type Translate } from '$lib/i18n/index.js';

  export let items: WorkingItem[] = [];
  const dispatch = createEventDispatcher<{ select: string }>();

  let open = '';
  const toggle = (id: string) => { open = open === id ? '' : id; };
  // An agent that stopped leaves the list: its open row closes with it.
  $: if (open && !items.some((i) => i.id === open)) open = '';

  // The running time ticks only while a row is open.
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  $: if (open && !timer) { now = Date.now(); timer = setInterval(() => (now = Date.now()), 1000); }
  $: if (!open && timer) { clearInterval(timer); timer = null; }
  onDestroy(() => { if (timer) clearInterval(timer); });

  function since(iso: string | undefined, t: number): string {
    const ms = iso ? t - Date.parse(iso) : NaN;
    if (!Number.isFinite(ms) || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }
  // A step type the dictionary does not name keeps the label it came with.
  function stepLabel(type: string, label: string, tr: Translate): string {
    const key = `working.step.${type}`;
    const v = tr(key as string);
    return v === key ? label : v;
  }
  const tok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : String(n));
</script>

{#if items.length}
  <section class="wh" aria-label={$t('working.title')}>
    <header class="wh-h">
      <span class="wh-pulse" aria-hidden="true"></span>
      <span class="wh-title">{$t('working.title')}</span>
      <span class="wh-count">{items.length}</span>
    </header>
    <ul class="wh-list">
      {#each items as it (it.id)}
        {@const isOpen = open === it.id}
        <li class:wh-open={isOpen}>
          <button type="button" class="wh-row" class:wh-row--text={!it.tag && !!it.text} aria-expanded={isOpen}
            title={isOpen ? '' : [it.name, it.tag, it.text].filter(Boolean).join(' — ')} on:click={() => toggle(it.id)}>
            <span class="wh-dot" style="background:{it.color}" aria-hidden="true"></span>
            <span class="wh-name">{it.name}</span>
            {#if it.tag}
              <span class="wh-tag">{it.tag}</span>
            {:else if it.text}
              <span class="wh-text">{it.text}</span>
            {/if}
          </button>
          {#if isOpen}
            <div class="wh-more">
              {#if it.tag && it.title}<p class="wh-full">{it.title}</p>{/if}
              <dl class="wh-facts">
                {#if it.office}<dt>{$t('working.office')}</dt><dd><i style="background:{it.officeColor ?? it.color}" aria-hidden="true"></i>{it.office}</dd>{/if}
                {#if it.model}<dt>{$t('working.model')}</dt><dd class="mono">{it.model}</dd>{/if}
                {#if since(it.startedAt, now)}<dt>{$t('working.running')}</dt><dd class="mono">{since(it.startedAt, now)}</dd>{/if}
                {#if it.tools || it.tokens}<dt>{$t('working.work')}</dt><dd class="mono">{$t('working.tools', { n: it.tools ?? 0 })}{#if it.tokens}{' · '}{$t('working.tokens', { n: tok(it.tokens) })}{/if}</dd>{/if}
              </dl>
              {#if it.last}
                <div class="wh-last">
                  <div class="wh-last-h"><span>{it.last.icon}</span><span class="wh-last-l">{stepLabel(it.last.type, it.last.label, $t)}</span><span class="wh-last-t mono">{since(it.last.at, now) ? $t('working.ago', { t: since(it.last.at, now) }) : ''}</span></div>
                  <p class="wh-last-x">{it.last.text}</p>
                </div>
              {/if}
              <button type="button" class="wh-go" on:click={() => dispatch('select', it.id)}>{$t('working.open')} <span aria-hidden="true">→</span></button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .wh {
    --wh-font: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
    --wh-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    --wh-green: #34d399;
    position: absolute; left: 12px; bottom: 12px; z-index: 10;
    width: 300px; max-width: calc(100% - 24px); box-sizing: border-box;
    background: rgba(11, 13, 19, 0.94);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.03);
    overflow: hidden;
    font-family: var(--wh-font);
    -webkit-font-smoothing: antialiased;
  }

  /* 26 px header: pulse, title, count. */
  .wh-h {
    display: flex; align-items: center; gap: 6px;
    height: 26px; padding: 0 10px; box-sizing: border-box;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    background: linear-gradient(180deg, rgba(52, 211, 153, 0.06), rgba(52, 211, 153, 0));
  }
  .wh-pulse {
    width: 6px; height: 6px; border-radius: 50%; flex: none;
    background: var(--wh-green); box-shadow: 0 0 6px var(--wh-green);
    animation: wh-pulse 1.6s ease-in-out infinite;
  }
  .wh-title {
    font: 600 10px/1 var(--wh-font); letter-spacing: 0.06em; text-transform: uppercase; color: var(--wh-green);
  }
  .wh-count {
    margin-left: auto;
    font: 600 10px/1 var(--wh-mono); letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
    color: rgba(230, 232, 238, 0.45);
  }

  .wh-list { list-style: none; margin: 0; padding: 0; max-height: min(420px, 60vh); overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.12) transparent; }
  .wh-list li + li .wh-row { border-top: 1px solid rgba(255, 255, 255, 0.045); }

  /* A row: dot · name · issue chip; a sentence drops to a second line under the name, full width. */
  .wh-row {
    display: grid; grid-template-columns: 6px minmax(0, 1fr) auto; column-gap: 8px; row-gap: 3px; align-items: center;
    width: 100%; box-sizing: border-box; padding: 7px 10px; margin: 0;
    border: 0; background: none; color: inherit; text-align: left; cursor: pointer;
    transition: background-color 0.12s;
  }
  .wh-row:hover { background: rgba(255, 255, 255, 0.035); }
  .wh-row:focus-visible { outline: 1px solid rgba(52, 211, 153, 0.6); outline-offset: -1px; }

  .wh-dot { width: 6px; height: 6px; border-radius: 50%; }
  .wh-name {
    font: 500 12px/16px var(--wh-font); letter-spacing: -0.01em; color: #e6e8ee;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .wh-row--text .wh-name { grid-column: 2 / 4; }

  /* The issue: 18 px chip, monospace, tight tracking. */
  .wh-tag {
    height: 18px; padding: 0 6px; box-sizing: border-box; border-radius: 4px;
    display: inline-flex; align-items: center;
    font: 600 10.5px/1 var(--wh-mono); letter-spacing: -0.02em; white-space: nowrap;
    color: #8ef0c0; background: rgba(52, 211, 153, 0.1); border: 1px solid rgba(52, 211, 153, 0.28);
  }

  /* The sentence: second line, from under the name to the row's end, two lines at most. */
  .wh-text {
    grid-column: 2 / 4;
    font: 400 11px/14px var(--wh-font); letter-spacing: -0.005em; color: rgba(214, 218, 232, 0.62);
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2;
    overflow: hidden; word-break: break-word;
  }

  /* An open row: the details, indented under the name (10 + 6 + 8 = 24 px). */
  .wh-open { background: rgba(255, 255, 255, 0.025); }
  .wh-open .wh-row { background: none; }
  .wh-open .wh-text { display: block; -webkit-line-clamp: unset; line-clamp: none; color: rgba(214, 218, 232, 0.8); }
  .wh-more { padding: 0 10px 10px 24px; display: flex; flex-direction: column; gap: 8px; animation: wh-in 0.14s ease-out; }
  .wh-full { margin: 0; font: 400 11px/14px var(--wh-font); letter-spacing: -0.005em; color: rgba(214, 218, 232, 0.8); }
  .wh-facts { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 4px 8px; margin: 0; }
  .wh-facts dt { font: 500 10px/14px var(--wh-font); letter-spacing: 0.02em; text-transform: uppercase; color: rgba(214, 218, 232, 0.4); }
  .wh-facts dd { margin: 0; display: flex; align-items: center; gap: 6px; min-width: 0;
    font: 500 11px/14px var(--wh-font); letter-spacing: -0.01em; color: #e6e8ee; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wh-facts dd i { width: 6px; height: 6px; border-radius: 1px; flex: none; }
  .mono { font-family: var(--wh-mono) !important; letter-spacing: -0.02em !important; font-size: 10.5px !important; }
  .wh-last { padding: 6px 8px; border-radius: 4px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.05); }
  .wh-last-h { display: flex; align-items: center; gap: 6px; font: 600 10px/14px var(--wh-font); letter-spacing: 0.02em; text-transform: uppercase; color: rgba(214, 218, 232, 0.55); }
  .wh-last-l { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wh-last-t { color: rgba(214, 218, 232, 0.4); text-transform: none; }
  .wh-last-x { margin: 3px 0 0; font: 400 11px/14px var(--wh-font); letter-spacing: -0.005em; color: rgba(214, 218, 232, 0.75);
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; line-clamp: 4; overflow: hidden; word-break: break-word; }
  .wh-go { align-self: flex-start; height: 22px; padding: 0 8px; border-radius: 4px; cursor: pointer;
    font: 600 11px/1 var(--wh-font); letter-spacing: -0.01em; color: var(--wh-green);
    background: rgba(52, 211, 153, 0.08); border: 1px solid rgba(52, 211, 153, 0.3); transition: background-color 0.12s; }
  .wh-go:hover { background: rgba(52, 211, 153, 0.16); }
  .wh-go:focus-visible { outline: 1px solid var(--wh-green); outline-offset: 1px; }
  @keyframes wh-in { from { opacity: 0; transform: translateY(-2px); } }

  @keyframes wh-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .wh-pulse, .wh-more { animation: none; } .wh-row, .wh-go { transition: none; } }
</style>
