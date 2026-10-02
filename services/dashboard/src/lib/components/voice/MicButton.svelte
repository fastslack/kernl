<script lang="ts">
  /**
   * One click to talk. Click starts recording; the message ends by itself
   * when you stop talking (see Endpointer), or with a second click; Escape
   * throws it away. While recording, a level meter shows what the mic is
   * picking up — the first thing to look at when Kernl mishears.
   *
   * Starting a recording also silences any reply being read out.
   *
   * Emits `transcript` with what was heard. An empty transcript never leaves
   * this component; instead it says why (nothing heard, too quiet, clipping).
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { Recorder, micSupport, type MicSupport } from '$lib/voice/recorder.js';
  import { transcribe, speech, levelAdvice, VoiceOffError } from '$lib/voice/speech.js';
  import { Endpointer, meterFraction } from '$lib/voice/endpoint.js';
  import { browserProcessing } from '$lib/voice/prefs.js';

  export let disabled = false;
  /** Square size in px — matches the send button it sits beside. */
  export let size = 36;

  const dispatch = createEventDispatcher<{ transcript: string }>();

  let support: MicSupport = 'ok';
  let state: 'idle' | 'starting' | 'recording' | 'transcribing' = 'idle';
  let notice = '';
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let level = 0;
  let elapsed = 0;
  let heard = false;
  let loop: ReturnType<typeof setInterval> | null = null;
  const recorder = new Recorder();
  let endpointer = new Endpointer();

  onMount(() => { support = micSupport(); });
  onDestroy(() => {
    stopLoop();
    recorder.cancel();
    if (noticeTimer) clearTimeout(noticeTimer);
    window.removeEventListener('keydown', onWindowKey);
  });

  function flash(msg: string, ms = 5000) {
    notice = msg;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = ''; }, ms);
  }

  function stopLoop() {
    if (loop) { clearInterval(loop); loop = null; }
  }

  async function start() {
    if (disabled || state !== 'idle') return;
    if (support !== 'ok') {
      flash(support === 'insecure' ? $t('voice.mic.insecure') : $t('voice.mic.unsupported'), 7000);
      return;
    }
    speech.stop();
    notice = '';
    state = 'starting';
    try {
      await recorder.start({ browserProcessing: $browserProcessing });
    } catch (err) {
      state = 'idle';
      const name = (err as DOMException)?.name;
      flash(name === 'NotAllowedError' || name === 'SecurityError' ? $t('voice.mic.denied') : String((err as Error)?.message ?? err), 7000);
      return;
    }
    state = 'recording';
    endpointer = new Endpointer();
    heard = false;
    elapsed = 0;
    window.addEventListener('keydown', onWindowKey);
    loop = setInterval(() => {
      const db = recorder.levelDb();
      level = meterFraction(db);
      elapsed = recorder.elapsedMs;
      if (!recorder.metered) return; // no meter: only the second click ends it
      const d = endpointer.push(db, elapsed);
      heard = endpointer.heardSpeech;
      if (d === 'stop') void finish();
      else if (d === 'no-speech') cancel($t('voice.mic.no_speech', { db: Math.round(endpointer.peakDb) }));
    }, 50);
  }

  function cancel(why = '') {
    stopLoop();
    window.removeEventListener('keydown', onWindowKey);
    recorder.cancel();
    state = 'idle';
    level = 0;
    if (why) flash(why, 7000);
  }

  async function finish() {
    if (state !== 'recording') return;
    stopLoop();
    window.removeEventListener('keydown', onWindowKey);
    level = 0;
    const rec = await recorder.stop();
    state = 'transcribing';
    try {
      const r = await transcribe(rec.blob, rec.mime);
      const advice = levelAdvice(r.levels, $t);
      if (r.text) {
        dispatch('transcript', r.text);
        if (advice) flash(advice, 7000);
      } else {
        flash(advice || $t('voice.mic.nothing'), 7000);
      }
    } catch (err) {
      flash(err instanceof VoiceOffError ? $t('voice.mic.off') : String((err as Error)?.message ?? err), 7000);
    } finally {
      state = 'idle';
    }
  }

  function click() {
    if (state === 'idle') void start();
    else if (state === 'recording') void finish();
  }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && state === 'recording') {
      e.preventDefault();
      cancel();
    }
  }

  $: label = state === 'recording'
    ? $t('voice.mic.recording')
    : state === 'transcribing'
      ? $t('voice.mic.transcribing')
      : support === 'insecure'
        ? $t('voice.mic.insecure')
        : $t('voice.mic.click');
</script>

<span class="mic-wrap">
  <button
    type="button"
    class="mic"
    class:rec={state === 'recording' || state === 'starting'}
    class:busy={state === 'transcribing'}
    class:unavailable={support !== 'ok'}
    style="--mic-size:{size}px; --lvl:{level}"
    disabled={disabled || state === 'transcribing'}
    aria-label={label}
    aria-pressed={state === 'recording'}
    title={label}
    on:click={click}
  >
    {#if state === 'transcribing'}
      <span class="mic-spinner" aria-hidden="true"></span>
    {:else if state === 'recording'}
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
    {:else}
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
        <path d="M12 18v4" />
      </svg>
    {/if}
  </button>
  {#if state === 'recording'}
    <span class="mic-pop mic-live" aria-live="polite">
      <span class="mic-meter" aria-hidden="true"><span class="mic-meter-fill" style="width:{Math.round(level * 100)}%"></span></span>
      <span>{Math.floor(elapsed / 1000)}s · {heard ? $t('voice.mic.listening_heard') : $t('voice.mic.listening')}</span>
    </span>
  {:else if notice}
    <span class="mic-pop" role="status">{notice}</span>
  {/if}
</span>

<style>
  .mic-wrap { position: relative; display: inline-flex; flex-shrink: 0; }

  .mic {
    width: var(--mic-size); height: var(--mic-size);
    display: grid; place-items: center;
    border-radius: 8px;
    border: 1px solid rgba(120, 130, 160, .25);
    background: rgba(120, 130, 160, .08);
    color: #c4c8d6;
    cursor: pointer;
    transition: background .15s, border-color .15s, color .15s, box-shadow .08s;
  }
  .mic:hover:not(:disabled) { background: rgba(120, 130, 160, .16); color: #e0e2ea; }
  .mic:focus-visible { outline: 2px solid var(--flow-color, #3dd6c8); outline-offset: 2px; }
  .mic:disabled { opacity: .45; cursor: not-allowed; }
  .mic.unavailable { opacity: .55; }

  /* The ring grows with the input level: a live "it hears me". */
  .mic.rec {
    background: #e5484d; border-color: #e5484d; color: #fff;
    box-shadow: 0 0 0 calc(2px + var(--lvl) * 9px) rgba(229, 72, 77, .35);
  }

  .mic-spinner {
    width: 13px; height: 13px; border-radius: 50%;
    border: 2px solid rgba(196, 200, 214, .3);
    border-top-color: #c4c8d6;
    animation: mic-spin .7s linear infinite;
  }
  @keyframes mic-spin { to { transform: rotate(360deg); } }

  .mic-pop {
    position: absolute; bottom: calc(100% + 10px); right: 0;
    width: max-content; max-width: min(340px, 80vw);
    padding: 6px 10px; border-radius: 6px;
    background: #1b1f2a; border: 1px solid rgba(120, 130, 160, .3);
    color: #e0e2ea; font: 500 11px/1.4 'Manrope', sans-serif;
    box-shadow: 0 6px 20px rgba(0, 0, 0, .35);
    z-index: 20; pointer-events: none;
    white-space: normal;
  }
  .mic-live { display: flex; align-items: center; gap: 8px; color: #ffb4b6; }
  .mic-meter { width: 70px; height: 6px; border-radius: 3px; background: rgba(255, 255, 255, .1); overflow: hidden; }
  .mic-meter-fill { display: block; height: 100%; background: linear-gradient(90deg, #4fd69a 0 70%, #f0b43c 70% 90%, #e5484d 90%); transition: width .05s linear; }

  @media (prefers-reduced-motion: reduce) {
    .mic-spinner { animation: none; }
    .mic.rec { box-shadow: none; }
  }
</style>
