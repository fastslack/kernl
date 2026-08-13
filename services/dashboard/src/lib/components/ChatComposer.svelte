<script lang="ts">
  import { createEventDispatcher, tick } from 'svelte';

  /**
   * The one composer every bot conversation in the dashboard uses.
   *
   * Five surfaces grew their own input row — the agent Message tab, the meeting
   * room, OfficeCreatorChat, /chat and the DevOps console — and each reinvented
   * autoresize, Enter-vs-Shift+Enter, the disabled state and the send button,
   * at four different sizes. The message *lists* genuinely differ (plain text
   * vs blocks vs attachments) and are left alone; the composer does not, so it
   * lives here once.
   *
   * Emits `send` with the trimmed text. The parent owns the sending, clears
   * `value` when it accepts, and flips `sending` for the duration.
   */

  export let value = '';
  export let placeholder = '';
  /** Persistent guidance under the field — helper text, not a placeholder.
   *  A placeholder disappears the moment you start typing, which is exactly
   *  when people still need the hint. */
  export let hint = '';
  /** In flight. Locks the field and turns the button into a progress state. */
  export let sending = false;
  /** Hard-disabled for reasons other than an in-flight send. */
  export let disabled = false;
  /** Chips offered while the field is empty. Clicking one loads it for edit
   *  rather than firing blind, so nobody sends a suggestion they misread. */
  export let suggestions: string[] = [];
  export let sendLabel = 'Send message';
  /** Grows to this many rows before it starts scrolling. */
  export let maxRows = 6;
  export let autofocus = false;

  const dispatch = createEventDispatcher<{ send: string }>();

  let inputEl: HTMLTextAreaElement;
  $: locked = sending || disabled;
  $: canSend = !locked && value.trim().length > 0;

  function autoResize() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    const line = parseFloat(getComputedStyle(inputEl).lineHeight) || 18;
    const pad = inputEl.offsetHeight - inputEl.clientHeight + 20;
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, line * maxRows + pad)}px`;
  }

  function submit() {
    if (!canSend) return;
    dispatch('send', value.trim());
    // The parent clears `value`; reset the box so it doesn't stay tall.
    tick().then(autoResize);
  }

  function onKeydown(e: KeyboardEvent) {
    // Enter sends, Shift+Enter breaks the line. An ad-hoc task is often a
    // paragraph, and the old single-line input made that impossible to write.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  async function useSuggestion(s: string) {
    value = s;
    await tick();
    inputEl?.focus();
    autoResize();
  }

  export function focus() { inputEl?.focus(); }
  $: if (value === '') { tick().then(autoResize); }
</script>

<div class="cc" class:cc-locked={locked}>
  {#if suggestions.length && !value.trim() && !locked}
    <div class="cc-suggestions">
      {#each suggestions as s}
        <button type="button" class="cc-chip" on:click={() => useSuggestion(s)} title="Load into the field to edit before sending">
          {s}
        </button>
      {/each}
    </div>
  {/if}

  <div class="cc-row">
    <!-- svelte-ignore a11y-autofocus -->
    <textarea
      bind:this={inputEl}
      class="cc-input"
      bind:value
      rows="1"
      {placeholder}
      {autofocus}
      aria-label={placeholder || sendLabel}
      disabled={locked}
      on:keydown={onKeydown}
      on:input={autoResize}
    ></textarea>
    <button
      type="button"
      class="cc-send"
      on:click={submit}
      disabled={!canSend}
      aria-label={sending ? 'Sending…' : sendLabel}
      title={sending ? 'Sending…' : `${sendLabel} (Enter)`}
    >
      {#if sending}
        <span class="cc-spinner" aria-hidden="true"></span>
      {:else}
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" />
        </svg>
      {/if}
    </button>
  </div>

  {#if hint}
    <div class="cc-hint">{hint}</div>
  {/if}
</div>

<style>
  .cc {
    display: flex; flex-direction: column; gap: 8px;
    padding-top: 12px;
    border-top: 1px solid rgba(120, 130, 160, .12);
  }

  .cc-suggestions { display: flex; flex-wrap: wrap; gap: 6px; }
  .cc-chip {
    padding: 5px 10px; border-radius: 100px;
    background: rgba(120, 130, 160, .06);
    border: 1px solid rgba(120, 130, 160, .2);
    color: #a0a5b8; cursor: pointer;
    font: 500 11px 'Manrope', sans-serif;
    text-align: left; max-width: 100%;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    transition: background .15s, border-color .15s, color .15s;
  }
  .cc-chip:hover { background: rgba(120, 130, 160, .14); border-color: rgba(120, 130, 160, .38); color: #e0e2ea; }
  .cc-chip:focus-visible { outline: 2px solid var(--flow-color, #3dd6c8); outline-offset: 2px; }

  .cc-row { display: flex; gap: 8px; align-items: flex-end; }

  .cc-input {
    flex: 1; min-width: 0;
    padding: 10px 14px; border-radius: 8px;
    background: rgba(0, 0, 0, .3);
    border: 1px solid rgba(120, 130, 160, .2);
    color: #e0e2ea;
    font: 400 12px/1.5 'Manrope', sans-serif;
    outline: none; box-sizing: border-box;
    resize: none; overflow-y: auto;
    transition: border-color .15s;
    scrollbar-width: thin; scrollbar-color: rgba(120, 130, 160, .25) transparent;
  }
  .cc-input::placeholder { color: #6a6f82; }
  .cc-input:focus { border-color: var(--flow-color, #3dd6c8); }
  .cc-input:disabled { opacity: .5; cursor: not-allowed; }

  .cc-send {
    flex-shrink: 0;
    width: 36px; height: 36px;
    display: grid; place-items: center;
    border-radius: 8px; border: none;
    background: var(--flow-color, #3dd6c8); color: #0a0e14;
    cursor: pointer; transition: filter .15s, opacity .15s;
  }
  .cc-send:hover:not(:disabled) { filter: brightness(1.1); }
  .cc-send:disabled { opacity: .35; cursor: not-allowed; }
  .cc-send:focus-visible { outline: 2px solid var(--flow-color, #3dd6c8); outline-offset: 2px; }

  .cc-spinner {
    width: 13px; height: 13px; border-radius: 50%;
    border: 2px solid rgba(10, 14, 20, .3);
    border-top-color: #0a0e14;
    animation: cc-spin .7s linear infinite;
  }
  @keyframes cc-spin { to { transform: rotate(360deg); } }

  .cc-hint { font: 400 10px 'Manrope', sans-serif; color: #6a6f82; }

  /* Anyone who asked for less motion still needs to know it is working, so the
     spinner stops rotating but stays visible as a ring. */
  @media (prefers-reduced-motion: reduce) {
    .cc-spinner { animation: none; }
  }
</style>
