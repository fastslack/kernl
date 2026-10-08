<!--
  RuntimeSection — the agent's engine, editable where its failures are read.

  This section used to be six `<code>` chips in a two-column grid. An agent
  whose run died with

    "No LLM provider in the chain can run tool calls. Dropped: claude_code.
     Configure a provider that supports tools (Settings → AI), or set this
     agent's executor to claude_code to use the CLI's own tool loop."

  showed that error directly above a read-only rendering of both fields the
  message names. The fix was two screens away from the report.

  Three decisions here are deliberate and cost something:

  · ONE LIST. The user sees row 1 = primary, rows 2-3 = fallbacks. `agents`
    stores a loose (provider, model) pair AND a `model_chain` JSON array; that
    split is a schema detail and it stays inside `$lib/model-chain.js`. Every
    write sends all three columns in a single patch, so the mirror the chain
    head keeps in `provider` can never drift from the chain.

  · STACKED, FULL WIDTH — not the `.ip-kv-grid` two-up the read-only version
    used. Two columns are fine for reading pairs. For editing inside a narrow
    drawer laid over a 3D world they put two hit targets side by side at about
    240px each, which is how you click the wrong one.

  · AUTOSAVE PER FIELD, no Save button. The numeric inputs debounce so a
    keystroke is not a PUT. State lives on the control that was touched —
    busy while its key is in `$store.saving`, red with the reason if that
    write failed. No toast: a toast would be the same distance from the
    problem as Settings was.
-->
<script lang="ts">
  import { t } from '$lib/i18n/index.js';
  import { onDestroy, tick } from 'svelte';
  import { get, type Readable } from 'svelte/store';
  import ModelPicker from '../ModelPicker.svelte';
  import { readChain, writeChain, engineFor, MAX_CHAIN_LINKS, type ChainLink } from '$lib/model-chain.js';
  import { linkHealth, chainUsable, type ProviderStatus } from '$lib/provider-health.js';
  import { loadPickerProviders } from '$lib/llm-provider-list.js';
  import { refreshPrices } from '$lib/model-prices.js';
  import type { ModelEntry } from '$lib/model-catalog.js';

  /** The drawer's agent store (`AgentDrawer` publishes it on the overview slot). */
  export let store: Readable<any> & {
    patch: (fields: Record<string, unknown>) => Promise<void>;
  };
  /** Reserved for the embedded mount on /agents — tightens the spacing. */
  export let compact = false;
  /** A run is in flight. Changes still save; they take effect next run. */
  export let running = false;

  type Provider = ProviderStatus & { models?: ModelEntry[] };

  let providers: Provider[] = [];
  let providersLoaded = false;
  /** One handle per chain row; row 0 is the one outside callers steer to. */
  let pickers: Array<ModelPicker | null> = [];
  let sectionEl: HTMLElement | null = null;
  /** Set by `focusPrimaryPicker({ requireTools })` — see below. */
  let forceTools = false;

  $: agent = ($store?.agent ?? {}) as Record<string, any>;
  $: links = readChain(agent);
  $: executor = String(agent.executor_type || 'native') === 'claude_code' ? 'claude_code' : 'native';
  // A builtin handler short-circuits the LLM path (executor.ts), so neither
  // the engine nor the model chain does anything for it — say so instead of
  // offering controls that change nothing.
  $: isScript = !!agent.builtin_handler;
  // The claude_code executor runs tools inside the SDK's own loop, so a
  // provider that cannot carry the kernel's native loop is not a problem
  // there. That is the second remedy the error message offers, and flipping
  // this control is what clears the "cannot run tools" marks below.
  $: requiresTools = forceTools || executor !== 'claude_code';
  $: health = links.map((l) => linkHealth(l, providers, requiresTools));
  $: deadChain = providersLoaded && links.length > 0 && !chainUsable(links, providers, requiresTools);
  $: canAdd = links.length < MAX_CHAIN_LINKS && draft === null;

  /**
   * A fallback row the user has opened but not chosen anything for yet.
   *
   * It cannot live in `links`: `writeChain` drops empty entries, so an empty
   * row committed straight to the chain would come back from the store having
   * silently vanished. It stays local until it has a provider.
   */
  let draft: ChainLink | null = null;

  // ── Providers ────────────────────────────────────────────────────
  async function loadProviders() {
    providers = await loadPickerProviders();
    providersLoaded = true;
  }
  loadProviders();

  // ── Prices (shown in the pickers; refreshed on demand) ─────────────
  let pricesBusy = false;
  let pricesNote = '';
  async function onRefreshPrices(): Promise<void> {
    pricesBusy = true;
    pricesNote = '';
    try {
      const n = await refreshPrices();
      pricesNote = get(t)('agent.prices.refreshed', { n: String(n) });
    } catch (e) {
      pricesNote = (e as Error).message;
    } finally {
      pricesBusy = false;
    }
  }

  // ── Writing ──────────────────────────────────────────────────────
  /** Per-field write outcome, so the error lands on the control, not a toast. */
  let fieldError: Record<string, string> = {};

  async function write(fields: Record<string, unknown>) {
    for (const k of Object.keys(fields)) delete fieldError[k];
    fieldError = fieldError;
    await store.patch(fields);
    // `patch` swallows the failure into the store's `error`; read it back so
    // the field that caused it is the field that shows it.
    const err = String(get(store).error || '');
    if (err) {
      for (const k of Object.keys(fields)) fieldError[k] = err;
      fieldError = fieldError;
    }
  }

  /** The chain, as three columns, in one write. */
  function saveChain(next: ChainLink[]) {
    const fields: Record<string, unknown> = writeChain(next);
    // The engine follows the primary model, in the same write: a Claude Code
    // model runs on the claude_code executor, any other on the kernel's. Only
    // when the primary itself changes — adding or removing a fallback must not
    // move an agent whose engine was set before this rule existed.
    const head = next[0];
    const prev = links[0];
    const primaryChanged = !!head && (!prev || head.provider !== prev.provider || head.model !== prev.model);
    if (primaryChanged && engineFor(head) !== executor) fields.executor_type = engineFor(head);
    return write(fields);
  }
  /**
   * Any of the three chain columns busy means the chain is busy — and while
   * it is, every control that writes the chain is DISABLED, not merely
   * decorated.
   *
   * The distinction cost a round trip's worth of correctness. `ModelPicker`
   * takes both a `busy` and a `disabled` prop, and only `disabled` refuses
   * the click; `busy` draws a wait cursor and a different caret. So two
   * clicks inside one round trip — remove a fallback twice, pick two models
   * quickly — used to issue two patches over the SAME three keys.
   *
   * Overlapping patches are normally safe here: `agent-detail.ts` leaves a
   * key alone when another write still has it in flight. But that guard is
   * `if (k in fields || !s.saving.has(k))`, and `k in fields` is true for
   * exactly the keys the two patches share — so patch A's response overwrites
   * patch B's newer value, and on failure `rollbackFields` restores A's
   * pre-edit chain over B's. The removed row reappears, then vanishes.
   *
   * The four numerics below do not have this problem: they debounce, and each
   * one writes its own key. The chain writes three keys per click with no
   * debounce, so it is closed by construction instead.
   */
  $: chainSaving =
    !!$store?.saving &&
    (['provider', 'model', 'model_chain'] as const).some((k) => $store.saving.has(k));
  $: chainError = fieldError.model_chain || fieldError.provider || fieldError.model || '';

  function setLink(i: number, next: ChainLink) {
    const copy = links.slice();
    copy[i] = next;
    return saveChain(copy);
  }
  function removeLink(i: number) {
    return saveChain(links.filter((_, n) => n !== i));
  }
  function commitDraft(next: ChainLink) {
    draft = null;
    return saveChain([...links, next]);
  }

  /**
   * Exported so Task 10's `switch-executor-claude-code` remedy can drive this
   * same control from outside instead of calling `store.patch()` on its own.
   *
   * It has to: `write()` is what reads the store's post-patch `error` back
   * into `fieldError.executor_type` so it lands as `.rt-err` under THIS
   * field. A caller that patched the store directly would set the store's
   * top-level `error` and nothing would ever render it — the same failure
   * this section exists to fix, just moved one level up.
   */
  export function setExecutor(next: 'native' | 'claude_code') {
    if (next === executor) return Promise.resolve();
    return write({ executor_type: next });
  }

  // ── The four numbers ─────────────────────────────────────────────
  // One PUT per keystroke would be four writes to type "1200". 600ms after
  // the last one is late enough to be one write and early enough that nobody
  // waits for it.
  const DEBOUNCE_MS = 600;
  // Labels and help are i18n keys: these four were raw column names
  // ("max iterations", "timeout … ms") and nobody could tell what each one
  // stopped. `scale` is display units per stored unit — the timeout is stored
  // in ms and read in seconds.
  const NUMERICS: Array<{ key: string; label: string; help: string; unit: string; min: number; step: number; scale: number }> = [
    { key: 'max_iterations', label: 'agent.config.steps', help: 'agent.config.steps_help', unit: 'agent.config.unit_steps', min: 1, step: 1, scale: 1 },
    { key: 'max_tokens', label: 'agent.config.tokens', help: 'agent.config.tokens_help', unit: 'agent.config.unit_tokens', min: 0, step: 1000, scale: 1 },
    { key: 'timeout_ms', label: 'agent.config.timeout', help: 'agent.config.timeout_help', unit: 'agent.config.unit_seconds', min: 1, step: 10, scale: 1000 },
    { key: 'max_errors', label: 'agent.config.errors', help: 'agent.config.errors_help', unit: 'agent.config.unit_errors', min: 0, step: 1, scale: 1 },
  ];

  const timers: Record<string, ReturnType<typeof setTimeout>> = {};
  /** What the user has typed but not yet had saved, per field. */
  let pending: Record<string, string> = {};

  /** Send what is pending for one field. Called by the timer, and by destroy. */
  function commitNumber(key: string) {
    delete timers[key];
    const raw = pending[key] ?? '';
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) {
      // Nothing usable typed — drop the draft rather than writing NaN.
      delete pending[key];
      pending = pending;
      return;
    }
    const spec = NUMERICS.find((s) => s.key === key);
    const clamped = spec ? Math.max(spec.min, Math.round(n)) : Math.round(n);
    void write({ [key]: clamped * (spec?.scale ?? 1) }).finally(() => {
      delete pending[key];
      pending = pending;
    });
  }

  function onNumber(key: string, raw: string) {
    pending[key] = raw;
    pending = pending;
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => commitNumber(key), DEBOUNCE_MS);
  }

  function numValue(key: string): string {
    if (key in pending) return pending[key];
    const v = agent[key];
    if (v === undefined || v === null || v === '') return '';
    const scale = NUMERICS.find((s) => s.key === key)?.scale ?? 1;
    return String(Math.round(Number(v) / scale));
  }

  // Flush, do not drop. Typing into a numeric and closing the drawer inside
  // the debounce window used to discard the edit — after the label had already
  // said it was about to save. Silent loss of a keystroke is the exact failure
  // this section exists to remove, so the pending write goes out on the way
  // down. It is a plain fetch and does not need the component to survive it.
  onDestroy(() => {
    for (const key of Object.keys(timers)) {
      clearTimeout(timers[key]);
      commitNumber(key);
    }
  });

  // ── Steering from outside ────────────────────────────────────────
  /**
   * Bring the section into view and open row 1's picker.
   *
   * Task 10's `pick-tool-capable-provider` remedy calls this: the run-failure
   * panel names the fix, this puts the cursor on it. `requireTools` makes the
   * picker mark tool-incapable providers even when the agent is on the
   * claude_code executor — it marks them, it never hides them, because the
   * provider the error named is the one the user came looking for.
   */
  export async function focusPrimaryPicker(opts: { requireTools?: boolean } = {}): Promise<void> {
    if (opts.requireTools) forceTools = true;
    // Instant, not smooth: ModelPicker's own menu closes itself on a scroll
    // that leaves its trigger off-screen (onOuterScroll, ModelPicker.svelte)
    // — right behaviour for a user scrolling the drawer while the menu is
    // open, wrong when the DRAWER's own smooth-scroll animation is still
    // mid-flight the instant `openMenu()` binds that listener. With a smooth
    // scroll the trigger is still off-center on the very next animation
    // frame, so the menu opened and immediately closed itself. An instant
    // jump finishes before `openMenu()` runs, so there is no animation left
    // to race.
    sectionEl?.scrollIntoView({ behavior: 'auto', block: 'center' });
    await tick();
    pickers[0]?.openMenu();
  }
</script>

<section class="rt" class:rt-compact={compact} bind:this={sectionEl}>
  {#if running}
    <p class="rt-next" role="status">{$t('agent.runtime.applies_next_run')}</p>
  {/if}

  {#if !isScript}
    <!-- ── Model (the engine follows it, model-chain.ts engineFor) ── -->
    <div class="cfg-group">
      <header class="cfg-gh">
        <h3 class="cfg-h">{$t('agent.config.engine_title')}</h3>
      </header>

      <div class="rt-field">
        <div class="rt-lbl">
          <span class="rt-lbl-note">
            {$t('agent.config.model_help')} ·
            <button class="rt-price-link" type="button" on:click={onRefreshPrices} disabled={pricesBusy}
                    title={$t('agent.prices.refresh_title')}>
              {pricesBusy ? $t('agent.prices.refreshing') : pricesNote || $t('agent.prices.refresh')}
            </button>
          </span>
        </div>

        {#each links as link, i (i)}
          {@const h = health[i]}
          <div class="rt-row">
            <span class="rt-rank" title={i === 0 ? $t('agent.config.primary') : $t('agent.config.fallback')}>{i === 0 ? '★' : i + 1}</span>
            <div class="rt-row-main">
              <ModelPicker
                bind:this={pickers[i]}
                provider={link.provider}
                model={link.model}
                {providers}
                loading={!providersLoaded}
                requiresTools={i === 0 || requiresTools}
                engineFollows={i === 0}
                busy={chainSaving}
                disabled={chainSaving}
                error={i === 0 ? chainError : ''}
                on:change={(e) => setLink(i, e.detail)}
              />
            </div>
            {#if h.label}
              <span class="rt-why" class:rt-why-bad={!h.usable} class:rt-why-warn={h.usable && h.state !== 'ok'} title={h.detail}>
                {h.label}
              </span>
            {/if}
            {#if links.length > 1}
              <button
                class="rt-x"
                disabled={chainSaving}
                title={i === 0
                  ? 'Remove the primary — row 2 is promoted in its place'
                  : 'Remove this fallback'}
                on:click={() => removeLink(i)}
              >×</button>
            {/if}
          </div>
        {/each}

        {#if draft}
          <div class="rt-row">
            <span class="rt-rank" aria-hidden="true">{links.length + 1}</span>
            <div class="rt-row-main">
              <ModelPicker
                provider={draft.provider}
                model={draft.model}
                {providers}
                loading={!providersLoaded}
                requiresTools={links.length === 0 || requiresTools}
                engineFollows={links.length === 0}
                busy={chainSaving}
                disabled={chainSaving}
                placeholder={$t('agent.runtime.choose_fallback')}
                on:change={(e) => commitDraft(e.detail)}
              />
            </div>
            <button class="rt-x" disabled={chainSaving} title={$t('agent.runtime.cancel')} on:click={() => (draft = null)}>×</button>
          </div>
        {/if}

        {#if canAdd}
          <button class="rt-add" disabled={chainSaving} on:click={() => (draft = { provider: '', model: '' })}>
            {$t('agent.config.add_fallback')}
          </button>
        {/if}

        {#if chainError || fieldError.executor_type}
          <p class="rt-err">{chainError || fieldError.executor_type}</p>
        {:else if deadChain}
          <p class="rt-dead">
            No link in this chain can run this agent. That is the failure the
            executor reports as “No LLM provider in the chain can run tool calls”.
          </p>
        {/if}
      </div>
    </div>
  {:else}
    <div class="cfg-group cfg-group-muted">
      <header class="cfg-gh">
        <h3 class="cfg-h">{$t('agent.config.engine_title')}</h3>
        <p class="cfg-sub">{$t('agent.config.script_note', { handler: String(agent.builtin_handler) })}</p>
      </header>
    </div>
  {/if}

  <!-- ── Limits ── -->
  <div class="cfg-group">
    <header class="cfg-gh">
      <h3 class="cfg-h">{$t('agent.config.limits_title')}</h3>
      <p class="cfg-sub">{$t('agent.config.limits_sub')}</p>
    </header>
    {#each NUMERICS as n (n.key)}
      <div class="rt-lim">
        <div class="rt-lim-txt">
          <label class="rt-lim-l" for="rt-{n.key}">
            {$t(n.label)}
            {#if $store?.saving?.has(n.key)}
              <span class="rt-lbl-note">{$t('agent.runtime.saving')}</span>
            {:else if n.key in pending}
              <span class="rt-lbl-note">…</span>
            {/if}
          </label>
          <span class="rt-lim-h">{$t(n.help)}</span>
          {#if fieldError[n.key]}<span class="rt-err">{fieldError[n.key]}</span>{/if}
        </div>
        <div class="rt-num" class:rt-num-err={!!fieldError[n.key]}>
          <input
            id="rt-{n.key}"
            type="number"
            min={n.min}
            step={n.step}
            value={numValue(n.key)}
            on:input={(e) => onNumber(n.key, e.currentTarget.value)}
          />
          <span class="rt-unit">{$t(n.unit)}</span>
        </div>
      </div>
    {/each}
  </div>
</section>

<style>
  .rt{display:flex;flex-direction:column;gap:12px;margin-bottom:12px}
  .rt-next{
    margin:0;align-self:flex-start;
    font:500 9.5px 'JetBrains Mono',monospace;color:#fbbf24;
    padding:2px 7px;border-radius:5px;
    background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);
  }

  /* One card per question the operator asks ("what thinks for it?", "when
     does a run stop?"). ConfigTab draws its other groups with the same rules —
     copies, because Svelte scopes CSS per component. */
  .cfg-group{
    padding:12px 14px 4px;border-radius:10px;
    background:rgba(255,255,255,.018);border:1px solid rgba(120,130,160,.14);
  }
  .cfg-group-muted{padding-bottom:12px}
  .cfg-gh{margin-bottom:10px}
  .cfg-h{
    margin:0;font:600 10.5px 'Syne',sans-serif;
    color:#c9cde0;text-transform:uppercase;letter-spacing:1.4px;
  }
  .cfg-sub{margin:3px 0 0;font:500 11px/1.4 'Manrope',sans-serif;color:#7d8299}
  .cfg-group-muted .cfg-sub{margin:4px 0 0}

  /* Limits: label + what it stops on the left, the number on the right. */
  .rt-lim{
    display:grid;grid-template-columns:minmax(0,1fr) 150px;gap:4px 14px;align-items:center;
    padding:8px 0;border-top:1px solid rgba(120,130,160,.08);
  }
  .rt-lim:first-of-type{border-top:0}
  .rt-lim-txt{display:flex;flex-direction:column;gap:2px;min-width:0}
  .rt-lim-l{display:flex;align-items:baseline;gap:8px;font:600 12px 'Manrope',sans-serif;color:#dde0ea}
  .rt-lim-h{font:500 10.5px/1.35 'Manrope',sans-serif;color:#7d8299}

  /* Stacked, full width. See the header comment — two columns inside a
     560px drawer put two hit targets at ~240px each side by side. */
  .rt-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
  .rt-compact .rt-field{margin-bottom:9px}
  .rt-lbl{
    display:flex;align-items:baseline;justify-content:space-between;gap:8px;
    font:500 10px 'Manrope',sans-serif;color:#8a8fa8;
  }
  .rt-price-link{
    background:none;border:none;padding:0;cursor:pointer;font:inherit;
    color:#9fb4e8;text-decoration:underline;text-underline-offset:2px;
  }
  .rt-price-link:hover:not(:disabled){color:#c4d3f7}
  .rt-price-link:disabled{opacity:.6;cursor:wait}
  .rt-lbl-note{font:500 9px 'JetBrains Mono',monospace;color:#6a6f82}

  .rt-row{display:flex;align-items:center;gap:8px}
  .rt-row-main{flex:1;min-width:0}
  .rt-rank{
    flex:none;width:16px;text-align:center;
    font:600 10px 'JetBrains Mono',monospace;color:#6a6f82;
  }
  .rt-row + .rt-row .rt-rank{color:#55596b}
  .rt-why{
    flex:none;font:600 9px 'JetBrains Mono',monospace;
    padding:3px 7px;border-radius:5px;white-space:nowrap;
    color:#8a8fa8;background:rgba(120,130,160,.1);border:1px solid rgba(120,130,160,.22);
  }
  .rt-why-warn{color:#fbbf24;background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.28)}
  .rt-why-bad{color:#ef5d6e;background:rgba(239,93,110,.1);border-color:rgba(239,93,110,.32)}
  .rt-x{
    flex:none;width:22px;height:22px;border-radius:5px;
    background:rgba(255,255,255,.03);border:1px solid rgba(120,130,160,.18);
    color:#8a8fa8;cursor:pointer;line-height:1;font:400 14px/1 'Syne',sans-serif;
  }
  .rt-x:hover:not(:disabled){color:#ef5d6e;border-color:rgba(239,93,110,.4);background:rgba(239,93,110,.1)}
  /* Gated while the chain is being written — see `chainSaving`. Matches
     ModelPicker's own disabled trigger so the whole row reads as one state. */
  .rt-x:disabled{opacity:.5;cursor:wait}
  .rt-add{
    align-self:flex-start;margin-left:24px;
    background:none;border:none;cursor:pointer;padding:2px 0;
    color:#7f93c8;font:600 10px 'JetBrains Mono',monospace;
  }
  .rt-add:hover:not(:disabled){color:#a9bcf0;text-decoration:underline}
  .rt-add:disabled{opacity:.5;cursor:wait}

  .rt-seg{display:flex;gap:0;border-radius:6px;overflow:hidden;border:1px solid rgba(120,130,160,.28);width:100%}
  .rt-seg-b{
    flex:1;padding:7px 10px;background:rgba(20,24,38,.85);
    border:none;border-right:1px solid rgba(120,130,160,.18);
    color:#8a8fa8;cursor:pointer;text-align:left;
    display:flex;flex-direction:column;gap:2px;
  }
  .rt-seg-t{font:700 11.5px 'Manrope',sans-serif}
  .rt-seg-d{font:500 10px/1.35 'Manrope',sans-serif;opacity:.8}
  .rt-seg-b:last-child{border-right:none}
  .rt-seg-b:hover{color:#d8dae3;background:rgba(26,31,48,.9)}
  .rt-seg-b.on{color:#0a0e14;background:#9fb4e8}
  .rt-seg-b:focus-visible{outline:2px solid rgba(120,170,255,.7);outline-offset:-2px}

  .rt-num{
    display:flex;align-items:center;gap:8px;
    background:rgba(20,24,38,.85);
    border:1px solid rgba(120,130,160,.28);border-radius:6px;
    padding:0 10px;
  }
  .rt-num:focus-within{border-color:rgba(120,170,255,.55)}
  .rt-num-err{border-color:rgba(239,93,110,.65);background:rgba(239,93,110,.08)}
  .rt-num input{
    flex:1;min-width:0;background:none;border:none;outline:none;color:#f0f2f7;
    padding:7px 0;font:600 12px 'JetBrains Mono',monospace;
    font-variant-numeric:tabular-nums;
  }
  .rt-unit{flex:none;color:#6a6f82;font:500 10px 'JetBrains Mono',monospace}

  .rt-err{margin:0;display:block;font:500 10.5px/1.4 'Manrope',sans-serif;color:#ef5d6e}
  .rt-dead{
    margin:2px 0 0;padding:7px 9px;border-radius:6px;
    font:500 10.5px/1.45 'Manrope',sans-serif;color:#f0a4ad;
    background:rgba(239,93,110,.08);border:1px solid rgba(239,93,110,.25);
  }
  .rt-note{margin:0;font:500 10.5px/1.4 'Manrope',sans-serif;color:#6a6f82}
</style>
