<script lang="ts">
  /**
   * The speaker beside the mic: toggles reading replies out loud, and while
   * something is being read, becomes the button that stops it.
   */
  import { t } from '$lib/i18n/index.js';
  import { speakReplies } from '$lib/voice/prefs.js';
  import { speech, speaking, speechError } from '$lib/voice/speech.js';

  export let size = 36;

  function click() {
    if ($speaking) { speech.stop(); return; }
    speakReplies.update((v) => !v);
  }

  let errTimer: ReturnType<typeof setTimeout> | undefined;
  $: if ($speechError) {
    clearTimeout(errTimer);
    errTimer = setTimeout(() => speechError.set(''), 6000);
  }

  $: label = $speaking ? $t('voice.speak.stop') : $speakReplies ? $t('voice.speak.on') : $t('voice.speak.off');
</script>

<span class="spk-wrap">
  <button
    type="button"
    class="spk"
    class:on={$speakReplies}
    class:talking={$speaking}
    style="--spk-size:{size}px"
    aria-label={label}
    aria-pressed={$speakReplies}
    title={label}
    on:click={click}
  >
    {#if $speaking}
      <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
    {:else}
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M11 5 6 9H2v6h4l5 4V5z" />
        {#if $speakReplies}
          <path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a10 10 0 0 1 0 14" />
        {:else}
          <path d="m22 9-6 6" /><path d="m16 9 6 6" />
        {/if}
      </svg>
    {/if}
  </button>
  {#if $speechError}
    <span class="spk-pop" role="status">{$t('voice.speak.failed', { error: $speechError })}</span>
  {/if}
</span>

<style>
  .spk-wrap { position: relative; display: inline-flex; flex-shrink: 0; }
  .spk {
    width: var(--spk-size); height: var(--spk-size);
    display: grid; place-items: center;
    border-radius: 8px;
    border: 1px solid rgba(120, 130, 160, .25);
    background: transparent;
    color: #8a8fa3;
    cursor: pointer;
    transition: background .15s, color .15s, border-color .15s;
  }
  .spk:hover { background: rgba(120, 130, 160, .12); color: #e0e2ea; }
  .spk:focus-visible { outline: 2px solid var(--flow-color, #3dd6c8); outline-offset: 2px; }
  .spk.on { color: var(--flow-color, #3dd6c8); border-color: rgba(61, 214, 200, .4); }
  .spk.talking { color: #fff; background: rgba(61, 214, 200, .25); border-color: var(--flow-color, #3dd6c8); }
  .spk-pop {
    position: absolute; bottom: calc(100% + 8px); right: 0;
    width: max-content; max-width: min(320px, 80vw);
    padding: 6px 10px; border-radius: 6px;
    background: #1b1f2a; border: 1px solid rgba(229, 72, 77, .45);
    color: #ffb4b6; font: 500 11px/1.4 'Manrope', sans-serif;
    z-index: 20; pointer-events: none;
  }
</style>
