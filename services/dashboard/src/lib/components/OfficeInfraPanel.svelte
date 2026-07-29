<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getOfficeEnv, configureOfficeEnv, officeEnvAction, type OfficeEnvStatus, type OfficeEnvConfig } from '$lib/api.js';

  /** The office (flow) whose shared environment this controls. */
  export let flowId: string;
  export let officeName = '';
  export let color = '#c9a84c';

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

  onMount(() => {
    load();
    poll = setInterval(() => { if (!busy) officeEnvAction('status', flowId).then((r) => (status = r.status)).catch(() => {}); }, 5000);
  });
  onDestroy(() => { if (poll) clearInterval(poll); });

  // Reload when the office changes (panel reused across agents).
  let lastFlow = flowId;
  $: if (flowId !== lastFlow) { lastFlow = flowId; loading = true; load(); }
</script>

<div class="oi" style="--oi-color:{color}">
  <div class="oi-head">
    <span class="oi-title">Infraestructura{officeName ? ' · ' + officeName : ''}</span>
    {#if status}
      <span class="oi-badge oi-{st}">{meta.glyph} {meta.label}</span>
    {/if}
  </div>

  {#if loading}
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
  .oi { margin-top: 14px; padding: 12px; border-radius: 10px;
    background: color-mix(in srgb, var(--oi-color) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--oi-color) 24%, transparent); }
  .oi-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .oi-title { font: 700 10px 'Manrope', sans-serif; letter-spacing: 2px; text-transform: uppercase;
    color: color-mix(in srgb, var(--oi-color) 80%, #fff); }
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
  .oi-primary { background: var(--oi-color) !important; color: #14110a !important; border: none !important; }
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
