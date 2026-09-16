<script lang="ts">
  /**
   * Step two: connect one provider. Left column says what it is and how to get
   * a key; right column shows what is happening and which model will run.
   * Nothing is saved until the kernel has proved the provider answers with a
   * tool call.
   */
  import { createEventDispatcher } from 'svelte';
  import { t, locale } from '$lib/i18n/index.js';
  import SecretInput from '$lib/components/settings/SecretInput.svelte';
  import {
    canConnect, connectInputFor, connectProvider, detectProvider, errorView, fetchLiveModels,
    hostOf, keyLooksWrong, modelOptions, pick, type CatalogProvider, type ProbeResult,
  } from '$lib/llm-connect.js';

  export let provider: CatalogProvider;
  export let loginCommand = 'claude';

  const dispatch = createEventDispatcher<{ back: void; connected: ProbeResult }>();

  let apiKey = '';
  let model = provider.model || provider.models.recommended || '';
  let region = provider.region || provider.regions[0]?.id || '';
  let baseUrl = provider.baseUrl || '';
  let phase: 'idle' | 'busy' | 'found' | 'ok' | 'error' = 'idle';
  let busyKey = 'llm.state.testing';
  let result: ProbeResult | null = null;
  let liveModels: string[] = [];
  let foundUrl = '';
  let switched = '';
  let showDetail = false;
  let copied = false;

  $: isLocal = provider.group === 'local';
  $: isCli = provider.kind === 'claude-code';
  $: steps = $locale === 'es' ? provider.steps.es : provider.steps.en;
  $: keyWarn = apiKey.trim().length >= 6 && keyLooksWrong(provider, apiKey);
  $: options = modelOptions(provider, liveModels);
  $: view = result?.error ? errorView(result.error.code) : null;
  $: ready = canConnect(provider, { apiKey, baseUrl }, phase === 'busy');

  function fail(code: NonNullable<ProbeResult['error']>['code'], detail = ''): void {
    result = { ok: false, latencyMs: 0, model, toolCall: false, error: { code, detail } };
    phase = 'error';
  }

  async function connect(withModel?: string): Promise<void> {
    if (withModel) model = withModel;
    phase = 'busy'; busyKey = 'llm.state.testing'; result = null; showDetail = false; switched = '';
    try {
      const r = await connectProvider(provider.slug, connectInputFor(provider, { apiKey, model, region, baseUrl }));
      result = r;
      if (r.switchedModel) { switched = r.switchedModel; model = r.switchedModel; }
      phase = r.ok ? 'ok' : 'error';
      if (r.ok) { apiKey = ''; dispatch('connected', r); }
    } catch (e) {
      fail('network', e instanceof Error ? e.message : String(e));
    }
  }

  async function detect(): Promise<void> {
    phase = 'busy'; busyKey = 'llm.state.detecting'; result = null; showDetail = false;
    try {
      const r = await detectProvider(provider.slug);
      if (isCli) {
        if (r.session) {
          result = { ok: true, latencyMs: 0, model: '', toolCall: false, chain: r.chain };
          phase = 'ok';
          dispatch('connected', result);
        } else {
          fail('no_session');
        }
        return;
      }
      if (r.found) {
        baseUrl = r.baseUrl; foundUrl = r.baseUrl; liveModels = r.models;
        if (!model && r.models.length > 0) model = r.models[0];
        phase = 'found';
      } else {
        baseUrl = baseUrl || r.baseUrl;
        fail('unreachable');
      }
    } catch (e) {
      fail('network', e instanceof Error ? e.message : String(e));
    }
  }

  async function loadLive(): Promise<void> {
    try { liveModels = await fetchLiveModels(provider.slug); } catch { /* the typed field still works */ }
  }

  async function copyCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(loginCommand);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch { copied = false; }
  }

  function runAction(): void {
    switch (view?.action) {
      case 'retry': void connect(); break;
      case 'fast_model': if (provider.models.fast) void connect(provider.models.fast); break;
      case 'pick_model': if (provider.connected) void loadLive(); document.getElementById('pc-model')?.focus(); break;
      case 'redetect': void detect(); break;
      case 'copy_command': void copyCommand(); break;
      case 'add_backup': dispatch('back'); break;
    }
  }
</script>

<div class="pc">
  <div class="pc-cols">
    <section class="pc-card">
      <header class="pc-head">
        <img src={provider.logo} alt="" width="32" height="32" />
        <div>
          <h2 class="pc-title">
            {provider.name}
            {#if provider.recommended}<span class="pc-rec">★ {$t('llm.recommended')}</span>{/if}
          </h2>
          <p class="pc-blurb">{pick(provider.blurb, $locale)}</p>
        </div>
      </header>
      <p class="pc-muted">{pick(provider.pricing, $locale)}</p>

      <ol class="pc-steps">
        {#each steps as s, i}
          <li>
            <span class="pc-n" aria-hidden="true">{i + 1}</span>
            <span class="pc-step">{s}</span>
            {#if i === 0 && provider.keyUrl}
              <a class="pc-open" href={provider.keyUrl} target="_blank" rel="noopener noreferrer">
                {$t('llm.open_key_page', { host: hostOf(provider.keyUrl) })} ↗
              </a>
            {/if}
          </li>
        {/each}
      </ol>

      {#if isCli}
        <p class="pc-muted">{$t('llm.cc_command_intro')}</p>
        <div class="pc-cmd">
          <code>{loginCommand}</code>
          <button type="button" class="pc-btn ghost" on:click={copyCommand}>{copied ? $t('llm.copied') : $t('llm.copy_command')}</button>
        </div>
      {:else if provider.needsKey}
        <label class="pc-label" for="pc-key">{$t('llm.key_label')}</label>
        <SecretInput id="pc-key" bind:value={apiKey} masked={provider.keyMasked} configured={!!provider.keyMasked} />
        {#if keyWarn}<p class="pc-warn">{$t('llm.key_hint_warn', { name: provider.name })}</p>{/if}
      {:else}
        <label class="pc-label" for="pc-url">{$t('llm.base_url')}</label>
        <input id="pc-url" class="pc-input" bind:value={baseUrl} spellcheck="false" autocomplete="off" />
      {/if}

      {#if provider.regions.length > 0}
        <label class="pc-label" for="pc-region">{$t('llm.region')}</label>
        <select id="pc-region" class="pc-input" bind:value={region}>
          {#each provider.regions as r (r.id)}<option value={r.id}>{pick(r.label, $locale)}</option>{/each}
        </select>
      {/if}
    </section>

    <section class="pc-card">
      <h3 class="pc-label">{$t('llm.status_title')}</h3>
      <div class="pc-state" class:ok={phase === 'ok' || phase === 'found'} class:err={phase === 'error'} role="status" aria-live="polite">
        {#if phase === 'busy'}
          <span class="pc-spin" aria-hidden="true"></span>{$t(busyKey)}
        {:else if phase === 'ok'}
          ✓ {result?.toolCall ? $t('llm.state.ok', { ms: result.latencyMs }) : $t('llm.state.ok_plain', { ms: result?.latencyMs ?? 0 })}
        {:else if phase === 'found'}
          ✓ {$t('llm.state.found', { url: foundUrl, n: liveModels.length })}
        {:else if phase === 'error' && view}
          <span role="alert">{$t(view.messageKey, { name: provider.name, url: baseUrl || provider.baseUrl })}</span>
        {:else}
          {$t(isLocal || isCli ? 'llm.state.idle_detect' : 'llm.state.idle_key')}
        {/if}
      </div>

      {#if phase === 'error' && view?.actionKey}
        <div class="pc-row">
          {#if view.action === 'open_key' && provider.keyUrl}
            <a class="pc-btn ghost" href={provider.keyUrl} target="_blank" rel="noopener noreferrer">{$t(view.actionKey)} ↗</a>
          {:else}
            <button type="button" class="pc-btn ghost" on:click={runAction}>{$t(view.actionKey)}</button>
          {/if}
          {#if result?.error?.detail}
            <button type="button" class="pc-link" aria-expanded={showDetail} on:click={() => (showDetail = !showDetail)}>{$t('llm.details')}</button>
          {/if}
        </div>
        {#if showDetail}<pre class="pc-detail">{result?.error?.detail}</pre>{/if}
      {/if}
      {#if switched}<p class="pc-muted">{$t('llm.err.model_switched', { model: switched })}</p>{/if}

      {#if !isCli}
        <label class="pc-label" for="pc-model">{$t('llm.model_label')}</label>
        <input id="pc-model" class="pc-input" list="pc-models" bind:value={model} spellcheck="false" autocomplete="off" />
        <datalist id="pc-models">
          {#each options as o (o.value)}
            <option value={o.value}>{o.kind === 'recommended' ? $t('llm.model_recommended') : o.kind === 'fast' ? $t('llm.model_fast') : ''}</option>
          {/each}
        </datalist>
        {#if provider.connected && liveModels.length === 0}
          <button type="button" class="pc-link" on:click={loadLive}>{$t('llm.model_other')}</button>
        {/if}
      {/if}
      <p class="pc-muted pc-foot-note">{$t('llm.usage_note')}</p>
    </section>
  </div>

  <footer class="pc-foot">
    <button type="button" class="pc-btn ghost" on:click={() => dispatch('back')}>← {$t('llm.choose_other')}</button>
    <span class="pc-spacer"></span>
    {#if isLocal || isCli}
      <button type="button" class="pc-btn ghost" on:click={detect} disabled={phase === 'busy'}>
        {phase === 'found' || phase === 'error' ? $t('llm.redetect') : $t('llm.detect')}
      </button>
    {/if}
    {#if !isCli}
      <button type="button" class="pc-btn primary" on:click={() => connect()} disabled={!ready}>
        {phase === 'busy' && busyKey === 'llm.state.testing' ? $t('llm.connecting') : $t('llm.connect')}
      </button>
    {/if}
  </footer>
</div>

<style>
  .pc { display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 12px; max-height: min(560px, calc(100dvh - 170px)); }
  .pc-cols { display: grid; grid-template-columns: 1.15fr 1fr; gap: 12px; min-height: 0; }
  .pc-card {
    display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow: hidden;
    padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2);
  }
  .pc-head { display: flex; gap: 12px; align-items: flex-start; }
  .pc-head img { border-radius: 8px; }
  .pc-title { margin: 0; font-size: 17px; font-weight: 700; color: var(--text-1); }
  .pc-rec { margin-left: 8px; font-size: 12px; font-weight: 600; color: var(--gold); }
  .pc-blurb { margin: 2px 0 0; font-size: 13px; color: var(--text-1); line-height: 1.45; }
  .pc-muted { margin: 0; font-size: 12px; color: var(--text-2); line-height: 1.45; }
  .pc-steps { margin: 2px 0; padding: 0; list-style: none; display: grid; gap: 6px; }
  .pc-steps li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; color: var(--text-1); }
  .pc-n {
    display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%;
    background: var(--surface-3); color: var(--teal); font-size: 11px; font-weight: 700;
  }
  .pc-open { font-size: 12px; color: var(--teal); text-decoration: none; }
  .pc-open:hover { text-decoration: underline; }
  .pc-label { margin: 4px 0 0; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; color: var(--text-2); }
  .pc-input {
    width: 100%; min-height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface-1); color: var(--text-1); font-family: var(--font-mono); font-size: 13px;
  }
  .pc-input:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  .pc-warn { margin: 0; font-size: 12px; color: var(--orange); }
  .pc-cmd { display: flex; gap: 8px; align-items: center; }
  .pc-cmd code {
    flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; padding: 8px 10px; border-radius: var(--radius-sm);
    background: var(--surface-1); border: 1px solid var(--border); font-family: var(--font-mono); font-size: 12px; color: var(--text-1);
  }
  .pc-state {
    display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 8px 12px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--surface-1); font-size: 13px; color: var(--text-1);
  }
  .pc-state.ok { border-color: color-mix(in srgb, var(--green) 45%, var(--border)); color: var(--green); }
  .pc-state.err { border-color: color-mix(in srgb, var(--red) 45%, var(--border)); color: var(--red); }
  .pc-spin {
    width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border-h); border-top-color: var(--teal);
    animation: pc-rot 0.8s linear infinite;
  }
  @keyframes pc-rot { to { transform: rotate(360deg); } }
  .pc-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .pc-detail {
    margin: 0; max-height: 84px; overflow: auto; padding: 8px; border-radius: var(--radius-sm);
    background: var(--surface-1); font-family: var(--font-mono); font-size: 11px; color: var(--text-2); white-space: pre-wrap;
  }
  .pc-link {
    display: inline-flex; align-items: center; align-self: flex-start; min-height: 40px; padding: 0 2px;
    border: 0; background: none; color: var(--teal); font-size: 12px; cursor: pointer;
  }
  .pc-link:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .pc-foot-note { margin-top: auto; }
  .pc-foot { display: flex; align-items: center; gap: 8px; }
  .pc-spacer { flex: 1; }
  .pc-btn {
    min-height: 40px; padding: 8px 16px; border-radius: var(--radius-sm); font-size: 14px; font-weight: 600;
    cursor: pointer; text-decoration: none; display: inline-flex; align-items: center;
    transition: background 150ms ease-out, border-color 150ms ease-out;
  }
  .pc-btn:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .pc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .pc-btn.ghost { border: 1px solid var(--border); background: transparent; color: var(--text-1); }
  .pc-btn.ghost:hover:not(:disabled) { border-color: var(--border-h); }
  .pc-btn.primary { border: 1px solid var(--teal); background: var(--teal); color: #06201d; }
  @media (max-width: 760px) {
    .pc { max-height: none; }
    .pc-cols { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pc-spin { animation: none; }
    .pc-btn { transition: none; }
  }
</style>
