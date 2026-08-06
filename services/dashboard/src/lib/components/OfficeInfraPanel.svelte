<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getOfficeEnv, configureOfficeEnv, officeEnvAction, type OfficeEnvStatus, type OfficeEnvConfig } from '$lib/api.js';

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

  const STATE_META: Record<string, { label: string; glyph: string }> = {
    running: { label: 'running', glyph: '●' },
    paused:  { label: 'pausado',   glyph: '⏸' },
    exited:  { label: 'apagado',   glyph: '⏹' },
    created: { label: 'creado',    glyph: '◔' },
    absent:  { label: 'sin entorno', glyph: '◌' },
    error:   { label: 'error',     glyph: '⚠' },
  };

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
    if (action === 'stop' && !confirm('Shut down this office environment? Running processes stop (the container can be restarted).')) return;
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

  $: meta = STATE_META[status?.state ?? 'absent'] ?? STATE_META.absent;
  $: st = status?.state ?? 'absent';

  // A container that exists is something you must be able to see and stop,
  // whoever is selected. Only 'absent' stays folded.
  $: if (!autoOpened && status && st !== 'absent') { autoOpened = true; open = true; }

  onMount(() => {
    load();
    poll = setInterval(() => { if (!busy) officeEnvAction('status', flowId).then((r) => (status = r.status)).catch(() => {}); }, 5000);
  });
  onDestroy(() => { if (poll) clearInterval(poll); });

  // Reload when the office changes (panel reused across agents).
  let lastFlow = flowId;
  $: if (flowId !== lastFlow) { lastFlow = flowId; loading = true; autoOpened = false; open = !startCollapsed; load(); }

  // Same panel, next agent: re-apply the fold the new selection asks for.
  let lastCollapsed = startCollapsed;
  $: if (startCollapsed !== lastCollapsed) { lastCollapsed = startCollapsed; autoOpened = false; open = !startCollapsed; }
</script>

<div class="oi" class:oi-folded={!open} style="--oi-color:{color}">
  <button class="oi-head" aria-expanded={open} on:click={() => (open = !open)}>
    <span class="oi-caret" class:open aria-hidden="true">▸</span>
    <span class="oi-title">Entorno de la oficina{officeName ? ' · ' + officeName : ''}</span>
    {#if status}
      <span class="oi-badge oi-{st}">{meta.glyph} {meta.label}</span>
    {/if}
  </button>

  {#if !open}
    <!-- folded: the header row is the whole component -->
  {:else if loading}
    <div class="oi-muted">Loading environment…</div>
  {:else}
    {#if reconnecting}
      <div class="oi-muted">Reconnecting to the kernel…</div>
    {:else if error}
      <div class="oi-err">{error}</div>
    {/if}

    <div class="oi-row"><span class="oi-k">imagen</span><code>{config?.image ?? '—'}</code></div>
    {#if status?.preview_url}
      <div class="oi-row"><span class="oi-k">preview</span>
        <a href={status.preview_url} target="_blank" rel="noopener noreferrer">{status.preview_url}</a>
      </div>
    {/if}

    <div class="oi-actions">
      {#if st === 'running'}
        <button on:click={() => act('pause')} disabled={busy}>⏸ Pausar</button>
        <button on:click={() => act('restart')} disabled={busy}>↻ Restart</button>
        <button class="oi-danger" on:click={() => act('stop')} disabled={busy}>⏹ Shut down</button>
      {:else if st === 'paused'}
        <button on:click={() => act('resume')} disabled={busy}>▶ Reanudar</button>
        <button class="oi-danger" on:click={() => act('stop')} disabled={busy}>⏹ Shut down</button>
      {:else if st === 'error'}
        <span class="oi-muted">Docker no disponible</span>
      {:else}
        <button class="oi-primary" on:click={() => act('up')} disabled={busy}>⏻ Start</button>
      {/if}
    </div>

    <button class="oi-cfg-toggle" on:click={() => (showConfig = !showConfig)}>{showConfig ? '▾' : '▸'} Configurar</button>
    {#if showConfig}
      <div class="oi-cfg">
        <label>imagen <input bind:value={fImage} placeholder="oven/bun:1" /></label>
        <label>ports <input bind:value={fPorts} placeholder="4321:4321, 8080:80" /></label>
        <label>run command <input bind:value={fRun} placeholder="bun run dev" /></label>
        <label>network <input bind:value={fNetwork} placeholder="mtwkernel_default" /></label>
        <button class="oi-primary" on:click={saveConfig} disabled={busy}>Save</button>
      </div>
    {/if}
  {/if}
</div>

<style>
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
