<script lang="ts">
  /**
   * "How does my mic sound to Kernl?" Record one sentence the same way a
   * message is recorded, send it through the same transcription, and show
   * what came back: the kernel's own measurements (voice level, background,
   * SNR, clipping), what it understood, and the recording itself to listen to.
   */
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { Recorder, micSupport } from '$lib/voice/recorder.js';
  import { transcribe, speech, levelAdvice, type Heard } from '$lib/voice/speech.js';
  import { Endpointer, meterFraction } from '$lib/voice/endpoint.js';
  import { browserProcessing } from '$lib/voice/prefs.js';

  let state: 'idle' | 'recording' | 'transcribing' = 'idle';
  let level = 0;
  let result: Heard | null = null;
  let error = '';
  let playUrl = '';
  let loop: ReturnType<typeof setInterval> | null = null;
  const recorder = new Recorder();

  onDestroy(() => {
    if (loop) clearInterval(loop);
    recorder.cancel();
    if (playUrl) URL.revokeObjectURL(playUrl);
  });

  async function toggle() {
    if (state === 'recording') return finish();
    if (state !== 'idle') return;
    error = '';
    result = null;
    const support = micSupport();
    if (support !== 'ok') { error = support === 'insecure' ? $t('voice.mic.insecure') : $t('voice.mic.unsupported'); return; }
    speech.stop();
    try { await recorder.start({ browserProcessing: $browserProcessing }); } catch (err) {
      const name = (err as DOMException)?.name;
      error = name === 'NotAllowedError' ? $t('voice.mic.denied') : String((err as Error)?.message ?? err);
      return;
    }
    state = 'recording';
    const ep = new Endpointer();
    loop = setInterval(() => {
      const db = recorder.levelDb();
      level = meterFraction(db);
      const d = ep.push(db, recorder.elapsedMs);
      if (d !== 'listen') void finish();
    }, 50);
  }

  async function finish() {
    if (loop) { clearInterval(loop); loop = null; }
    level = 0;
    const rec = await recorder.stop();
    if (playUrl) URL.revokeObjectURL(playUrl);
    playUrl = URL.createObjectURL(rec.blob);
    state = 'transcribing';
    try {
      result = await transcribe(rec.blob, rec.mime);
    } catch (err) {
      error = String((err as Error)?.message ?? err);
    } finally {
      state = 'idle';
    }
  }

  $: advice = result ? levelAdvice(result.levels, $t) : '';
  const cls = (ok: boolean, warn = false) => (ok ? 'ok' : warn ? 'warn' : 'bad');
</script>

<div class="mc">
  <div class="mc-row">
    <button type="button" class="mc-btn" class:rec={state === 'recording'} on:click={toggle} disabled={state === 'transcribing'}>
      {state === 'recording' ? `■ ${$t('voice.check.stop')}` : state === 'transcribing' ? $t('voice.mic.transcribing') : `🎙 ${$t('voice.check.start')}`}
    </button>
    {#if state === 'recording'}
      <span class="mc-meter" aria-hidden="true"><span style="width:{Math.round(level * 100)}%"></span></span>
      <span class="mc-hint">{$t('voice.check.say')}</span>
    {:else if !result && !error}
      <span class="mc-hint">{$t('voice.check.desc')}</span>
    {/if}
  </div>

  <label class="mc-opt">
    <input type="checkbox" bind:checked={$browserProcessing} />
    <span>{$t('voice.check.browser_processing')}</span>
  </label>

  {#if error}<div class="mc-err">{error}</div>{/if}

  {#if result}
    {#if result.levels}
      {@const l = result.levels}
      <div class="mc-stats">
        <span class={cls(l.speechDb >= -40, l.speechDb >= -50)}>{$t('voice.check.voice')} {l.speechDb} dBFS</span>
        <span>{$t('voice.check.noise')} {l.noiseDb} dBFS</span>
        <span class={cls(l.snrDb >= 15, l.snrDb >= 10)}>SNR {l.snrDb} dB</span>
        <span class={cls(l.clippedPct < 1)}>{$t('voice.check.clip')} {l.clippedPct}%</span>
        {#if result.engine}<span>{result.engine} · {(result.ms / 1000).toFixed(1)}s</span>{/if}
      </div>
    {/if}
    <div class="mc-heard">
      <span class="mc-lbl">{$t('voice.check.heard')}</span>
      <span class="mc-text">{result.text ? `“${result.text}”` : '—'}</span>
      {#if playUrl}<audio src={playUrl} controls preload="none"></audio>{/if}
    </div>
    <div class="mc-verdict" class:fine={!advice}>{advice || $t('voice.check.fine')}</div>
  {/if}
</div>

<style>
  .mc { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; border-top: 1px dashed rgba(120, 130, 160, .2); }
  .mc-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .mc-btn {
    padding: 4px 10px; border-radius: 6px;
    border: 1px solid rgba(120, 130, 160, .3); background: transparent;
    color: var(--text, #e0e2ea); font: inherit; cursor: pointer;
  }
  .mc-btn.rec { background: #e5484d; border-color: #e5484d; color: #fff; }
  .mc-btn:disabled { opacity: .5; cursor: progress; }
  .mc-meter { width: 120px; height: 8px; border-radius: 4px; background: rgba(255, 255, 255, .08); overflow: hidden; }
  .mc-meter span { display: block; height: 100%; background: linear-gradient(90deg, #4fd69a 0 70%, #f0b43c 70% 90%, #e5484d 90%); transition: width .05s linear; }
  .mc-hint { color: var(--text-muted, #8a8fa3); font-size: 11px; }
  .mc-stats { display: flex; gap: 6px; flex-wrap: wrap; font-size: 11px; }
  .mc-stats span { padding: 2px 8px; border-radius: 100px; background: rgba(120, 130, 160, .1); color: var(--text-muted, #8a8fa3); }
  .mc-stats span.ok { background: rgba(61, 214, 140, .15); color: #4fd69a; }
  .mc-stats span.warn { background: rgba(240, 180, 60, .15); color: #f0b43c; }
  .mc-stats span.bad { background: rgba(229, 72, 77, .15); color: #ff8a8d; }
  .mc-heard { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .mc-lbl { color: var(--text-muted, #8a8fa3); }
  .mc-text { font-style: italic; color: var(--text, #e0e2ea); }
  .mc-heard audio { height: 28px; }
  .mc-verdict { font-size: 11.5px; color: #f0b43c; }
  .mc-verdict.fine { color: #4fd69a; }
  .mc-opt { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-muted, #8a8fa3); cursor: pointer; }
  .mc-err { color: #ff8a8d; font-size: 11px; }
</style>
