<script lang="ts">
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import MicButton from '$lib/components/voice/MicButton.svelte';
  import SpeakToggle from '$lib/components/voice/SpeakToggle.svelte';
  import { confirmBeforeSend } from '$lib/voice/prefs.js';
  import { t } from '$lib/i18n/index.js';
  import { createAttachmentUploader, summarize, type PendingAttachment, type Rejection } from '$lib/attachments/upload.js';
  import { ACCEPT_ATTR, formatBytes } from '$lib/attachments/files.js';
  import { rememberAttachmentMeta } from '$lib/attachments/media.js';
  import { MAX_ATTACHMENTS_PER_MESSAGE, type AttachmentMeta, type ComposerSendDetail } from '$lib/attachments/types.js';
  import { bindListeners } from '$lib/outside-listeners.js';

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
   * Emits `send` with `{ text, attachmentIds, attachments }` — the trimmed
   * text and the ready attachments. The parent owns the sending, clears
   * `value` when it accepts, and flips `sending` for the duration. Pending
   * attachments are handed over with the event and leave the row at once:
   * from then on they belong to the message, not to the draft.
   *
   * With `attachments`, files come in by the paperclip, by paste, and by drop
   * on the composer — or on the whole chat, when the parent passes its panel
   * as `dropTarget` (or calls `addFiles` from its own drop handler). Each one
   * uploads as soon as it is added; send waits until every one is ready, and
   * a message may be attachments only.
   *
   * With `voice`, a push-to-talk mic and a speaker toggle join the row. A
   * transcript is sent straight away (or loaded into the box, if the browser
   * is set to review first), and `spoken` fires just before its `send` so
   * the parent can answer a spoken message out loud.
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
  /** Show the mic and the speaker toggle. */
  export let voice = false;
  /** Accept files: paperclip, paste and drop. */
  export let attachments = false;
  /** An element (usually the whole chat panel) that also takes dropped files. */
  export let dropTarget: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ send: ComposerSendDetail; spoken: string }>();
  const uploader = createAttachmentUploader();

  let inputEl: HTMLTextAreaElement;
  let fileInputEl: HTMLInputElement;
  let rejectMsg = '';
  let rejectTimer: ReturnType<typeof setTimeout> | undefined;
  let dragDepth = 0;

  $: pending = $uploader;
  $: att = summarize(pending);
  $: locked = sending || disabled;
  $: canSend = !locked && (value.trim().length > 0 || att.total > 0) && (att.total === 0 || att.allReady);
  $: dragActive = dragDepth > 0;
  // While attachments hold the send back, say why where the hint lives.
  $: status = att.waiting > 0 ? $t('attach.waiting', { n: att.waiting })
    : att.failed > 0 ? $t('attach.failed_block')
    : '';

  function autoResize() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    const line = parseFloat(getComputedStyle(inputEl).lineHeight) || 18;
    const pad = inputEl.offsetHeight - inputEl.clientHeight + 20;
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, line * maxRows + pad)}px`;
  }

  function submit() {
    if (!canSend) return;
    const ready = pending.filter((p) => p.state === 'ready' && p.meta);
    const metas = ready.map((p) => p.meta as AttachmentMeta);
    metas.forEach(rememberAttachmentMeta);
    dispatch('send', { text: value.trim(), attachmentIds: metas.map((m) => m.id), attachments: metas });
    if (ready.length) uploader.clear();
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

  async function onTranscript(text: string) {
    // Attachments waiting go with the next typed send, so the transcript joins
    // the draft instead of leaving without them.
    if ($confirmBeforeSend || locked || att.total > 0) {
      value = value.trim() ? `${value.trim()} ${text}` : text;
      await tick();
      inputEl?.focus();
      autoResize();
      return;
    }
    dispatch('spoken', text);
    dispatch('send', { text, attachmentIds: [], attachments: [] });
  }

  function rejectionText(r: Rejection): string {
    if (r.reason === 'count') return $t('attach.reject.count', { max: MAX_ATTACHMENTS_PER_MESSAGE });
    if (r.reason === 'size') return $t('attach.reject.size', { name: r.name, cap: formatBytes(r.cap ?? 0) });
    if (r.reason === 'empty') return $t('attach.reject.empty', { name: r.name });
    return $t('attach.reject.type', { name: r.name });
  }

  /** Add files to the pending row — for a parent with its own drop handling. */
  export function addFiles(files: FileList | File[]) {
    if (!attachments || locked) return;
    const rejected = uploader.add(Array.from(files));
    clearTimeout(rejectTimer);
    // Several refusals at once collapse into the first plus a count; the row
    // must stay one line.
    rejectMsg = rejected.length === 0 ? ''
      : rejectionText(rejected[0]) + (rejected.length > 1 ? ` (+${rejected.length - 1})` : '');
    if (rejectMsg) rejectTimer = setTimeout(() => (rejectMsg = ''), 6000);
  }

  function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files?.length) addFiles(input.files);
    input.value = '';
  }

  function onPaste(e: ClipboardEvent) {
    if (!attachments) return;
    const files: File[] = [];
    for (const it of e.clipboardData?.items ?? []) {
      if (it.kind !== 'file') continue;
      const f = it.getAsFile();
      if (f) files.push(f);
    }
    // Text pastes stay text; only a paste that carries files is taken over.
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  }

  function hasFiles(e: DragEvent) {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  }
  function onDragEnter(e: DragEvent) {
    if (!attachments || locked || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
  }
  function onDragOver(e: DragEvent) {
    if (!attachments || locked || !hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave() {
    if (dragDepth > 0) dragDepth--;
  }
  // relatedTarget is unreliable on drag events; the pointer at the edge is not.
  function leftWindow(e: DragEvent) {
    return e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
  }
  function onDrop(e: DragEvent) {
    if (!attachments || !hasFiles(e)) return;
    e.preventDefault();
    // The composer sits inside the drop target; one drop must not add twice.
    e.stopPropagation();
    dragDepth = 0;
    if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
  }

  // The parent's drop zone. Rebound when the element changes, unbound on destroy.
  let unbindDrop: (() => void) | undefined;
  $: {
    unbindDrop?.();
    unbindDrop = attachments && dropTarget
      ? bindListeners(dropTarget, [
          { type: 'dragenter', handler: onDragEnter as EventListener },
          { type: 'dragover', handler: onDragOver as EventListener },
          { type: 'dragleave', handler: onDragLeave as EventListener },
          { type: 'drop', handler: onDrop as EventListener },
        ])
      : undefined;
  }

  onDestroy(() => {
    unbindDrop?.();
    clearTimeout(rejectTimer);
    // Unsent attachments die with the draft.
    uploader.reset();
  });

  function chipTitle(p: PendingAttachment): string {
    if (p.state === 'failed') return `${p.name} — ${p.error || $t('attach.state.failed')}`;
    if (p.state === 'uploading') return `${p.name} — ${$t('attach.state.uploading', { pct: Math.round(p.progress * 100) })}`;
    if (p.state === 'processing') return `${p.name} — ${$t('attach.state.processing')}`;
    const warnings = p.meta?.derived?.warnings ?? [];
    return warnings.length ? `${p.name} — ${warnings.join(' · ')}` : `${p.name} — ${$t('attach.state.ready')}`;
  }

  export function focus() { inputEl?.focus(); }
  $: if (value === '') { tick().then(autoResize); }
</script>

<!-- A drag that leaves the window, or drops somewhere else, never sends us
     the matching dragleave: reset the highlight then. -->
<svelte:window
  on:dragleave={(e) => { if (leftWindow(e)) dragDepth = 0; }}
  on:drop={() => (dragDepth = 0)}
/>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
  class="cc"
  class:cc-locked={locked}
  class:cc-drag={dragActive}
  on:dragenter={onDragEnter}
  on:dragover={onDragOver}
  on:dragleave={onDragLeave}
  on:drop={onDrop}
>
  {#if attachments && (pending.length || dragActive)}
    <div class="cc-atts" role="list">
      {#if dragActive}
        <div class="cc-drop">{$t('attach.drop')}</div>
      {/if}
      {#each pending as p (p.key)}
        <div class="cc-att cc-att--{p.state}" role="listitem" title={chipTitle(p)}>
          <span class="cc-att-thumb" aria-hidden="true">
            {#if p.preview}
              <img src={p.preview} alt="" />
            {:else if p.kind === 'video'}
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="14" rx="2" /><path d="m22 8-6 4 6 4V8z" /></svg>
            {:else}
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
            {/if}
          </span>
          <span class="cc-att-name">{p.name}</span>
          <span class="cc-att-state">
            {#if p.state === 'uploading'}
              {Math.round(p.progress * 100)}%
            {:else if p.state === 'processing'}
              <span class="cc-att-spin" aria-label={$t('attach.state.processing')}></span>
            {:else if p.state === 'ready' && p.meta?.derived?.warnings?.length}
              <svg class="cc-att-warn" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label={$t('attach.state.warning')}><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z" /><path d="M12 9v4M12 17h.01" /></svg>
            {:else if p.state === 'ready'}
              <svg class="cc-att-ok" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-label={$t('attach.state.ready')}><path d="M20 6 9 17l-5-5" /></svg>
            {:else}
              <button type="button" class="cc-att-btn cc-att-retry" on:click={() => uploader.retry(p.key)} aria-label={$t('attach.retry')} title={$t('attach.retry')}>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>
              </button>
            {/if}
          </span>
          <button type="button" class="cc-att-btn" on:click={() => uploader.remove(p.key)} aria-label={$t('attach.remove', { name: p.name })}>
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
          {#if p.state === 'uploading'}
            <span class="cc-att-bar" style="transform:scaleX({p.progress})" aria-hidden="true"></span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

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
      on:paste={onPaste}
    ></textarea>
    {#if attachments}
      <input bind:this={fileInputEl} type="file" multiple accept={ACCEPT_ATTR} on:change={onPick} hidden />
      <button
        type="button"
        class="cc-clip"
        on:click={() => fileInputEl?.click()}
        disabled={locked || pending.length >= MAX_ATTACHMENTS_PER_MESSAGE}
        aria-label={$t('attach.add')}
        title={`${$t('attach.add')} — ${$t('attach.add_hint')}`}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
    {/if}
    {#if voice}
      <SpeakToggle />
      <MicButton disabled={disabled} on:transcript={(e) => onTranscript(e.detail)} />
    {/if}
    <button
      type="button"
      class="cc-send"
      on:click={submit}
      disabled={!canSend}
      aria-label={sending ? 'Sending…' : sendLabel}
      title={sending ? 'Sending…' : status || `${sendLabel} (Enter)`}
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

  {#if rejectMsg}
    <div class="cc-hint cc-hint--error" role="alert">{rejectMsg}</div>
  {:else if status}
    <div class="cc-hint cc-hint--status" aria-live="polite">{status}</div>
  {:else if hint}
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
  .cc-hint--status { color: #a0a5b8; }
  .cc-hint--error { color: var(--red, #f04770); }

  .cc-drag .cc-input { border-color: var(--flow-color, #3dd6c8); border-style: dashed; }

  .cc-clip {
    flex-shrink: 0;
    width: 36px; height: 36px;
    display: grid; place-items: center;
    border-radius: 8px;
    background: transparent; color: #a0a5b8;
    border: 1px solid rgba(120, 130, 160, .2);
    cursor: pointer; transition: background .15s, color .15s, border-color .15s;
  }
  .cc-clip:hover:not(:disabled) { background: rgba(120, 130, 160, .12); color: #e0e2ea; border-color: rgba(120, 130, 160, .38); }
  .cc-clip:disabled { opacity: .35; cursor: not-allowed; }
  .cc-clip:focus-visible { outline: 2px solid var(--flow-color, #3dd6c8); outline-offset: 2px; }

  /* One line of chips, always: it scrolls sideways and never grows the
     composer, so the transcript above keeps its height. */
  .cc-atts {
    display: flex; gap: 6px; align-items: center;
    height: 32px; flex-shrink: 0;
    overflow-x: auto; overflow-y: hidden;
    scrollbar-width: thin; scrollbar-color: rgba(120, 130, 160, .25) transparent;
  }
  .cc-drop {
    flex-shrink: 0; height: 28px; padding: 0 12px;
    display: grid; place-items: center;
    border: 1px dashed var(--flow-color, #3dd6c8); border-radius: 6px;
    color: var(--flow-color, #3dd6c8);
    font: 600 11px 'Manrope', sans-serif;
  }
  .cc-att {
    position: relative; flex-shrink: 0;
    display: flex; align-items: center; gap: 6px;
    height: 28px; max-width: 220px; padding: 0 4px 0 3px;
    border-radius: 6px; overflow: hidden;
    background: rgba(120, 130, 160, .08);
    border: 1px solid rgba(120, 130, 160, .2);
    color: #e0e2ea;
    font: 500 11px 'Manrope', sans-serif;
  }
  .cc-att--failed { border-color: color-mix(in srgb, var(--red, #f04770) 55%, transparent); }
  .cc-att-thumb {
    flex-shrink: 0; width: 22px; height: 22px;
    display: grid; place-items: center;
    border-radius: 4px; overflow: hidden;
    background: rgba(0, 0, 0, .3); color: #a0a5b8;
  }
  .cc-att-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .cc-att-name { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cc-att-state {
    flex-shrink: 0; display: inline-flex; align-items: center;
    font: 500 10px var(--font-mono, monospace); font-variant-numeric: tabular-nums;
    color: #a0a5b8;
  }
  .cc-att-ok { color: var(--green, #3dd68c); }
  .cc-att-warn { color: var(--orange, #f0883e); }
  .cc-att-spin {
    width: 10px; height: 10px; border-radius: 50%;
    border: 1.5px solid rgba(160, 165, 184, .3); border-top-color: #a0a5b8;
    animation: cc-spin .8s linear infinite;
  }
  .cc-att-btn {
    flex-shrink: 0; width: 20px; height: 20px;
    display: grid; place-items: center;
    border: none; border-radius: 4px;
    background: transparent; color: #a0a5b8; cursor: pointer;
  }
  .cc-att-btn:hover { background: rgba(120, 130, 160, .18); color: #e0e2ea; }
  .cc-att-btn:focus-visible { outline: 2px solid var(--flow-color, #3dd6c8); outline-offset: -1px; }
  .cc-att-retry { color: var(--red, #f04770); }
  .cc-att-bar {
    position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
    background: var(--flow-color, #3dd6c8);
    transform-origin: left; transition: transform .2s;
  }

  /* Anyone who asked for less motion still needs to know it is working, so the
     spinner stops rotating but stays visible as a ring. */
  @media (prefers-reduced-motion: reduce) {
    .cc-spinner, .cc-att-spin { animation: none; }
    .cc-att-bar { transition: none; }
  }
</style>
