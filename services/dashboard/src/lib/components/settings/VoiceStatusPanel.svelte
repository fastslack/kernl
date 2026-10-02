<script lang="ts">
  /**
   * Top of the Voice card: which engine listens and which speaks right now,
   * a button to hear the voice, and the per-browser "review before sending"
   * switch. Re-reads the status after each save so a changed engine shows.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { speakText, speech, speaking, speechError } from '$lib/voice/speech.js';
  import { confirmBeforeSend } from '$lib/voice/prefs.js';
  import MicCheck from './MicCheck.svelte';

  /** Bump to make the panel re-read the status (after a save). */
  export let refreshKey = 0;

  interface EngineStatus { engine: string; ready: boolean; downloadable?: boolean; reason?: string }
  interface Side { setting: string; active: string | null; engines: EngineStatus[] }
  interface Status {
    enabled: boolean;
    stt: Side & { model: string };
    tts: Side & { voice: string };
  }

  let status: Status | null = null;
  let loadError = '';

  async function load() {
    try {
      const r = await fetch('/api/voice/status');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      status = await r.json();
      loadError = '';
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  }
  onMount(load);
  $: if (refreshKey) load();

  function state(side: Side): { cls: string; text: string; title: string } {
    const e = side.engines.find((x) => x.engine === side.active);
    if (!e) {
      const why = side.engines.map((x) => `${x.engine}: ${x.reason ?? '—'}`).join('\n');
      return { cls: 'bad', text: $t('settings.voice.missing'), title: why };
    }
    return e.ready
      ? { cls: 'ok', text: $t('settings.voice.ready'), title: '' }
      : { cls: 'warn', text: $t('settings.voice.download'), title: e.reason ?? '' };
  }

  function test() {
    if ($speaking) { speech.stop(); return; }
    speakText($t('settings.voice.test_phrase'));
  }
</script>

<div class="vs">
  {#if loadError}
    <div class="vs-err">{loadError}</div>
  {:else if status}
    <div class="vs-row">
      <span class="vs-lbl">{$t('settings.voice.listen')}</span>
      <span class="vs-eng">{status.stt.active ?? '—'}<span class="vs-sub">{status.stt.active === 'whispercpp' ? ` · ${status.stt.model}` : ''}</span></span>
      {#each [state(status.stt)] as st}
        <span class="vs-pill {st.cls}" title={st.title}>{st.text}</span>
      {/each}
    </div>
    <div class="vs-row">
      <span class="vs-lbl">{$t('settings.voice.speak')}</span>
      <span class="vs-eng">{status.tts.active ?? '—'}<span class="vs-sub"> · {status.tts.voice}</span></span>
      {#each [state(status.tts)] as st}
        <span class="vs-pill {st.cls}" title={st.title}>{st.text}</span>
      {/each}
      <button type="button" class="vs-test" on:click={test} disabled={!status.enabled}>
        {$speaking ? '■' : '▶'} {$t('settings.voice.test')}
      </button>
    </div>
    {#if $speechError}<div class="vs-err">{$speechError}</div>{/if}
    <label class="vs-check">
      <input type="checkbox" bind:checked={$confirmBeforeSend} />
      <span>{$t('voice.confirm.label')}</span>
    </label>
    <MicCheck />
  {/if}
</div>

<style>
  .vs {
    display: flex; flex-direction: column; gap: 6px;
    padding: 10px 12px; margin-bottom: 10px;
    border-radius: 8px;
    background: rgba(120, 130, 160, .06);
    border: 1px solid rgba(120, 130, 160, .15);
    font: 500 12px 'Manrope', sans-serif;
  }
  .vs-row { display: flex; align-items: center; gap: 10px; min-height: 26px; flex-wrap: wrap; }
  .vs-lbl { width: 72px; color: var(--text-muted, #8a8fa3); }
  .vs-eng { font-weight: 600; color: var(--text, #e0e2ea); }
  .vs-sub { font-weight: 400; color: var(--text-muted, #8a8fa3); }
  .vs-pill { padding: 2px 8px; border-radius: 100px; font-size: 10.5px; }
  .vs-pill.ok { background: rgba(61, 214, 140, .15); color: #4fd69a; }
  .vs-pill.warn { background: rgba(240, 180, 60, .15); color: #f0b43c; }
  .vs-pill.bad { background: rgba(229, 72, 77, .15); color: #ff8a8d; }
  .vs-test {
    margin-left: auto;
    padding: 4px 10px; border-radius: 6px;
    border: 1px solid rgba(120, 130, 160, .3);
    background: transparent; color: var(--text, #e0e2ea);
    font: inherit; cursor: pointer;
  }
  .vs-test:disabled { opacity: .4; cursor: not-allowed; }
  .vs-check { display: flex; align-items: center; gap: 8px; color: var(--text-muted, #8a8fa3); cursor: pointer; }
  .vs-err { color: #ff8a8d; font-size: 11px; }
</style>
