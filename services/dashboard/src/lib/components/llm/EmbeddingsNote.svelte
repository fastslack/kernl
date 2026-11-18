<script lang="ts">
  /**
   * Settings → AI: one line on what search-by-meaning runs on — model,
   * device (CPU / CoreML / DirectML / CUDA) and why — plus the source
   * picker (EMBEDDINGS_PROVIDER) and how far the background re-embed has got.
   * Reads GET /api/embeddings/status; the picker writes PUT /api/settings,
   * after which the kernel swaps the client and re-embeds on its own.
   */
  import { onDestroy, onMount } from 'svelte';
  import { t } from '$lib/i18n/index.js';

  interface Status {
    enabled: boolean;
    provider?: string;
    model?: string;
    dim?: number;
    activeProvider?: string;
    lastResort?: boolean;
    local?: { device: string | null; deviceReason: string | null; loaded: boolean; dtype: string } | null;
    reembed?: { running: boolean; pending: Record<string, number>; lastError: string | null } | null;
  }

  type Mode = 'local' | 'auto' | 'lmstudio';

  let status: Status | null = null;
  let mode: Mode = 'local';
  let saving = false;
  let error = '';
  let timer: ReturnType<typeof setInterval> | null = null;

  const DEVICE_NAMES: Record<string, string> = { cpu: 'CPU', coreml: 'CoreML (GPU)', dml: 'DirectML (GPU)', cuda: 'CUDA (GPU)' };

  $: pending = status?.reembed ? Object.values(status.reembed.pending ?? {}).reduce((a, b) => a + b, 0) : 0;
  $: shortModel = (status?.model ?? '').replace(/^Xenova\//, '');

  async function load(): Promise<void> {
    try {
      const r = await fetch('/api/embeddings/status');
      if (!r.ok) return; // older kernel: no note
      status = (await r.json()) as Status;
    } catch { /* offline: the page shows that elsewhere */ }
  }

  async function loadMode(): Promise<void> {
    try {
      const r = await fetch('/api/settings/catalog');
      if (!r.ok) return;
      const body = (await r.json()) as { settings?: Array<{ key: string; value: string }> } | Array<{ key: string; value: string }>;
      const list = Array.isArray(body) ? body : body.settings ?? [];
      const v = (list.find((s) => s.key === 'EMBEDDINGS_PROVIDER')?.value ?? '').trim().toLowerCase();
      mode = v === 'auto' || v === 'lmstudio' ? v : 'local';
    } catch { /* keep the default */ }
  }

  async function setMode(next: Mode): Promise<void> {
    if (next === mode || saving) return;
    const prev = mode;
    mode = next;
    saving = true;
    error = '';
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: { EMBEDDINGS_PROVIDER: next } }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // The kernel rebuilds the client in the background; give it a moment.
      setTimeout(() => void load(), 1500);
    } catch (e) {
      mode = prev;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function onPick(e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    void setMode(v === 'auto' || v === 'lmstudio' ? v : 'local');
  }

  onMount(() => {
    timer = setInterval(() => void load(), 10_000);
    void load();
    void loadMode();
  });
  onDestroy(() => { if (timer) clearInterval(timer); });
</script>

{#if status}
  <section class="emb" aria-label={$t('llm.emb.title')}>
    <div class="emb-main">
      <span class="emb-k">{$t('llm.emb.title')}</span>
      {#if status.enabled}
        <strong>{shortModel}</strong>
        <span class="emb-muted">{status.dim}d · {status.activeProvider ?? status.provider}</span>
        {#if status.local}
          {#if status.local.device}
            <!-- The reason is the kernel's log line (English): a tooltip, not body text. -->
            <span class="emb-dev" title={status.local.deviceReason ?? ''}>{$t('llm.emb.on_device', { device: DEVICE_NAMES[status.local.device] ?? status.local.device })} ⓘ</span>
          {:else}
            <span class="emb-muted">{$t('llm.emb.waiting')}</span>
          {/if}
        {/if}
      {:else}
        <span class="emb-muted">{$t('llm.emb.disabled')}</span>
      {/if}
      <label class="emb-mode">
        <span class="emb-k">{$t('llm.emb.mode')}</span>
        <select value={mode} disabled={saving} on:change={onPick}>
          <option value="local">{$t('llm.emb.mode_local')}</option>
          <option value="auto">{$t('llm.emb.mode_auto')}</option>
          <option value="lmstudio">{$t('llm.emb.mode_lmstudio')}</option>
        </select>
      </label>
    </div>
    {#if status.lastResort}<p class="emb-line emb-warn">{$t('llm.emb.last_resort')}</p>{/if}
    {#if status.reembed?.lastError}
      <p class="emb-line emb-warn">{$t('llm.emb.reembed_error', { error: status.reembed.lastError })}</p>
    {:else if pending > 0}
      <p class="emb-line emb-muted">{$t('llm.emb.reembed', { n: pending })}</p>
    {/if}
    {#if error}<p class="emb-line emb-warn" role="alert">{error}</p>{/if}
    <p class="emb-line emb-muted">{$t('llm.emb.mode_hint')}</p>
  </section>
{/if}

<style>
  .emb { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); padding: 10px 14px; display: flex; flex-direction: column; gap: 4px; }
  .emb-main { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 14px; color: var(--text-1); }
  .emb-k { color: var(--text-3); font-size: 13px; }
  .emb-muted { color: var(--text-3); font-size: 13px; }
  .emb-dev { font-size: 13px; color: var(--text-2); }
  .emb-warn { color: var(--warning, #b7791f); font-size: 13px; }
  .emb-line { margin: 0; }
  .emb-mode { margin-left: auto; display: inline-flex; align-items: baseline; gap: 6px; }
  .emb-mode select { font: inherit; font-size: 13px; }
  @media (max-width: 640px) { .emb-mode { margin-left: 0; } }
</style>
