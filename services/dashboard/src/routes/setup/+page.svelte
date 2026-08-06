<script lang="ts">
  /**
   * First-run setup wizard — 3 steps:
   *   0 — Language (ES / EN, persisted via setUserLocale)
   *   1 — LLM provider (registry-driven list from GET /api/config/ai/providers,
   *       key input per schema, live test via GET /api/config/ai/test, skip option)
   *   2 — Done (summary + SetupChecklist + "Go to Settings")
   *
   * Strings go through the global $lib/i18n dictionaries (setup.* keys plus a
   * few reused welcome.setup_* keys) so the language toggle drives everything.
   *
   * Provider config saves follow the same pattern as the Settings providers
   * card: GET /api/llm-providers/:slug/config → merge edits (never write
   * masked secrets back) → PUT. The chat/agents default brain is set with
   * POST /api/config/ai when the user picked a provider.
   *
   * Completion is recorded in localStorage as `kernl.setupComplete=1`,
   * which +layout.svelte checks to skip re-prompting on subsequent visits.
   */
  import { onMount } from 'svelte';
  import OfficeStep from '$lib/components/setup/OfficeStep.svelte';
  import { goto } from '$app/navigation';
  import { t, locale, setUserLocale, type Locale } from '$lib/i18n/index.js';
  import SetupChecklist from '$lib/components/settings/SetupChecklist.svelte';

  // ── Types ─────────────────────────────────────────────────────
  interface ProviderField {
    key: string;
    label: string;
    type: string;
    required?: boolean;
    placeholder?: string;
  }
  interface ProviderRow {
    slug: string;
    name: string;
    source: string;
    ready: boolean;
    error?: string;
    schema: ProviderField[];
    values: Record<string, string>;
  }
  interface TestResult { ok: boolean; latencyMs?: number; models?: string[]; error?: string }

  const jsonHeaders = { 'Content-Type': 'application/json' };
  async function jfetch(url: string, opts: RequestInit = {}): Promise<any> {
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as any)?.error || `HTTP ${r.status}`);
    return data;
  }

  // ── Wizard state ──────────────────────────────────────────────
  // 4 steps: language -> provider -> hire a team -> done. The team step exists
  // because finishing setup on an empty 3D floor is the worst first impression
  // this product can make.
  const TOTAL = 4;
  let step = 0;

  // Step 0 — language
  type Lang = 'es' | 'en';
  let chosenLang: Lang = 'es';
  $: chosenLangLabel = chosenLang === 'es' ? $t('setup.lang_es') : $t('setup.lang_en');
  async function pickLang(l: Lang): Promise<void> {
    chosenLang = l;
    await setUserLocale(l as Locale); // persists in localStorage immediately
  }

  // Step 1 — LLM provider
  let provLoading = true;
  let provError = '';
  let providerRows: ProviderRow[] = [];
  let chosen = 'skip'; // provider slug or 'skip'
  let edits: Record<string, Record<string, string>> = {};
  let llmTesting = false;
  let llmSaving = false;
  let llmStatus: 'idle' | 'ok' | 'err' = 'idle';
  let llmErrMsg = '';
  let llmModels: string[] = [];
  let llmModelChoice = '';
  /** Why the kernel says no agent can run yet. Empty when it can. */
  let readinessMsg = '';
  let probedSlug: string | null = null; // which slug the current ✓ belongs to

  $: selectedRow = providerRows.find((p) => p.slug === chosen) ?? null;

  const isUnset = (v: string | undefined) => !v || v === '(not set)';

  function initEdits(rows: ProviderRow[]): void {
    const e: Record<string, Record<string, string>> = {};
    for (const row of rows) {
      const m: Record<string, string> = {};
      for (const f of row.schema ?? []) {
        m[f.key] = f.type === 'password' ? '' : (row.values?.[f.key] ?? '');
      }
      e[row.slug] = m;
    }
    edits = e;
  }

  function providerConfigured(row: ProviderRow): boolean {
    if (row.ready) return true;
    return (row.schema ?? []).some(
      (f) => f.type === 'password' && !isUnset(row.values?.[f.key]),
    );
  }

  /** Required fields that are neither freshly typed nor already configured. */
  function missingRequired(row: ProviderRow): boolean {
    return (row.schema ?? []).some((f) => {
      if (!f.required) return false;
      if ((edits[row.slug]?.[f.key] ?? '').trim() !== '') return false;
      return isUnset(row.values?.[f.key]);
    });
  }

  function pickProvider(slug: string): void {
    chosen = slug;
    llmStatus = 'idle';
    llmErrMsg = '';
    llmModels = [];
    llmModelChoice = '';
    probedSlug = null;
  }

  /** registry slug → /api/config/ai/test result id */
  function testIdFor(slug: string): string {
    return slug === 'claude' ? 'anthropic' : slug;
  }

  /**
   * Same merge pattern as Settings → Providers: PUT replaces settings_json
   * wholesale, so merge over the raw config and only overwrite secrets the
   * user actually typed (never send masked strings back).
   */
  async function saveProviderConfig(row: ProviderRow): Promise<void> {
    const e = edits[row.slug] ?? {};
    const cur = await jfetch(`/api/llm-providers/${encodeURIComponent(row.slug)}/config`);
    const merged: Record<string, unknown> = { ...(cur.config ?? {}) };
    for (const f of row.schema ?? []) {
      const v = e[f.key] ?? '';
      if (f.type === 'password') {
        if (v !== '') merged[f.key] = v;
      } else {
        merged[f.key] = v;
      }
    }
    await jfetch(`/api/llm-providers/${encodeURIComponent(row.slug)}/config`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ config: merged }),
    });
    // PUT hot-reloads only providers that were already running — make sure
    // it's up before probing.
    await fetch(`/api/llm-providers/${encodeURIComponent(row.slug)}/start`, { method: 'POST' }).catch(() => null);
  }

  /** Save the config, then probe connectivity through the kernel. */
  async function testLLM(): Promise<boolean> {
    const row = selectedRow;
    if (!row) return true;
    if (missingRequired(row)) {
      llmStatus = 'err';
      llmErrMsg = $t('setup.llm_err_nokey');
      return false;
    }
    llmTesting = true;
    llmStatus = 'idle';
    llmErrMsg = '';
    llmModels = [];
    try {
      await saveProviderConfig(row);
      const results = (await jfetch('/api/config/ai/test')) as Record<string, TestResult>;
      const r = results[testIdFor(row.slug)];
      if (!r) throw new Error(`no test result for ${row.slug}`);
      if (!r.ok) throw new Error(r.error || 'connection failed');
      llmModels = r.models ?? [];
      if (llmModels.length > 0 && !llmModels.includes(llmModelChoice)) {
        llmModelChoice = llmModels[0];
      }
      probedSlug = row.slug;
      llmStatus = 'ok';
      return true;
    } catch (e) {
      llmStatus = 'err';
      llmErrMsg = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      llmTesting = false;
    }
  }

  async function commitLLMAndContinue(): Promise<void> {
    if (chosen === 'skip') return; // no longer reachable — the card is gone
    llmSaving = true;
    readinessMsg = '';
    try {
      // Next without a prior successful probe runs the probe itself.
      if (probedSlug !== chosen) {
        const ok = await testLLM();
        if (!ok) return;
      }
      // Chosen provider becomes the default chat/agents brain. Models are
      // only sent when the probe listed some (POST applies fields partially).
      const body: Record<string, string> = { chatProvider: chosen, agentsProvider: chosen };
      if (llmModelChoice) {
        body.chatModel = llmModelChoice;
        body.agentsModel = llmModelChoice;
      }
      await jfetch('/api/config/ai', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }).catch(() => null);

      // The connection test above proves the credential answers. It does not
      // prove the provider will execute a tool call, and an agent that cannot
      // call tools cannot do anything at all — which is the failure this whole
      // step exists to prevent. Ask the kernel to prove it before stepping on.
      const verdict = await recheckReadiness();
      if (!verdict.ok) {
        readinessMsg = verdict.detail || $t('setup.llm_not_agent_ready');
        return;
      }
      // Slight delay so the user sees the success state before stepping on.
      setTimeout(next, 400);
    } finally {
      llmSaving = false;
    }
  }

  /**
   * Ask the kernel to run a real tool call against the configured chain.
   *
   * Separate from `testLLM` on purpose: that one lists models and proves the
   * key is accepted, this one proves an agent can run. Claude Code passes the
   * first and fails the second — its `capabilities.tools` is false.
   */
  async function recheckReadiness(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const r = await fetch('/api/llm/readiness/recheck', { method: 'POST', headers: jsonHeaders });
      if (!r.ok) return { ok: false, detail: `readiness check failed (HTTP ${r.status})` };
      return (await r.json()) as { ok: boolean; detail?: string };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── Step transitions ──────────────────────────────────────────
  function next(): void {
    if (step < TOTAL - 1) step++;
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function back(): void {
    if (step > 0) step--;
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function finish(dest = '/settings?welcome=1'): void {
    try {
      localStorage.setItem('kernl.setupComplete', '1');
      // Mirror the legacy welcomeSeen flag so /welcome doesn't re-trigger.
      localStorage.setItem('kernl.welcomeSeen', '1');
    } catch { /* private browsing */ }
    goto(dest);
  }

  onMount(() => {
    chosenLang = $locale === 'en' ? 'en' : 'es';
    void (async () => {
      try {
        const data = (await jfetch('/api/config/ai/providers')) as { providers?: ProviderRow[] };
        providerRows = data.providers ?? [];
        initEdits(providerRows);
        const ready = providerRows.find((p) => p.ready);
        if (ready) chosen = ready.slug;
        provError = '';
      } catch (e) {
        provError = e instanceof Error ? e.message : String(e);
      } finally {
        provLoading = false;
      }
    })();
  });

  $: stepLabel =
    step === 0 ? $t('setup.step_language')
    : step === 1 ? $t('setup.step_llm')
    : step === 2 ? 'Your team'
    : $t('setup.step_done');
</script>

<svelte:head>
  <title>{$t('setup.title')} — Kernl</title>
</svelte:head>

<div class="wizard">
  <!-- Subtle grid background -->
  <div class="bg-grid" aria-hidden="true"></div>

  <!-- Top bar: brand + lang toggle -->
  <header class="topbar">
    <div class="brand">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id="w-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#0d1020"/>
            <stop offset="100%" stop-color="#1a1f35"/>
          </linearGradient>
          <linearGradient id="w-core" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#6366f1"/>
            <stop offset="100%" stop-color="#4f46e5"/>
          </linearGradient>
          <linearGradient id="w-glow" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#3dd6c8"/>
            <stop offset="100%" stop-color="#06b6d4"/>
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="14" fill="url(#w-bg)"/>
        <circle cx="32" cy="32" r="22" fill="none" stroke="#2a3050" stroke-width="2.5"/>
        <line x1="32" y1="10" x2="32" y2="22" stroke="#3dd6c8" stroke-width="1.5" opacity="0.6"/>
        <line x1="32" y1="42" x2="32" y2="54" stroke="#3dd6c8" stroke-width="1.5" opacity="0.6"/>
        <line x1="10" y1="32" x2="22" y2="32" stroke="#3dd6c8" stroke-width="1.5" opacity="0.6"/>
        <line x1="42" y1="32" x2="54" y2="32" stroke="#3dd6c8" stroke-width="1.5" opacity="0.6"/>
        <polygon points="32,20 42,26 42,38 32,44 22,38 22,26" fill="url(#w-core)" opacity="0.9"/>
        <text x="32" y="36" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="14" fill="white">K</text>
        <circle cx="32" cy="10" r="3" fill="url(#w-glow)"/>
        <circle cx="32" cy="54" r="3" fill="url(#w-glow)"/>
        <circle cx="10" cy="32" r="3" fill="url(#w-glow)"/>
        <circle cx="54" cy="32" r="3" fill="url(#w-glow)"/>
      </svg>
      <div class="brand-text">
        <b>Kernl</b>
        <span>{$t('setup.brand_tagline')}</span>
      </div>
    </div>

    <div class="lang-toggle" role="group" aria-label="Language">
      <button
        type="button"
        class:active={$locale === 'es'}
        aria-pressed={$locale === 'es'}
        on:click={() => pickLang('es')}>ES</button>
      <button
        type="button"
        class:active={$locale !== 'es'}
        aria-pressed={$locale !== 'es'}
        on:click={() => pickLang('en')}>EN</button>
    </div>
  </header>

  <!-- Progress -->
  <div class="progress-shell">
    <div class="progress-meta">
      <span class="step-label">{stepLabel}</span>
      <span class="step-count">{$t('setup.progress', { current: step + 1, total: TOTAL })}</span>
    </div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: {((step + 1) / TOTAL) * 100}%"></div>
    </div>
  </div>

  <main class="content">

    {#if step === 0}
      <!-- ─────────────────────────── Step 1 ─ Language ─── -->
      <section class="step-card">
        <h2>{$t('setup.lang_title')}</h2>
        <p class="step-lede">{$t('setup.lang_lede')}</p>

        <div class="option-grid two">
          <button
            type="button"
            class="option-card"
            class:selected={chosenLang === 'es'}
            on:click={() => pickLang('es')}>
            <span class="opt-radio" aria-hidden="true"></span>
            <div class="opt-body">
              <div class="opt-title">{$t('setup.lang_es')}</div>
              <div class="opt-desc">{$t('setup.lang_es_desc')}</div>
            </div>
            <span class="opt-flag" aria-hidden="true">ES</span>
          </button>

          <button
            type="button"
            class="option-card"
            class:selected={chosenLang === 'en'}
            on:click={() => pickLang('en')}>
            <span class="opt-radio" aria-hidden="true"></span>
            <div class="opt-body">
              <div class="opt-title">{$t('setup.lang_en')}</div>
              <div class="opt-desc">{$t('setup.lang_en_desc')}</div>
            </div>
            <span class="opt-flag" aria-hidden="true">EN</span>
          </button>
        </div>

        <div class="nav end">
          <button class="btn-primary" on:click={next}>{$t('setup.btn_next')}</button>
        </div>
      </section>

    {:else if step === 1}
      <!-- ─────────────────────────── Step 2 ─ LLM provider ─── -->
      <section class="step-card">
        <h2>{$t('setup.llm_title')}</h2>
        <p class="step-lede">{$t('setup.llm_lede')}</p>

        {#if provLoading}
          <p class="status">{$t('welcome.setup_llm_loading')}</p>
        {:else}
          {#if provError}
            <p class="status err">⚠ {$t('setup.llm_load_error')}</p>
          {/if}

          <div class="option-grid one">
            {#each providerRows as row (row.slug)}
              <button
                type="button"
                class="option-card"
                class:selected={chosen === row.slug}
                on:click={() => pickProvider(row.slug)}>
                <span class="opt-radio" aria-hidden="true"></span>
                <div class="opt-body">
                  <div class="opt-title">
                    {row.name || row.slug}
                    {#if providerConfigured(row)}
                      <span class="badge ok">{$t('settings.ai.ready')}</span>
                    {/if}
                  </div>
                  <div class="opt-sub">{row.slug}</div>

                  {#if chosen === row.slug && edits[row.slug] && (row.schema ?? []).length > 0}
                    <div class="prov-fields">
                      {#each row.schema ?? [] as f (f.key)}
                        <label class="prov-field">
                          <span class="prov-flabel">{f.label || f.key}{f.required ? ' *' : ''}</span>
                          {#if f.type === 'password'}
                            <input
                              type="password"
                              class="key-input"
                              bind:value={edits[row.slug][f.key]}
                              placeholder={isUnset(row.values?.[f.key])
                                ? (f.placeholder ?? $t('setup.llm_key_placeholder'))
                                : row.values[f.key]}
                              autocomplete="off"
                              spellcheck="false"
                              on:click|stopPropagation
                            />
                          {:else}
                            <input
                              type="text"
                              class="key-input"
                              bind:value={edits[row.slug][f.key]}
                              placeholder={f.placeholder ?? ''}
                              autocomplete="off"
                              spellcheck="false"
                              on:click|stopPropagation
                            />
                          {/if}
                        </label>
                      {/each}
                    </div>
                  {/if}
                </div>
              </button>
            {/each}

            <!-- The "continue without a provider" card used to live here. It
                 produced an install where every agent failed on its first run,
                 which is not a state worth offering as a choice. -->
          </div>

          {#if chosen !== 'skip' && selectedRow}
            <div class="llm-actions">
              <button class="btn-ghost btn-test" on:click={testLLM} disabled={llmTesting || llmSaving}>
                {llmTesting ? $t('setup.llm_testing') : $t('setup.llm_test')}
              </button>
            </div>
          {/if}

          {#if llmTesting}
            <p class="status">{$t('setup.llm_testing')}</p>
          {:else if llmStatus === 'ok' && probedSlug === chosen}
            <p class="status ok">
              {llmModels.length > 0
                ? $t('setup.llm_connected', { n: llmModels.length })
                : $t('setup.llm_ok')}
            </p>
            {#if llmModels.length > 0}
              <label class="model-pick">
                <span>{$t('setup.llm_model_label')}</span>
                <select bind:value={llmModelChoice}>
                  {#each llmModels as m (m)}
                    <option value={m}>{m}</option>
                  {/each}
                </select>
              </label>
            {/if}
          {:else if llmStatus === 'err'}
            <p class="status err">⚠ {llmErrMsg}</p>
          {/if}

          <!-- The key was accepted and the provider still could not run a tool
               call, so no agent would work. Says which, so the next move is
               obvious instead of guesswork. -->
          {#if readinessMsg}
            <p class="status err">⚠ {readinessMsg}</p>
          {/if}
        {/if}

        <div class="nav">
          <button class="btn-ghost" on:click={back}>{$t('setup.btn_back')}</button>
          <button
            class="btn-primary"
            on:click={commitLLMAndContinue}
            disabled={llmSaving || llmTesting || provLoading || chosen === 'skip'}
            title={chosen === 'skip' ? $t('setup.llm_required_hint') : ''}>
            {llmSaving ? $t('setup.btn_saving') : $t('setup.btn_next')}
          </button>
        </div>
      </section>

    {:else if step === 2}
      <!-- ───────────────────── Step 3 ─ Hire a team ─── -->
      <section class="step-card">
        <OfficeStep on:done={next} />
      </section>

    {:else}
      <!-- ─────────────────────────── Step 4 ─ Done ─── -->
      <section class="step-card done">
        <div class="done-medal" aria-hidden="true">
          <svg viewBox="0 0 64 64">
            <defs>
              <linearGradient id="medal" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#3dd6c8"/>
                <stop offset="100%" stop-color="#06b6d4"/>
              </linearGradient>
            </defs>
            <circle cx="32" cy="32" r="28" fill="url(#medal)" opacity="0.15"/>
            <circle cx="32" cy="32" r="20" fill="url(#medal)" opacity="0.4"/>
            <path d="M22 32 L29 39 L43 25" stroke="#3dd6c8" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h2>{$t('setup.done_title')}</h2>
        <p class="step-lede">{$t('setup.done_lede')}</p>

        <div class="summary">
          <div class="summary-row">
            <span class="summary-k">{$t('setup.done_lang')}</span>
            <span class="summary-v">{chosenLangLabel}</span>
          </div>
          <div class="summary-row">
            <span class="summary-k">{$t('setup.done_llm')}</span>
            <!-- No "skipped" branch: reaching this step means a provider ran a
                 tool call, so there is always a name to show. -->
            <span class="summary-v">{selectedRow?.name ?? chosen}</span>
          </div>
        </div>

        <SetupChecklist />

        <div class="nav center">
          <button class="btn-primary big" on:click={() => finish('/agents-flow')}>{$t('setup.done_cta_office')}</button>
          <button class="btn-ghost big" on:click={() => finish('/settings?welcome=1')}>{$t('setup.done_cta_settings')}</button>
        </div>

        <p class="reset-hint">
          {$t('setup.done_revisit')}
          <code>localStorage.removeItem('kernl.setupComplete')</code>
        </p>
      </section>
    {/if}

  </main>
</div>

<style>
  .wizard {
    position: relative;
    min-height: 100vh;
    background: radial-gradient(ellipse at top, #161a30 0%, #0d1020 50%, #07080c 100%);
    color: #e4e7f1;
    font-family: ui-sans-serif, system-ui, -apple-system, "Inter", "Segoe UI", sans-serif;
    padding: 24px 24px 96px;
    overflow-x: hidden;
  }

  .bg-grid {
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(rgba(99,102,241,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(99,102,241,0.04) 1px, transparent 1px);
    background-size: 48px 48px;
    pointer-events: none;
    z-index: 0;
  }

  .topbar, .progress-shell, .content { position: relative; z-index: 1; }

  /* ── Top bar ───────────────────────────────────────────── */
  .topbar {
    max-width: 1040px;
    margin: 8px auto 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand svg { width: 36px; height: 36px; flex-shrink: 0; }
  .brand-text { font-size: 13px; line-height: 1.3; }
  .brand-text b { display: block; color: #fff; font-size: 15px; }
  .brand-text span { color: #8b91a8; }

  .lang-toggle {
    display: inline-flex;
    border: 1px solid #232742;
    border-radius: 999px;
    overflow: hidden;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .lang-toggle button {
    padding: 4px 12px;
    background: transparent;
    border: 0;
    color: #8b91a8;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    cursor: pointer;
    line-height: 1;
    transition: background 0.12s, color 0.12s;
  }
  .lang-toggle button:hover { color: #fff; }
  .lang-toggle button.active {
    background: linear-gradient(135deg, #6366f1, #4f46e5);
    color: #fff;
  }

  /* ── Progress bar ──────────────────────────────────────── */
  .progress-shell {
    max-width: 1040px;
    margin: 0 auto 32px;
  }
  .progress-meta {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 8px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .step-label {
    font-size: 13px;
    color: #fff;
    font-weight: 600;
  }
  .step-count {
    font-size: 11px;
    color: #6c7191;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .progress-bar {
    height: 3px;
    background: #1d2138;
    border-radius: 999px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #6366f1, #3dd6c8);
    border-radius: 999px;
    transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }

  /* ── Content shell ─────────────────────────────────────── */
  .content {
    max-width: 1040px;
    margin: 0 auto;
  }

  /* ── Step card ─────────────────────────────────────────── */
  .step-card {
    background: rgba(255,255,255,0.015);
    border: 1px solid #1d2138;
    border-radius: 16px;
    padding: 36px 32px;
    box-shadow: 0 4px 32px rgba(0,0,0,0.3);
  }
  .step-card h2 {
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: 0 0 8px;
    color: #fff;
  }
  .step-lede {
    max-width: 64ch;
    color: #b8bdd1;
    font-size: 14px;
    line-height: 1.6;
    margin: 0 0 28px;
  }

  /* ── Option cards (radio cards) ────────────────────────── */
  .option-grid {
    display: grid;
    gap: 10px;
  }
  /* Two-choice steps stay narrow and centred — stretching two cards across a
     1040px shell reads as a mistake. */
  .option-grid.two { grid-template-columns: 1fr 1fr; max-width: 720px; }
  /* The provider step has six options. As a single column it needed scrolling
     on every laptop; auto-fit turns the spare width into columns so the whole
     choice is visible at once, which is the point of a chooser. */
  /* stretch, not start: ragged card heights inside a row read as broken. */
  .option-grid.one { grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); align-items: stretch; }
  .option-grid.one > * { height: 100%; }
  @media (max-width: 600px) {
    .option-grid.two { grid-template-columns: 1fr; }
  }
  .option-card {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    text-align: left;
    padding: 18px 18px;
    background: rgba(99,102,241,0.04);
    border: 1px solid #232742;
    border-radius: 12px;
    cursor: pointer;
    color: inherit;
    font: inherit;
    transition: all 0.15s ease;
  }
  .option-card:hover {
    border-color: rgba(99,102,241,0.5);
    background: rgba(99,102,241,0.08);
  }
  .option-card.selected {
    border-color: #6366f1;
    background: rgba(99,102,241,0.12);
    box-shadow: 0 0 0 3px rgba(99,102,241,0.15), 0 4px 16px rgba(99,102,241,0.2);
  }
  .opt-radio {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid #3a3f5a;
    flex-shrink: 0;
    margin-top: 2px;
    transition: all 0.15s;
    position: relative;
  }
  .option-card.selected .opt-radio {
    border-color: #6366f1;
    background: #6366f1;
  }
  .option-card.selected .opt-radio::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #fff;
  }
  .opt-body { flex: 1; min-width: 0; }
  .opt-title {
    font-size: 15px;
    font-weight: 600;
    color: #fff;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .opt-sub {
    font-size: 12px;
    color: #8b91a8;
    margin-bottom: 4px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .opt-desc {
    font-size: 13px;
    color: #b8bdd1;
    line-height: 1.5;
    margin: 0;
  }
  .opt-flag {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.16em;
    color: #6c7191;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    align-self: flex-start;
    margin-top: 4px;
  }
  .badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 3px 9px;
    border-radius: 999px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .badge.ok {
    background: rgba(61,214,200,0.15);
    color: #3dd6c8;
    border: 1px solid rgba(61,214,200,0.3);
  }

  /* ── Provider config fields ────────────────────────────── */
  .prov-fields {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .prov-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .prov-flabel {
    font-size: 11px;
    color: #8b91a8;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: 0.04em;
  }
  .key-input {
    width: 100%;
    padding: 10px 12px;
    background: rgba(0,0,0,0.4);
    border: 1px solid #2a3050;
    border-radius: 8px;
    color: #d4d8e8;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13px;
    letter-spacing: 0.5px;
  }
  .key-input:focus {
    outline: none;
    border-color: #6366f1;
    box-shadow: 0 0 0 2px rgba(99,102,241,0.2);
  }

  /* ── Status messages ───────────────────────────────────── */
  .status {
    margin-top: 16px;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
    background: rgba(99,102,241,0.06);
    border: 1px solid #232742;
    color: #b8bdd1;
  }
  .status.ok {
    background: rgba(61,214,200,0.08);
    border: 1px solid rgba(61,214,200,0.3);
    color: #3dd6c8;
  }
  .status.err {
    background: rgba(255,100,100,0.08);
    border: 1px solid rgba(255,100,100,0.3);
    color: #ff8888;
  }

  /* ── LLM actions + model pick ──────────────────────────── */
  .llm-actions {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .btn-test { font-size: 13px; }
  .model-pick {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: #8b90b8;
  }
  .model-pick select {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    background: rgba(0,0,0,0.4);
    border: 1px solid #2a3050;
    border-radius: 8px;
    color: #d4d8e8;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px;
  }
  .model-pick select:focus {
    outline: none;
    border-color: #6366f1;
    box-shadow: 0 0 0 2px rgba(99,102,241,0.2);
  }

  /* ── Done step ─────────────────────────────────────────── */
  .step-card.done {
    text-align: center;
  }
  .done-medal {
    width: 80px;
    height: 80px;
    margin: 0 auto 20px;
  }
  .done-medal svg { width: 100%; height: 100%; }
  .step-card.done .step-lede { text-align: center; }
  .summary {
    text-align: left;
    margin: 0 0 16px;
    border: 1px solid #1d2138;
    border-radius: 10px;
    overflow: hidden;
  }
  .summary-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 16px;
    font-size: 13px;
  }
  .summary-row + .summary-row { border-top: 1px solid #1d2138; }
  .summary-k {
    color: #8b91a8;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .summary-v { color: #fff; font-weight: 600; text-align: right; }
  .step-card.done :global(.checklist) { margin-bottom: 8px; }
  .reset-hint {
    margin-top: 28px;
    font-size: 11px;
    color: #6c7191;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .reset-hint code {
    background: rgba(0,0,0,0.4);
    padding: 1px 6px;
    border-radius: 3px;
  }

  /* ── Buttons ───────────────────────────────────────────── */
  /* Sticks to the bottom of the card. The provider step is tall enough that
     Back/Continue fell below the fold on a laptop — the two controls that move
     the wizard forward were the ones you could not see. */
  .nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid #1d2138;
    position: sticky;
    bottom: 0;
    background: linear-gradient(to top, #10132a 72%, rgba(16,19,42,0));
    padding-bottom: 4px;
    z-index: 2;
  }
  .nav > * { flex: none; }
  .nav.center { justify-content: center; border-top: 0; padding-top: 16px; }
  .nav.end { justify-content: flex-end; }

  .btn-primary, .btn-ghost {
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    padding: 10px 20px;
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s ease;
    border: 1px solid transparent;
  }
  .btn-primary {
    background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
    color: #fff;
    box-shadow: 0 4px 16px rgba(99,102,241,0.3), inset 0 1px 0 rgba(255,255,255,0.2);
  }
  .btn-primary:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 8px 24px rgba(99,102,241,0.4), inset 0 1px 0 rgba(255,255,255,0.2);
    filter: brightness(1.05);
  }
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-primary.big {
    padding: 14px 32px;
    font-size: 15px;
    border-radius: 12px;
  }
  .btn-ghost {
    background: transparent;
    color: #b8bdd1;
    border-color: #232742;
  }
  .btn-ghost:hover:not(:disabled) {
    color: #fff;
    border-color: #6366f1;
    background: rgba(99,102,241,0.08);
  }
  .btn-ghost:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Mobile ────────────────────────────────────────────── */
  @media (max-width: 540px) {
    .wizard { padding: 16px 16px 64px; }
    .step-card { padding: 24px 20px; }
    .topbar { flex-wrap: wrap; }
  }
</style>
