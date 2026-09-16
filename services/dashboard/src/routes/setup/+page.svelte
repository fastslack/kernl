<script lang="ts">
  /**
   * First-run setup wizard — 4 steps:
   *   0 — Language (ES / EN, persisted via setUserLocale)
   *   1 — Connect your AI: pick a provider from the kernel catalog, then
   *       connect it (tested with a real tool call before anything is saved)
   *   2 — Hire a team
   *   3 — Done
   *
   * Completion is recorded in localStorage as `kernl.setupComplete=1`,
   * which +layout.svelte checks to skip re-prompting on subsequent visits.
   */
  import { onMount } from 'svelte';
  import OfficeStep from '$lib/components/setup/OfficeStep.svelte';
  import { t, locale, setUserLocale, type Locale } from '$lib/i18n/index.js';
  import SetupChecklist from '$lib/components/settings/SetupChecklist.svelte';
  import ProviderGrid from '$lib/components/llm/ProviderGrid.svelte';
  import ProviderConnect from '$lib/components/llm/ProviderConnect.svelte';
  import { fetchCatalog, type CatalogResponse, type ProbeResult } from '$lib/llm-connect.js';

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

  // Step 1 — connect your AI
  let catalog: CatalogResponse | null = null;
  let catalogError = '';
  let chosenSlug = '';
  let connectedName = '';
  /** Why the kernel says no agent can run yet. Empty when it can. */
  let readinessMsg = '';

  $: chosenProvider = catalog?.providers.find((p) => p.slug === chosenSlug) ?? null;

  async function loadCatalog(): Promise<void> {
    try {
      catalog = await fetchCatalog();
      catalogError = '';
    } catch (e) {
      catalogError = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * The connect call already proved this provider answers with a tool call.
   * Readiness is rechecked anyway: it is the kernel's own verdict on the whole
   * chain, and the next step hires agents that depend on it.
   */
  async function onConnected(_e: CustomEvent<ProbeResult>): Promise<void> {
    connectedName = chosenProvider?.name ?? '';
    readinessMsg = '';
    const verdict = await recheckReadiness();
    if (!verdict.ok) {
      readinessMsg = verdict.detail || $t('setup.llm_not_agent_ready');
      return;
    }
    setTimeout(next, 700);
  }

  /**
   * Ask the kernel to run a real tool call against the configured chain.
   *
   * Separate from `connectProvider`'s own probe on purpose: that one proves
   * the provider just connected can run a tool call, this one is the kernel's
   * verdict on the whole chain (fallbacks included), which is what the next
   * step's agents actually depend on.
   */
  async function recheckReadiness(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const r = await fetch('/api/llm/readiness/recheck', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
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
    // Hard navigation, like /login does on success — not goto(). The wizard
    // runs in the shell-less layout, and a full load guarantees the dashboard
    // comes up against the post-setup server state instead of whatever the
    // pre-setup session had (or had not) fetched.
    window.location.href = dest;
  }

  onMount(() => {
    chosenLang = $locale === 'en' ? 'en' : 'es';
    void loadCatalog();
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
      <!-- ─────────────────────────── Step 2 ─ Connect your AI ─── -->
      <section class="step-card llm-step">
        {#if !chosenProvider}
          <h2>{$t('llm.title')}</h2>
          <p class="step-lede">{$t('llm.lede')}</p>
          {#if catalogError}
            <p class="status err" role="alert">⚠ {$t('setup.llm_load_error')}</p>
          {:else if !catalog}
            <p class="status">{$t('welcome.setup_llm_loading')}</p>
          {:else}
            <ProviderGrid providers={catalog.providers} on:select={(e) => (chosenSlug = e.detail)} />
          {/if}
          <!-- Leaving without a provider is a legitimate way to install: the
               gate only covers the routes that call a model, and the dashboard
               banner links back here. -->
          <div class="nav">
            <button class="btn-ghost" on:click={back}>{$t('setup.btn_back')}</button>
            <button class="btn-ghost" on:click={() => finish('/')} title={$t('setup.llm_later_hint')}>{$t('llm.skip')}</button>
          </div>
        {:else}
          {#key chosenProvider.slug}
            <ProviderConnect
              provider={chosenProvider}
              loginCommand={catalog?.claudeCodeLoginCommand ?? 'claude'}
              on:back={() => (chosenSlug = '')}
              on:connected={onConnected}
            />
          {/key}
          {#if readinessMsg}
            <p class="status err" role="alert">⚠ {readinessMsg}</p>
          {/if}
        {/if}
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
            <span class="summary-v">{connectedName}</span>
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

  /* The connect step has to fit one screen: grid + connect dialog, no scroll. */
  .llm-step { padding-top: 20px; padding-bottom: 20px; }
  .llm-step h2 { margin-bottom: 4px; }
  .llm-step .step-lede { margin-bottom: 14px; }

  /* ── Option cards (radio cards) ────────────────────────── */
  .option-grid {
    display: grid;
    gap: 10px;
  }
  /* Two-choice steps stay narrow and centred — stretching two cards across a
     1040px shell reads as a mistake. */
  .option-grid.two { grid-template-columns: 1fr 1fr; max-width: 720px; }
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
  .status.err {
    background: rgba(255,100,100,0.08);
    border: 1px solid rgba(255,100,100,0.3);
    color: #ff8888;
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
