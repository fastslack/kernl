<script lang="ts">
  /**
   * One stored step's payload in HISTORY — a call's input, a result's output or
   * a thought's text — with its label, a copy button, and a muted note when
   * there was nothing to show. The content comes from historyStepDetail.
   */
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import { formatRunOutput } from '$lib/run-format.js';
  import type { StepDetail } from '$lib/history-steps.js';

  export let detail: StepDetail;
  /** The raw payload, for the copy button. */
  export let copyText = '';
  /** UUID chips inside rendered markdown open the entity preview. */
  export let onOutputClick: (e: MouseEvent) => void = () => {};
</script>

<div class="sp copy-wrap">
  {#if detail.label}<span class="sp-lbl">{detail.label}</span>{/if}
  {#if detail.empty}
    <p class="sp-empty">{detail.body}</p>
  {:else}
    {#if copyText}<CopyTextBtn text={copyText} title={detail.label ? `Copy ${detail.label.toLowerCase()}` : 'Copy'} />{/if}
    <div class="sp-md ip-out-md" on:click={onOutputClick} role="presentation">
      {@html formatRunOutput(detail.body)}
    </div>
  {/if}
</div>

<style>
  .sp{position:relative;display:flex;flex-direction:column;gap:4px;min-width:0}
  .sp-lbl{font:700 9px 'Syne',sans-serif;letter-spacing:1px;text-transform:uppercase;color:#8a8fa8}
  .sp-empty{margin:0;font:italic 400 11.5px 'Manrope',sans-serif;color:#7d839c}
  /* Capped, so it has to scroll itself: `.ip-out-md`'s overflow rule is
     scoped to the components that declare it and does not reach here, and
     without this a long payload spilled over the steps below it. */
  .sp-md{
    max-height:420px;overflow-y:auto;overflow-x:hidden;
    word-break:break-word;overflow-wrap:anywhere;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
</style>
