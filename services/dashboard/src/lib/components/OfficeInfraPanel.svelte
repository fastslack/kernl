<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getOfficeEnv, configureOfficeEnv, officeEnvAction, type OfficeEnvStatus, type OfficeEnvConfig } from '$lib/api.js';
  import { t } from '$lib/i18n/index.js';

  /** The office (flow) whose shared environment this controls. */
  export let flowId: string;
  export let officeName = '';
  export let color = '#c9a84c';
  /** Start folded to the header row. Set for agents that cannot reach a shell
   *  or a filesystem — a Docker image and a Start button mean nothing to an
   *  agent that only calls a model. The environment is office-scoped and this
   *  is its only entry point in the dashboard, so it is folded, never removed,
   *  and an environment that is actually up unfolds itself below. */
  export let startCollapsed = false;

  let open = !startCollapsed;
  /** Only auto-unfold once per office, so a manual fold stays folded. */
  let autoOpened = false;

  /**
   * The office environment ships with the paid DevOps extension, so on an
   * install without it `/api/office-env` is not mounted at all. That is not an
   * error to report — it is a feature this install does not have. The card
   * removes itself instead of rendering a failure for something nobody broke.
   */
  let unavailable = false;
  let status: OfficeEnvStatus | null = null;
  let config: OfficeEnvConfig | null = null;
  let loading = true;
  let busy = false;
  let error = '';
  let showConfig = false;
  let poll: ReturnType<typeof setInterval> | null = null;

  // Editable config fields (bound in the expander).
  let fImage = '';
  let fPorts = '';
  let fRun = '';
  let fNetwork = '';

  const STATE_GLYPH: Record<string, string> = {
    running: '●', paused: '⏸', exited: '⏹', created: '◔', absent: '◌', error: '⚠',
  };
  /** `absent` is "not set up" only while no image was ever chosen; once one is,
   *  the honest word for a container that is not there is "stopped". */
  $: stateLabel =
    st === 'absent'
      ? (configured ? $t('office.env.state.exited') : $t('office.env.unset'))
      : $t(`office.env.state.${st}`);

  /** The whole point of the redesign: an office starts with no image, and the
   *  card asks instead of showing one nobody picked. */
  $: configured = !!(config?.image ?? '').trim();

  /** Four ordinary starting points plus an escape hatch. Not a catalogue —
   *  the field below takes any image. */
  const PRESETS = [
    { id: 'oven/bun:1',   label: 'Bun',    sub: 'bun, node-compatible' },
    { id: 'node:22',      label: 'Node',   sub: 'npm, pnpm, yarn' },
    { id: 'python:3.12',  label: 'Python', sub: 'pip, venv' },
    { id: 'debian:stable-slim', label: 'Plain Linux', sub: 'nothing preinstalled' },
  ];
  let chosenPreset = '';
  let customImage = '';
  $: pendingImage = chosenPreset === 'other' ? customImage.trim() : chosenPreset;

  async function setUpEnvironment(): Promise<void> {
    if (!pendingImage) return;
    busy = true; error = '';
    try {
      const r = await configureOfficeEnv(flowId, {
        image: pendingImage,
        ports: fPorts.split(',').map((v) => v.trim()).filter(Boolean),
        run_command: fRun,
        network: fNetwork.trim(),
      });
      config = r.config; status = r.status;
      fImage = r.config.image;
    } catch (e: any) {
      error = e?.message ?? String(e);
    } finally {
      busy = false;
    }
  }

  let reconnecting = false;
  async function load(retries = 3) {
    try {
      const r = await getOfficeEnv(flowId);
      config = r.config; status = r.status;
      fImage = config.image;
      fPorts = JSON.parse(config.ports_json || '[]').join(', ');
      fRun = config.run_command;
      fNetwork = config.network;
      error = ''; reconnecting = false;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // 502/Bad Gateway/network = the kernel is restarting (not an office problem):
      // reintentar en silencio en vez de mostrar un error crudo + "undefined".
      // 404 = the routes are not mounted (no DevOps licence). Distinct from a
      // 502 while the kernel restarts, which is worth retrying.
      if (/\b404\b|not found/i.test(msg)) {
        unavailable = true;
        error = '';
        return;
      }
      const transient = /bad gateway|502|503|504|fetch|network|failed to fetch/i.test(msg);
      if (transient && retries > 0) {
        reconnecting = true;
        setTimeout(() => load(retries - 1), 1500);
        return;
      }
      error = msg; reconnecting = false;
    } finally {
      loading = false;
    }
  }

  async function act(action: 'up' | 'pause' | 'resume' | 'stop' | 'restart') {
    if (busy) return;
    if (action === 'stop' && !confirm($t('office.env.stop_confirm'))) return;
    busy = true; error = '';
    try {
      const r = await officeEnvAction(action, flowId);
      status = r.status;
    } catch (e: any) {
      error = e?.message ?? String(e);
    } finally {
      busy = false;
    }
  }

  async function saveConfig() {
    busy = true; error = '';
    try {
      const ports = fPorts.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await configureOfficeEnv(flowId, { image: fImage.trim(), ports, run_command: fRun, network: fNetwork.trim() });
      config = r.config; status = r.status; showConfig = false;
    } catch (e: any) {
      error = e?.message ?? String(e);
    } finally {
      busy = false;
    }
  }

  $: st = status?.state ?? 'absent';
  $: glyph = STATE_GLYPH[st] ?? STATE_GLYPH.absent;

  // A container that exists is something you must be able to see and stop,
  // whoever is selected. Only 'absent' stays folded.
  $: if (!autoOpened && status && st !== 'absent') { autoOpened = true; open = true; }

  onMount(() => {
    load();
    poll = setInterval(() => {
      if (busy || unavailable) return;
      officeEnvAction('status', flowId).then((r) => (status = r.status)).catch(() => {});
    }, 5000);
  });
  onDestroy(() => { if (poll) clearInterval(poll); });

  // Reload when the office changes (panel reused across agents).
  let lastFlow = flowId;
  $: if (flowId !== lastFlow) { lastFlow = flowId; loading = true; autoOpened = false; open = !startCollapsed; load(); }

  // Same panel, next agent: re-apply the fold the new selection asks for.
  let lastCollapsed = startCollapsed;
  $: if (startCollapsed !== lastCollapsed) { lastCollapsed = startCollapsed; autoOpened = false; open = !startCollapsed; }
</script>

{#if unavailable}
  <!-- nothing: this install has no DevOps licence, so it has no office
       environments to show. -->
{:else}
<div class="oi" class:oi-folded={!open} style="--oi-color:{color}">
  <button class="oi-head" aria-expanded={open} on:click={() => (open = !open)}>
    <span class="oi-caret" class:open aria-hidden="true">▸</span>
    <span class="oi-title">{$t('office.env.title')}{officeName ? ' · ' + officeName : ''}</span>
    {#if status}
      <span class="oi-badge oi-{st}">{glyph} {stateLabel}</span>
    {/if}
  </button>

  {#if !open}
    <!-- folded: the header row is the whole component -->
  {:else if loading}
    <div class="oi-muted">{$t('office.env.loading')}</div>
  {:else}
    {#if reconnecting}
      <div class="oi-muted">{$t('office.env.reconnecting')}</div>
    {:else if error}
      <div class="oi-err">{error}</div>
    {/if}

    {#if !configured}
      <!-- Unconfigured is the starting state, and it says what the thing is
           before asking anything. The card used to open on `IMAGEN oven/bun:1`
           — a value nobody chose, presented as a fact, next to a Start button
           that never explained what it would do. -->
      <p class="oi-what">{$t('office.env.what')}</p>

      {#if st === 'error'}
        <div class="oi-muted">{$t('office.env.no_docker')}</div>
      {:else}
        <div class="oi-setup-label">{$t('office.env.choose')}</div>
        <div class="oi-presets" role="radiogroup" aria-label={$t('office.env.choose')}>
          {#each PRESETS as p (p.id)}
            <button
              type="button" class="oi-preset" class:oi-preset-on={chosenPreset === p.id}
              role="radio" aria-checked={chosenPreset === p.id} disabled={busy}
              on:click={() => (chosenPreset = p.id)}
            >
              <span class="oi-preset-t">{p.label}</span>
              <span class="oi-preset-s">{p.sub}</span>
            </button>
          {/each}
          <button
            type="button" class="oi-preset" class:oi-preset-on={chosenPreset === 'other'}
            role="radio" aria-checked={chosenPreset === 'other'} disabled={busy}
            on:click={() => (chosenPreset = 'other')}
          >
            <span class="oi-preset-t">{$t('office.env.other')}</span>
            <span class="oi-preset-s">{$t('office.env.other_ph')}</span>
          </button>
        </div>
        {#if chosenPreset === 'other'}
          <input
            class="oi-in" bind:value={customImage} disabled={busy}
            placeholder={$t('office.env.other_ph')} aria-label={$t('office.env.other')}
          />
        {/if}
        <p class="oi-hint">{$t('office.env.choose_hint')}</p>

        <div class="oi-actions">
          <button class="oi-primary" on:click={setUpEnvironment} disabled={busy || !pendingImage}>
            {$t('office.env.save')}
          </button>
        </div>
      {/if}

    {:else}
      <div class="oi-row"><span class="oi-k">{$t('office.env.image')}</span><code>{config?.image}</code></div>
      {#if status?.preview_url}
        <div class="oi-row"><span class="oi-k">{$t('office.env.preview')}</span>
          <a href={status.preview_url} target="_blank" rel="noopener noreferrer">{status.preview_url}</a>
        </div>
      {/if}

      <div class="oi-actions">
        {#if st === 'running'}
          <button on:click={() => act('pause')} disabled={busy}>⏸ {$t('office.env.pause')}</button>
          <button on:click={() => act('restart')} disabled={busy}>↻ {$t('office.env.restart')}</button>
          <button class="oi-danger" on:click={() => act('stop')} disabled={busy}>⏹ {$t('office.env.stop')}</button>
        {:else if st === 'paused'}
          <button on:click={() => act('resume')} disabled={busy}>▶ {$t('office.env.resume')}</button>
          <button class="oi-danger" on:click={() => act('stop')} disabled={busy}>⏹ {$t('office.env.stop')}</button>
        {:else if st === 'error'}
          <span class="oi-muted">{$t('office.env.no_docker')}</span>
        {:else}
          <button class="oi-primary" on:click={() => act('up')} disabled={busy}>
            ⏻ {busy ? $t('office.env.starting') : $t('office.env.start')}
          </button>
        {/if}
      </div>
      {#if st !== 'running' && st !== 'paused' && st !== 'error'}
        <!-- Says what the button will do before it is pressed, instead of
             leaving a minute of silence to be read as a hang. -->
        <p class="oi-hint">{$t('office.env.start_hint')}</p>
      {/if}

      <button class="oi-cfg-toggle" aria-expanded={showConfig} on:click={() => (showConfig = !showConfig)}>
        {showConfig ? '▾' : '▸'} {$t('office.env.advanced')}
      </button>
      {#if showConfig}
        <div class="oi-cfg">
          <label for="oi-image">{$t('office.env.image')}</label>
          <input id="oi-image" bind:value={fImage} placeholder="oven/bun:1" />

          <label for="oi-ports">{$t('office.env.ports')}</label>
          <input id="oi-ports" bind:value={fPorts} placeholder="4321:4321, 8080:80" />
          <p class="oi-hint">{$t('office.env.ports_hint')}</p>

          <label for="oi-run">{$t('office.env.run')}</label>
          <input id="oi-run" bind:value={fRun} placeholder="bun run dev" />
          <p class="oi-hint">{$t('office.env.run_hint')}</p>

          <label for="oi-net">{$t('office.env.network')}</label>
          <input id="oi-net" bind:value={fNetwork} placeholder="kernl_default" />
          <p class="oi-hint">{$t('office.env.network_hint')}</p>

          <button class="oi-primary" on:click={saveConfig} disabled={busy}>{$t('office.env.save')}</button>
        </div>
      {/if}
    {/if}
  {/if}
</div>
{/if}


<style>
  /* Unconfigured-first styles. The card explains before it asks, so the
     explanation gets real line-height and the presets get room to be read. */
  .oi-what{margin:2px 0 10px;font:400 11px/1.55 'Manrope',sans-serif;color:var(--text-3,#8a8fa8)}
  .oi-setup-label{font:600 10px/1 'Manrope',sans-serif;text-transform:uppercase;letter-spacing:.07em;color:var(--text-2,#cbd0e8);margin-bottom:6px}
  .oi-presets{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:5px}
  .oi-preset{display:flex;flex-direction:column;gap:2px;text-align:left;padding:7px 9px;border:1px solid rgba(255,255,255,.08);border-radius:6px;background:rgba(255,255,255,.02);cursor:pointer;transition:border-color .12s,background .12s}
  .oi-preset:hover:not(:disabled){border-color:color-mix(in srgb,var(--oi-color,#c9a84c) 55%,transparent)}
  .oi-preset-on{border-color:var(--oi-color,#c9a84c);background:color-mix(in srgb,var(--oi-color,#c9a84c) 12%,transparent)}
  .oi-preset:disabled{opacity:.5;cursor:not-allowed}
  .oi-preset-t{font:600 12px/1.2 'Manrope',sans-serif;color:var(--text-1,#e6e9f5)}
  .oi-preset-s{font:400 10px/1.35 'Manrope',sans-serif;color:var(--text-3,#8a8fa8)}
  .oi-in{width:100%;margin-top:6px;padding:6px 9px;border-radius:6px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:var(--text-1,#e6e9f5);font:400 12px 'Geist Mono',monospace;box-sizing:border-box}
  .oi-in:focus{outline:none;border-color:var(--oi-color,#c9a84c)}
  /* Help text under the field it explains, not a tooltip nobody opens. */
  .oi-hint{margin:5px 0 0;font:400 10px/1.5 'Manrope',sans-serif;color:color-mix(in srgb,var(--text-3,#8a8fa8) 85%,transparent)}
  .oi-cfg label{display:block;margin-top:9px;font:600 10px/1 'Manrope',sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3,#8a8fa8)}

  /* A peer of the panel's other sections, not the hero it used to be: the
     office colour survives as a hairline, not as a wash over the largest box
     on screen. */
  .oi { margin-top: 4px; padding: 10px 12px; border-radius: 10px;
    background: rgba(120, 130, 160, .04);
    border: 1px solid rgba(120, 130, 160, .12);
    border-left: 2px solid color-mix(in srgb, var(--oi-color) 45%, transparent); }
  .oi-folded { background: none; }
  .oi-head { display: flex; align-items: center; gap: 8px; width: 100%;
    background: none; border: none; padding: 0; cursor: pointer; text-align: left; }
  .oi:not(.oi-folded) .oi-head { margin-bottom: 10px; }
  .oi-caret { flex-shrink: 0; font: 400 9px monospace; color: #6a6f82; transition: transform .2s; }
  .oi-caret.open { transform: rotate(90deg); }
  /* Same type as .ip-sec-h in the parent panel so the headings read as one set. */
  .oi-title { flex: 1; min-width: 0; font: 600 10px 'Syne', sans-serif; letter-spacing: 1.5px;
    text-transform: uppercase; color: #8a8fa8; }
  .oi-head:hover .oi-title { color: #d8dae3; }
  .oi-badge { font: 600 10px 'JetBrains Mono', monospace; padding: 2px 8px; border-radius: 10px;
    background: rgba(120,130,160,.14); color: #c0c5d8; }
  .oi-running { color: #7ed8a4; background: rgba(80,180,120,.16); }
  .oi-paused  { color: #e8c070; background: rgba(220,180,80,.16); }
  .oi-error   { color: #e88080; background: rgba(220,90,90,.16); }
  .oi-row { display: flex; gap: 8px; align-items: baseline; font-size: 12px; margin: 3px 0; color: #c0c5d8; }
  .oi-k { flex-shrink: 0; width: 54px; color: #7a7f96; font: 600 9px 'JetBrains Mono', monospace; text-transform: uppercase; }
  .oi-row code { font: 500 11px 'JetBrains Mono', monospace; color: #e2e4f0; }
  .oi-row a { color: #7ee0c8; word-break: break-all; }
  .oi-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .oi-actions button, .oi-cfg button { padding: 5px 12px; border-radius: 6px; cursor: pointer;
    font: 600 11px 'Manrope', sans-serif; border: 1px solid rgba(120,130,160,.25);
    background: rgba(120,130,160,.08); color: #d8dae3; }
  .oi-actions button:hover:not(:disabled) { background: rgba(120,130,160,.18); }
  .oi-actions button:disabled { opacity: .45; cursor: not-allowed; }
  /* Outlined, not filled: the panel already has one filled primary — Run now,
     in the header — and a section this far down must not outrank it. */
  .oi-primary { background: color-mix(in srgb, var(--oi-color) 10%, transparent) !important;
    color: color-mix(in srgb, var(--oi-color) 75%, #fff) !important;
    border: 1px solid color-mix(in srgb, var(--oi-color) 45%, transparent) !important; }
  .oi-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--oi-color) 20%, transparent) !important; }
  .oi-danger:hover:not(:disabled) { border-color: #e88080 !important; color: #e88080; }
  .oi-cfg-toggle { margin-top: 8px; background: none; border: none; color: #8a8fa8; cursor: pointer;
    font: 600 10px 'Manrope', sans-serif; padding: 0; }
  .oi-cfg { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .oi-cfg label { display: flex; flex-direction: column; gap: 2px; font: 600 9px 'JetBrains Mono', monospace;
    color: #7a7f96; text-transform: uppercase; }
  .oi-cfg input { padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(120,130,160,.25);
    background: rgba(0,0,0,.3); color: #e0e2ea; font: 400 12px 'JetBrains Mono', monospace; }
  .oi-muted { color: #6a6f82; font-size: 12px; }
  .oi-err { color: #e88080; font-size: 12px; margin-bottom: 6px; }
</style>
