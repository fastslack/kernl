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
  import { onDestroy, tick } from 'svelte';
  import { get, type Readable } from 'svelte/store';
  import ModelPicker from '../ModelPicker.svelte';
  import { readChain, writeChain, MAX_CHAIN_LINKS, type ChainLink } from '$lib/model-chain.js';
  import { linkHealth, chainUsable, type ProviderStatus } from '$lib/provider-health.js';
  import { modelEntries } from '$lib/llm-models.js';
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
  // Same two calls the chat's picker makes (routes/chat/+page.svelte:521-546):
  // the status list, then each ready provider's models in parallel. Offline
  // providers are kept in the list — dimmed, with their reason — because what
  // could be configured is exactly what someone reading a chain failure needs
  // to see.
  async function loadProviders() {
    try {
      const r = await fetch('/api/llm-providers');
      if (!r.ok) return;
      const body = await r.json();
      const list = (body.providers ?? []) as ProviderStatus[];
      providers = await Promise.all(
        list.map(async (p) => {
          if (!p.ready) return { ...p, models: [] } as Provider;
          try {
            const mr = await fetch(`/api/llm-providers/${encodeURIComponent(p.slug)}/models`);
            if (!mr.ok) return { ...p, models: [] } as Provider;
            const mb = await mr.json();
            return { ...p, models: modelEntries(mb.models) as ModelEntry[] } as Provider;
          } catch {
            return { ...p, models: [] } as Provider;
          }
        }),
      );
    } catch {
      /* the section still renders; rows just cannot explain themselves */
    } finally {
      providersLoaded = true;
    }
  }
  loadProviders();

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
    return write(writeChain(next));
  }
  /** Any of the three chain columns busy means the chain is busy. */
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

  function setExecutor(next: 'native' | 'claude_code') {
    if (next === executor) return;
    return write({ executor_type: next });
  }

  // ── The four numbers ─────────────────────────────────────────────
  // One PUT per keystroke would be four writes to type "1200". 600ms after
  // the last one is late enough to be one write and early enough that nobody
  // waits for it.
  const DEBOUNCE_MS = 600;
  const NUMERICS: Array<{ key: string; label: string; unit: string; min: number; step: number; hint: string }> = [
    { key: 'max_iterations', label: 'max iterations', unit: '', min: 1, step: 1, hint: 'How many tool-loop turns one run may take.' },
    { key: 'max_tokens', label: 'token budget', unit: 'tokens', min: 0, step: 1000, hint: 'Total tokens one run may spend.' },
    { key: 'timeout_ms', label: 'timeout', unit: 'ms', min: 1000, step: 1000, hint: 'The kernel kills the run after this.' },
    { key: 'max_errors', label: 'max errors', unit: '', min: 0, step: 1, hint: 'Consecutive step errors before the run gives up.' },
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
    void write({ [key]: clamped }).finally(() => {
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
    return v === undefined || v === null || v === '' ? '' : String(v);
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
    sectionEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await tick();
    pickers[0]?.openMenu();
  }
</script>

<section class="rt" class:rt-compact={compact} bind:this={sectionEl}>
  <div class="rt-head">
    <h3 class="rt-h">Runtime</h3>
    {#if running}
      <span class="rt-next" role="status">changes apply to the next run</span>
    {/if}
  </div>

  <!-- ── Model chain ── -->
  <div class="rt-field">
    <div class="rt-lbl">
      <span>Model</span>
      {#if links.length > 1}<span class="rt-lbl-note">primary + {links.length - 1} fallback{links.length > 2 ? 's' : ''}</span>{/if}
    </div>

    {#each links as link, i (i)}
      {@const h = health[i]}
      <div class="rt-row">
        <span class="rt-rank" aria-hidden="true">{i + 1}</span>
        <div class="rt-row-main">
          <ModelPicker
            bind:this={pickers[i]}
            provider={link.provider}
            model={link.model}
            {providers}
            {requiresTools}
            busy={chainSaving}
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
            {requiresTools}
            placeholder="choose a fallback"
            on:change={(e) => commitDraft(e.detail)}
          />
        </div>
        <button class="rt-x" title="Cancel" on:click={() => (draft = null)}>×</button>
      </div>
    {/if}

    {#if canAdd}
      <button class="rt-add" on:click={() => (draft = { provider: '', model: '' })}>
        + add fallback
      </button>
    {/if}

    {#if chainError}
      <p class="rt-err">{chainError}</p>
    {:else if deadChain}
      <p class="rt-dead">
        No link in this chain can run this agent. That is the failure the
        executor reports as “No LLM provider in the chain can run tool calls”.
      </p>
    {/if}
  </div>

  <!-- ── Executor ── -->
  <div class="rt-field">
    <div class="rt-lbl">
      <span>Executor</span>
      {#if $store?.saving?.has('executor_type')}<span class="rt-lbl-note">saving…</span>{/if}
    </div>
    <div class="rt-seg" role="group" aria-label="executor">
      <button
        class="rt-seg-b"
        class:on={executor === 'native'}
        title="The kernel runs the tool loop against the chain above."
        on:click={() => setExecutor('native')}
      >native</button>
      <button
        class="rt-seg-b"
        class:on={executor === 'claude_code'}
        title="The CLI runs its own tool loop. The chain above is not used for tools."
        on:click={() => setExecutor('claude_code')}
      >claude_code</button>
    </div>
    {#if fieldError.executor_type}
      <p class="rt-err">{fieldError.executor_type}</p>
    {:else if executor === 'claude_code'}
      <p class="rt-note">Tools run inside the CLI's own loop, so a provider that cannot carry the kernel's loop is not a problem here.</p>
    {/if}
  </div>

  <!-- ── Limits ── -->
  {#each NUMERICS as n (n.key)}
    <div class="rt-field">
      <div class="rt-lbl">
        <span>{n.label}</span>
        {#if $store?.saving?.has(n.key)}
          <span class="rt-lbl-note">saving…</span>
        {:else if n.key in pending}
          <span class="rt-lbl-note">…</span>
        {/if}
      </div>
      <div class="rt-num" class:rt-num-err={!!fieldError[n.key]}>
        <input
          type="number"
          min={n.min}
          step={n.step}
          value={numValue(n.key)}
          title={n.hint}
          on:input={(e) => onNumber(n.key, e.currentTarget.value)}
        />
        {#if n.unit}<span class="rt-unit">{n.unit}</span>{/if}
      </div>
      {#if fieldError[n.key]}<p class="rt-err">{fieldError[n.key]}</p>{/if}
    </div>
  {/each}
</section>

<style>
  .rt{margin-bottom:18px}
  .rt-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
  .rt-h{
    font:600 10px 'Syne',sans-serif;
    color:#8a8fa8;text-transform:uppercase;letter-spacing:1.5px;margin:0;
  }
  .rt-next{
    font:500 9.5px 'JetBrains Mono',monospace;color:#fbbf24;
    padding:2px 7px;border-radius:5px;
    background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);
  }

  /* Stacked, full width. See the header comment — two columns inside a
     560px drawer put two hit targets at ~240px each side by side. */
  .rt-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
  .rt-compact .rt-field{margin-bottom:9px}
  .rt-lbl{
    display:flex;align-items:baseline;justify-content:space-between;gap:8px;
    font:500 10px 'Manrope',sans-serif;color:#8a8fa8;
  }
  .rt-lbl-note{font:500 9px 'JetBrains Mono',monospace;color:#6a6f82}

  .rt-row{display:flex;align-items:center;gap:8px}
  .rt-row-main{flex:1;min-width:0}
  .rt-rank{
    flex:none;width:16px;text-align:center;
    font:600 10px 'JetBrains Mono',monospace;color:#6a6f82;
  }
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
  .rt-x:hover{color:#ef5d6e;border-color:rgba(239,93,110,.4);background:rgba(239,93,110,.1)}
  .rt-add{
    align-self:flex-start;margin-left:24px;
    background:none;border:none;cursor:pointer;padding:2px 0;
    color:#7f93c8;font:600 10px 'JetBrains Mono',monospace;
  }
  .rt-add:hover{color:#a9bcf0;text-decoration:underline}

  .rt-seg{display:flex;gap:0;border-radius:6px;overflow:hidden;border:1px solid rgba(120,130,160,.28);width:100%}
  .rt-seg-b{
    flex:1;padding:7px 10px;background:rgba(20,24,38,.85);
    border:none;border-right:1px solid rgba(120,130,160,.18);
    color:#8a8fa8;cursor:pointer;
    font:600 10.5px 'JetBrains Mono',monospace;
  }
  .rt-seg-b:last-child{border-right:none}
  .rt-seg-b:hover{color:#d8dae3;background:rgba(26,31,48,.9)}
  .rt-seg-b.on{color:#0a0e14;background:#9fb4e8}

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

  .rt-err{margin:0;font:500 10.5px/1.4 'Manrope',sans-serif;color:#ef5d6e}
  .rt-dead{
    margin:2px 0 0;padding:7px 9px;border-radius:6px;
    font:500 10.5px/1.45 'Manrope',sans-serif;color:#f0a4ad;
    background:rgba(239,93,110,.08);border:1px solid rgba(239,93,110,.25);
  }
  .rt-note{margin:0;font:500 10.5px/1.4 'Manrope',sans-serif;color:#6a6f82}
</style>
