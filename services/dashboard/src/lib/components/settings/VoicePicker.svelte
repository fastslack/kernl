<script lang="ts">
  /**
   * Choose the voice Kernl speaks with: a grid of the voices the kernel
   * offers for the speaking engine in use, filterable by gender, each with a
   * ▶ to hear it before choosing. Binds the VOICE_TTS_VOICE value; "" means
   * the engine's default for the configured language.
   *
   * Country names come from Intl.DisplayNames in the UI locale, so the list
   * needs no translation table.
   */
  import { onMount } from 'svelte';
  import { t, locale } from '$lib/i18n/index.js';
  import { speakText, speech, speaking } from '$lib/voice/speech.js';

  export let value = '';
  /** VOICE_TTS_ENGINE as currently edited (auto | piper | openai | elevenlabs). */
  export let engine = 'auto';
  /** VOICE_LANGUAGE as currently edited — its voices come first. */
  export let language = 'es';

  interface VoiceOption {
    id: string;
    engine: 'piper' | 'openai';
    name: string;
    gender: 'female' | 'male' | 'neutral';
    country: string;
    lang: string;
    quality: 'high' | 'medium' | 'low';
    downloaded: boolean;
  }

  let voices: VoiceOption[] = [];
  let gender: 'all' | 'female' | 'male' = 'all';
  let showAll = false;
  let previewing = '';

  function setGender(g: string) {
    gender = g === 'female' || g === 'male' ? g : 'all';
  }

  onMount(async () => {
    try {
      const r = await fetch('/api/voice/status');
      if (r.ok) voices = ((await r.json()).voices ?? []).filter((v: unknown) => typeof v === 'object');
    } catch { /* the picker stays empty; the text fallback below still works */ }
  });

  $: kind = engine === 'openai' ? 'openai' : engine === 'elevenlabs' ? 'elevenlabs' : 'piper';
  $: lang = language && language !== 'auto' ? language.slice(0, 2) : 'es';
  $: pool = voices.filter((v) => v.engine === kind);
  $: ownLang = pool.filter((v) => kind === 'openai' || v.lang === lang);
  $: shown = (showAll || ownLang.length === 0 ? pool : ownLang)
    .filter((v) => gender === 'all' || v.gender === gender);
  $: hiddenCount = kind === 'piper' ? pool.length - ownLang.length : 0;

  function displayNames(loc: string): Intl.DisplayNames | null {
    try { return new Intl.DisplayNames([loc], { type: 'region' }); } catch { return null; }
  }
  $: regionNames = displayNames($locale);

  function flag(cc: string): string {
    if (!cc) return '🌐';
    return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  }

  function previewPhrase(v: VoiceOption): string {
    return v.lang === 'en' ? "Hi, I'm the Chief. What can I do for you?" : $t('settings.voice.test_phrase');
  }

  function preview(v: VoiceOption, e: MouseEvent) {
    e.stopPropagation();
    if (previewing === v.id && $speaking) { speech.stop(); previewing = ''; return; }
    speech.stop();
    previewing = v.id;
    speakText(previewPhrase(v), v.id);
  }
  $: if (!$speaking && previewing) {
    // Mark a first-time download as done once it has played.
    voices = voices.map((x) => (x.id === previewing ? { ...x, downloaded: true } : x));
    previewing = '';
  }

  const genderLabel = (g: string) =>
    g === 'female' ? $t('settings.voice.picker.female') : g === 'male' ? $t('settings.voice.picker.male') : $t('settings.voice.picker.neutral');
</script>

{#if kind === 'elevenlabs'}
  <input class="vp-id" bind:value placeholder={$t('settings.voice.picker.eleven_placeholder')} spellcheck="false" />
{:else}
  <div class="vp">
    <div class="vp-filters" role="group" aria-label={$t('settings.voice.picker.filter')}>
      {#each [['all', $t('settings.voice.picker.all')], ['female', $t('settings.voice.picker.female')], ['male', $t('settings.voice.picker.male')]] as [g, label]}
        <button type="button" class="vp-chip" class:on={gender === g} on:click={() => setGender(g)}>{label}</button>
      {/each}
      {#if hiddenCount > 0}
        <button type="button" class="vp-more" on:click={() => (showAll = !showAll)}>
          {showAll ? $t('settings.voice.picker.fewer_langs') : $t('settings.voice.picker.more_langs', { n: hiddenCount })}
        </button>
      {/if}
    </div>

    <div class="vp-grid" role="radiogroup" aria-label={$t('settings.voice.picker.label')}>
      <button type="button" class="vp-tile" class:sel={!value} role="radio" aria-checked={!value} on:click={() => (value = '')}>
        <span class="vp-flag" aria-hidden="true">✦</span>
        <span class="vp-main">
          <span class="vp-name">{$t('settings.voice.picker.default')}</span>
          <span class="vp-meta">{$t('settings.voice.picker.default_desc')}</span>
        </span>
      </button>
      {#each shown as v (v.id)}
        <div class="vp-tile" class:sel={value === v.id} role="radio" aria-checked={value === v.id} tabindex="0"
             on:click={() => (value = v.id)}
             on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); value = v.id; } }}>
          <span class="vp-flag" aria-hidden="true">{flag(v.country)}</span>
          <span class="vp-main">
            <span class="vp-name">{v.name}</span>
            <span class="vp-meta">
              {v.country ? (regionNames?.of(v.country) ?? v.country) : $t('settings.voice.picker.any_lang')} · {genderLabel(v.gender)}{v.quality === 'low' ? ` · ${$t('settings.voice.picker.low')}` : ''}
            </span>
          </span>
          <button type="button" class="vp-play" on:click={(e) => preview(v, e)}
                  aria-label={`${$t('settings.voice.picker.preview')} ${v.name}`}
                  title={v.downloaded ? $t('settings.voice.picker.preview') : $t('settings.voice.picker.preview_download')}>
            {#if previewing === v.id && $speaking}■{:else}▶{/if}
          </button>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .vp { display: flex; flex-direction: column; gap: 8px; width: 100%; }
  .vp-filters { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .vp-chip, .vp-more {
    padding: 3px 10px; border-radius: 100px;
    border: 1px solid rgba(120, 130, 160, .25); background: transparent;
    color: var(--text-muted, #8a8fa3); font: 500 11px 'Manrope', sans-serif; cursor: pointer;
  }
  .vp-chip.on { background: rgba(61, 214, 200, .15); border-color: var(--flow-color, #3dd6c8); color: var(--text, #e0e2ea); }
  .vp-more { margin-left: auto; border-style: dashed; }

  .vp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; }
  .vp-tile {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border-radius: 8px;
    border: 1px solid rgba(120, 130, 160, .2); background: rgba(120, 130, 160, .05);
    color: var(--text, #e0e2ea); cursor: pointer; text-align: left;
    font: inherit;
  }
  .vp-tile:hover { border-color: rgba(120, 130, 160, .45); }
  .vp-tile:focus-visible { outline: 2px solid var(--flow-color, #3dd6c8); outline-offset: 1px; }
  .vp-tile.sel { border-color: var(--flow-color, #3dd6c8); background: rgba(61, 214, 200, .1); }
  .vp-flag { font-size: 18px; width: 22px; text-align: center; }
  .vp-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .vp-name { font: 600 12px 'Manrope', sans-serif; }
  .vp-meta { font: 400 10.5px 'Manrope', sans-serif; color: var(--text-muted, #8a8fa3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vp-play {
    width: 26px; height: 26px; flex-shrink: 0; border-radius: 6px;
    border: 1px solid rgba(120, 130, 160, .3); background: transparent;
    color: var(--text, #e0e2ea); cursor: pointer; font-size: 10px;
  }
  .vp-play:hover { background: rgba(120, 130, 160, .15); }
  .vp-id {
    width: 100%; padding: 8px 10px; border-radius: 6px;
    border: 1px solid rgba(120, 130, 160, .25); background: rgba(0, 0, 0, .2);
    color: var(--text, #e0e2ea); font: 400 12px 'JetBrains Mono', monospace;
  }
</style>
