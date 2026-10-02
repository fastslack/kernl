<script lang="ts">
  /**
   * Expanded body of a LIVE activity row that is not a tool step: the run
   * lifecycle, self-grading, lessons learned or retired, handoffs. The model
   * (sections, tones, copy text) comes from $lib/live-event-detail — this
   * component only lays it out.
   */
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import { formatRunOutput } from '$lib/run-format.js';
  import type { LiveEventDetail, DetailTone } from '$lib/live-event-detail.js';

  export let detail: LiveEventDetail;
  /** UUID chips inside rendered markdown open the entity preview. */
  export let onOutputClick: (e: MouseEvent) => void = () => {};

  const TONE_WORD: Record<DetailTone, string> = { good: 'good', warn: 'fair', bad: 'poor', neutral: '' };
</script>

<div class="led copy-wrap">
  <CopyTextBtn text={detail.copyText} title="Copy details" />
  {#each detail.sections as s, si (si)}
    {#if s.kind === 'meter'}
      <section class="led-sec">
        <h4 class="led-label">{s.label}</h4>
        <div class="led-meter led-tone-{s.tone}">
          <div
            class="led-meter-track"
            role="meter"
            aria-label={s.label}
            aria-valuemin={0}
            aria-valuemax={s.max}
            aria-valuenow={s.value}
            aria-valuetext={s.caption}
          >
            {#each Array(s.max) as _, i (i)}
              <span class="led-meter-seg" class:on={i < s.value}></span>
            {/each}
          </div>
          <span class="led-meter-caption">{s.caption}</span>
          {#if TONE_WORD[s.tone]}<span class="led-sr">({TONE_WORD[s.tone]})</span>{/if}
        </div>
      </section>
    {:else if s.kind === 'text'}
      <section class="led-sec">
        <h4 class="led-label">{s.label}</h4>
        {#if s.markdown}
          <div class="led-text led-md led-tone-{s.tone ?? 'neutral'}" on:click={onOutputClick} role="presentation">
            {@html formatRunOutput(s.body)}
          </div>
        {:else}
          <p class="led-text led-tone-{s.tone ?? 'neutral'}">{s.body}</p>
        {/if}
      </section>
    {:else if s.kind === 'list'}
      <section class="led-sec">
        <h4 class="led-label">{s.label}{#if s.items.length}<span class="led-count">{s.items.length}</span>{/if}</h4>
        {#if s.items.length}
          <ol class="led-list">
            {#each s.items as item, ii (ii)}
              <li>
                <span class="led-list-text">{item.text}</span>
                {#if item.meta}<span class="led-chip">{item.meta}</span>{/if}
              </li>
            {/each}
          </ol>
        {:else}
          <p class="led-empty">{s.empty ?? 'Nothing to show.'}</p>
        {/if}
      </section>
    {:else if s.kind === 'fields'}
      <dl class="led-fields">
        {#each s.fields as f (f.label)}
          <div class="led-field">
            <dt>{f.label}</dt>
            <dd class:mono={f.mono} class="led-tone-{f.tone ?? 'neutral'}">
              {#if f.tone && f.tone !== 'neutral'}<span class="led-dot" aria-hidden="true"></span>{/if}
              <span class="led-val">{f.value}</span>
              {#if f.hint}<span class="led-hint">{f.hint}</span>{/if}
            </dd>
          </div>
        {/each}
      </dl>
    {:else if s.kind === 'note'}
      <p class="led-note">
        <svg class="led-note-ico" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path d="M8 7.2v3.6M8 5.1v.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        <span>{s.body}</span>
      </p>
    {/if}
  {/each}
</div>

<style>
  .led{
    position:relative;display:flex;flex-direction:column;gap:12px;
    margin:0 0 4px;padding:12px 14px 14px;
    border:1px solid rgba(120,130,160,.18);border-top:none;border-radius:0 0 7px 7px;
    background:rgba(8,10,18,.7);
    animation:led-in .16s ease-out;
  }
  @keyframes led-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: reduce){ .led{animation:none} }

  .led-sec{display:flex;flex-direction:column;gap:6px;min-width:0}
  .led-label{
    margin:0;display:flex;align-items:center;gap:6px;
    font:700 9px 'Syne',sans-serif;letter-spacing:1.1px;text-transform:uppercase;color:#8a8fa8;
  }
  .led-count{
    font:600 9px 'JetBrains Mono',monospace;letter-spacing:0;
    padding:0 5px;border-radius:3px;background:rgba(120,130,160,.15);color:#a0a5b8;
  }

  /* Full text — never truncated; long bodies scroll inside the card. */
  .led-text{
    margin:0;padding:8px 10px;border-radius:6px;background:rgba(0,0,0,.28);
    border-left:2px solid rgba(120,130,160,.3);
    font:400 12px/1.6 'Manrope',sans-serif;color:#dfe3ee;
    white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;
    max-height:340px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  .led-md{white-space:normal}
  .led-text.led-tone-bad{border-left-color:#ef5d6e;background:rgba(239,93,110,.08);color:#f3c6cc}

  /* Score meter: segments + the score in words (never colour alone). */
  .led-meter{display:flex;align-items:center;gap:10px}
  .led-meter-track{display:inline-flex;gap:3px}
  .led-meter-seg{width:22px;height:7px;border-radius:2px;background:rgba(120,130,160,.18)}
  .led-tone-good .led-meter-seg.on{background:#5fdba0}
  .led-tone-warn .led-meter-seg.on{background:#f5b84a}
  .led-tone-bad  .led-meter-seg.on{background:#ef5d6e}
  .led-tone-neutral .led-meter-seg.on{background:#9aa3c0}
  .led-meter-caption{font:600 12px 'JetBrains Mono',monospace;color:#e0e3ee;font-variant-numeric:tabular-nums}
  .led-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

  /* Key / value grid. */
  .led-fields{
    margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px 14px;
    padding-top:10px;border-top:1px solid rgba(120,130,160,.10);
  }
  .led-sec + .led-fields:first-child,.led-fields:first-child{padding-top:0;border-top:none}
  .led-field{min-width:0}
  .led-field dt{
    font:600 9px 'Manrope',sans-serif;letter-spacing:.6px;text-transform:uppercase;color:#6f7590;margin-bottom:2px;
  }
  .led-field dd{
    margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;
    font:500 12px 'Manrope',sans-serif;color:#e0e3ee;word-break:break-word;
  }
  .led-field dd.mono .led-val{font:500 11px 'JetBrains Mono',monospace;font-variant-numeric:tabular-nums;color:#c8cde0}
  .led-hint{flex-basis:100%;font:400 10.5px/1.4 'Manrope',sans-serif;color:#7d839c}
  .led-dot{width:7px;height:7px;border-radius:50%;background:#9aa3c0;flex-shrink:0}
  dd.led-tone-good .led-dot{background:#5fdba0}
  dd.led-tone-good .led-val{color:#8fe8bc}
  dd.led-tone-warn .led-dot{background:#f5b84a}
  dd.led-tone-bad  .led-dot{background:#ef5d6e}
  dd.led-tone-bad  .led-val{color:#f59aa5}

  /* Lists (issues, retired lessons). */
  .led-list{margin:0;padding:0 0 0 18px;display:flex;flex-direction:column;gap:6px}
  .led-list li{font:400 12px/1.5 'Manrope',sans-serif;color:#dfe3ee;padding-left:2px}
  .led-list li::marker{color:#6f7590;font:600 10px 'JetBrains Mono',monospace}
  .led-list-text{word-break:break-word}
  .led-chip{
    display:inline-block;margin-left:8px;vertical-align:1px;
    font:600 9.5px 'JetBrains Mono',monospace;padding:1px 6px;border-radius:3px;
    background:rgba(120,130,160,.12);color:#a0a5b8;white-space:nowrap;
  }
  .led-empty{margin:0;font:italic 400 11.5px 'Manrope',sans-serif;color:#7d839c}

  /* Explanation of what the event means. */
  .led-note{
    margin:0;display:flex;gap:8px;align-items:flex-start;
    padding:8px 10px;border-radius:6px;
    background:rgba(106,160,255,.06);border:1px solid rgba(106,160,255,.14);
    font:400 11.5px/1.5 'Manrope',sans-serif;color:#b9c6e4;
  }
  .led-note-ico{width:14px;height:14px;flex-shrink:0;margin-top:2px;color:#7fa6ef}
</style>
