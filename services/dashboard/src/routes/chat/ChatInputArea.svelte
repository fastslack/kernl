<script lang="ts">
  import ChatComposer from '$lib/components/ChatComposer.svelte';
  import type { ComposerSendDetail } from '$lib/attachments/types.js';

  /**
   * The chat's composer: the shared ChatComposer with attachments and voice,
   * set in this page's input band.
   *
   * Sending stays in the page — it owns the transcript and the stream — so
   * the text is bound (the page clears it on send) and the composer hands
   * over the ready attachments with each send. Files dropped anywhere on
   * `dropTarget` (the chat panel) join the draft too.
   */
  export let input = '';
  export let sending = false;
  export let dropTarget: HTMLElement | null = null;
  export let onSend: (detail: ComposerSendDetail) => void = () => {};
  /** Fires just before the `onSend` of a push-to-talk transcript. */
  export let onSpoken: () => void = () => {};

  let composer: ChatComposer;
  export function focus() { composer?.focus(); }
</script>

<div class="cx-input-area">
  <ChatComposer
    bind:this={composer}
    bind:value={input}
    {sending}
    attachments
    {dropTarget}
    voice
    placeholder="Message…"
    hint="Enter to send · Shift+Enter newline · drop or paste files to attach"
    sendLabel="Send message"
    on:spoken={() => onSpoken()}
    on:send={(e) => onSend(e.detail)}
  />
</div>

<style>
  .cx-input-area {
    flex-shrink: 0;
    padding: 0 24px 14px;
    position: relative;
    z-index: 1;
    background: linear-gradient(180deg, transparent 0%, var(--bg) 20%);
    /* The composer's accent follows this page's gold. */
    --flow-color: var(--gold);
  }
</style>
