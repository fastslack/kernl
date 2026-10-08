<!-- services/dashboard/src/lib/components/feedback/FeedbackHost.svelte -->
<script lang="ts">
  /*
    The one host for the feedback kit ($shared/feedback). Mounted once by the
    root layout; registers itself on globalThis so the dashboard and every
    extension bundle reach the same toasts and dialogs.
  */
  import { onMount, onDestroy, tick } from 'svelte';
  import { fly } from 'svelte/transition';
  import Modal from '$lib/components/ui/Modal.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import { t } from '$lib/i18n/index.js';
  import {
    registerFeedbackHost, unregisterFeedbackHost, flushUndoables,
    type FeedbackHost, type ToastInput, type ConfirmOptions, type AskOptions, type FeedbackLabels,
  } from '$shared/feedback';

  type Live = ToastInput & { id: string; open: boolean };
  let toasts: Live[] = [];
  let queue: Live[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let n = 0;

  type Dialog =
    | { kind: 'confirm'; o: ConfirmOptions; resolve: (v: boolean) => void }
    | { kind: 'ask'; o: AskOptions; resolve: (v: string | null) => void };
  let dialog: Dialog | null = null;
  const waiting: Dialog[] = [];
  let typed = '';
  let value = '';
  let askError = '';
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function labels(): FeedbackLabels {
    return {
      undo: $t('feedback.undo'), retry: $t('feedback.retry'), cancel: $t('feedback.cancel'),
      confirm: $t('feedback.confirm'), showDetail: $t('feedback.show_detail'), hideDetail: $t('feedback.hide_detail'),
      restarting: $t('feedback.restarting'), typeToConfirm: $t('feedback.type_to_confirm'),
      somethingWrong: $t('feedback.something_wrong'),
    };
  }

  function pump() {
    while (toasts.length < 3 && queue.length) {
      const next = queue.shift()!;
      toasts = [...toasts, next];
      if (next.duration && next.duration > 0) timers.set(next.id, setTimeout(() => dismiss(next.id), next.duration));
    }
  }

  function dismiss(id: string) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    toasts = toasts.filter((x) => x.id !== id);
    queue = queue.filter((x) => x.id !== id);
    pump();
  }

  function openNext() {
    if (dialog || !waiting.length) return;
    dialog = waiting.shift()!;
    typed = '';
    askError = '';
    value = dialog.kind === 'ask' ? dialog.o.initial ?? '' : '';
  }

  function close(result: boolean) {
    const d = dialog;
    if (!d) return;
    if (d.kind === 'ask' && result) {
      const err = d.o.validate?.(value) ?? null;
      if (err) { askError = err; return; }
    }
    dialog = null;
    if (d.kind === 'confirm') d.resolve(result);
    else d.resolve(result ? value : null);
    void tick().then(openNext);
  }

  const host: FeedbackHost = {
    toast(input) {
      const live: Live = { ...input, id: `t${++n}`, open: false };
      if (live.action && toasts.length >= 3) {
        // An action toast (Undo) has a clock running elsewhere: it cannot wait
        // in the queue. Evict the oldest toast without an action to make room.
        const victim = toasts.find((x) => !x.action) ?? toasts[0];
        clearTimeout(timers.get(victim.id));
        timers.delete(victim.id);
        toasts = toasts.filter((x) => x.id !== victim.id);
      }
      if (live.action) {
        toasts = [...toasts, live];
        if (live.duration && live.duration > 0) timers.set(live.id, setTimeout(() => dismiss(live.id), live.duration));
      } else {
        queue = [...queue, live];
        pump();
      }
      return live.id;
    },
    dismiss,
    confirm: (o) => new Promise((resolve) => { waiting.push({ kind: 'confirm', o, resolve }); openNext(); }),
    ask: (o) => new Promise((resolve) => { waiting.push({ kind: 'ask', o, resolve }); openNext(); }),
    labels,
  };

  const onUnload = () => { void flushUndoables(); };
  onMount(() => { registerFeedbackHost(host); window.addEventListener('beforeunload', onUnload); });
  onDestroy(() => {
    unregisterFeedbackHost(host);
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', onUnload);
    for (const x of timers.values()) clearTimeout(x);
  });

  $: needsTyping = dialog?.kind === 'confirm' && !!dialog.o.typeToConfirm;
  $: canConfirm = !needsTyping || (dialog?.kind === 'confirm' && typed === dialog.o.typeToConfirm);
</script>

<div class="fb-stack" aria-live="polite">
  {#each toasts as tt (tt.id)}
    <div class="fb-toast fb-{tt.kind}" role={tt.kind === 'error' ? 'alert' : 'status'} transition:fly={{ y: 8, duration: reduced ? 0 : 160 }}>
      <Icon name={tt.kind === 'error' ? 'alert' : tt.kind === 'success' ? 'check' : 'info'} />
      <div class="fb-body">
        <span class="fb-msg">{tt.message}</span>
        {#if tt.detail}
          <button class="fb-link" on:click={() => (tt.open = !tt.open, toasts = toasts)}>{tt.open ? $t('feedback.hide_detail') : $t('feedback.show_detail')}</button>
          {#if tt.open}<pre class="fb-detail">{tt.detail}</pre>{/if}
        {/if}
      </div>
      {#if tt.action}
        <button class="fb-action" on:click={() => { tt.action?.run(); dismiss(tt.id); }}>{tt.action.label}</button>
      {/if}
      <button class="fb-x" aria-label={$t('feedback.close')} on:click={() => dismiss(tt.id)}><Icon name="x" size={14} /></button>
    </div>
  {/each}
</div>

<div class="fb-modal">
<Modal open={!!dialog} title={dialog?.o.title ?? ''} width="460px" on:close={() => close(false)}>
  {#if dialog}
    {#if dialog.o.body}<p class="fb-dbody">{dialog.o.body}</p>{/if}
    {#if dialog.kind === 'confirm' && dialog.o.typeToConfirm}
      <label class="fb-label">{$t('feedback.type_to_confirm', { name: dialog.o.typeToConfirm })}
        <input class="fb-input" bind:value={typed} autofocus />
      </label>
    {/if}
    {#if dialog.kind === 'ask'}
      <label class="fb-label">{dialog.o.label}
        <input class="fb-input" bind:value placeholder={dialog.o.placeholder ?? ''} autofocus on:keydown={(e) => e.key === 'Enter' && close(true)} />
      </label>
      {#if dialog.o.help}<p class="fb-help">{dialog.o.help}</p>{/if}
      {#if askError}<p class="fb-err" role="alert">{askError}</p>{/if}
    {/if}
    <div class="fb-actions">
      <button class="fb-btn ghost" on:click={() => close(false)}>{$t('feedback.cancel')}</button>
      <button class="fb-btn" class:danger={dialog.kind === 'confirm' && dialog.o.danger} disabled={!canConfirm} on:click={() => close(true)}>
        {dialog.o.confirmLabel ?? $t('feedback.confirm')}
      </button>
    </div>
  {/if}
</Modal>
</div>

<style>
  .fb-stack { position: fixed; right: 16px; bottom: 16px; z-index: var(--z-toast, 1000); display: flex; flex-direction: column; gap: 8px; max-width: min(420px, calc(100vw - 32px)); }
  .fb-toast { display: flex; align-items: flex-start; gap: 10px; padding: 10px 8px 10px 14px; border-radius: var(--radius, 10px); background: var(--surface-3); border: 1px solid var(--border-h); box-shadow: 0 12px 30px rgba(0,0,0,.4); font-size: 13px; color: var(--text-1); }
  .fb-success :global(.k-svg-icon:first-child) { color: var(--green); }
  .fb-error :global(.k-svg-icon:first-child) { color: var(--red); }
  .fb-info :global(.k-svg-icon:first-child) { color: var(--teal); }
  .fb-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .fb-link { align-self: flex-start; background: none; border: 0; padding: 0; color: var(--text-3); font-size: 12px; text-decoration: underline; cursor: pointer; }
  .fb-detail { margin: 0; max-height: 140px; overflow: auto; font-size: 11.5px; background: var(--surface-2); padding: 6px 8px; border-radius: 6px; color: var(--text-2); white-space: pre-wrap; }
  .fb-action { background: none; border: 1px solid var(--border-h); color: var(--teal); border-radius: 6px; padding: 4px 10px; font-weight: 700; cursor: pointer; }
  .fb-x { background: none; border: 0; color: var(--text-3); cursor: pointer; width: 28px; height: 28px; }
  .fb-dbody { margin: 0 0 12px; color: var(--text-2); font-size: 13.5px; line-height: 1.5; white-space: pre-line; }
  /* Long questions wrap instead of pushing the close button out of view. The
     scrim is position: fixed, so this wrapper does not affect layout. */
  .fb-modal :global(.k-modal-head h2) { white-space: normal; overflow-wrap: anywhere; min-width: 0; }
  .fb-modal :global(.k-modal-head) { align-items: flex-start; }
  .fb-modal :global(.k-modal-head .k-icon-btn) { flex: none; }
  .fb-label { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; color: var(--text-2); }
  .fb-input { background: var(--bg); border: 1px solid var(--border); color: var(--text-1); padding: 8px 10px; border-radius: 6px; font: inherit; font-size: 13px; }
  .fb-help { margin: 6px 0 0; font-size: 12px; color: var(--text-3); }
  .fb-err { margin: 6px 0 0; font-size: 12px; color: var(--red); }
  .fb-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .fb-btn { background: var(--teal); color: var(--bg); border: 0; border-radius: 6px; padding: 8px 16px; font-weight: 700; cursor: pointer; }
  .fb-btn.ghost { background: none; border: 1px solid var(--border); color: var(--text-2); font-weight: 500; }
  .fb-btn.danger { background: var(--red); color: #fff; }
  .fb-btn:disabled { opacity: .45; cursor: default; }
</style>
