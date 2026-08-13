<script lang="ts">
  /**
   * Modal shell for the /wellness logging actions.
   *
   * Owns everything the four log dialogs would otherwise each reimplement:
   * the focus trap, Escape and scrim dismissal, returning focus to whatever
   * opened it, and the submit button's pending state. Callers supply fields in
   * the default slot and a submit handler; this component never knows which RPC
   * runs.
   *
   * Visual language matches the sibling /training modals (surface-1 box, gold
   * primary) so the two pages don't look like different products.
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';

  export let title: string;
  export let sub: string = '';
  export let submitLabel: string;
  export let cancelLabel: string;
  export let closeLabel: string;
  export let savingLabel: string;
  /** Blocks submit while true — used for "required field is still empty". */
  export let canSubmit: boolean = true;
  export let submitting: boolean = false;
  /** Form-level error, rendered above the actions and announced politely. */
  export let error: string = '';

  const dispatch = createEventDispatcher<{ close: void; submit: void }>();

  let box: HTMLDivElement | null = null;
  let previouslyFocused: HTMLElement | null = null;

  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function focusable(): HTMLElement[] {
    if (!box) return [];
    return Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }

  onMount(() => {
    previouslyFocused = document.activeElement as HTMLElement | null;
    // Desktop dialog with a single primary input — the one case the guidelines
    // still sanction autofocus. Deferred a frame so the box is laid out.
    requestAnimationFrame(() => {
      // Aim at the first field, not the first focusable: the close button sits
      // earlier in the DOM, and opening "Log Meal" onto a Close button means
      // every keyboard user starts by tabbing past the exit.
      const firstField = box?.querySelector<HTMLElement>(
        '.wl-body input:not([disabled]), .wl-body select:not([disabled]), .wl-body textarea:not([disabled]), .wl-body button:not([disabled])',
      );
      (firstField ?? focusable()[0])?.focus();
    });
    // The page behind must not scroll while the dialog owns the viewport.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  });

  onDestroy(() => {
    previouslyFocused?.focus?.();
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dispatch('close');
      return;
    }
    if (e.key !== 'Tab') return;

    // Trap: Tab off either end wraps to the other, so focus can never escape
    // to the page behind while the dialog is modal.
    const items = focusable();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (e.shiftKey && (active === first || !box?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onSubmit(e: Event) {
    e.preventDefault();
    if (submitting || !canSubmit) return;
    dispatch('submit');
  }
</script>

<svelte:window on:keydown={onKeydown} />

<!-- The scrim is a click target, not a control: the dialog is dismissible from
     the keyboard via Escape (handled above), so it carries no role and no
     tabindex of its own. Testing `target === currentTarget` scopes the dismiss
     to the backdrop itself, which is what lets the box below stay free of a
     stopPropagation listener it would otherwise need. -->
<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div
  class="wl-scrim"
  on:click={(e) => {
    if (e.target === e.currentTarget) dispatch('close');
  }}
>
  <div
    class="wl-box"
    role="dialog"
    aria-modal="true"
    aria-labelledby="wl-title"
    aria-describedby={sub ? 'wl-sub' : undefined}
    bind:this={box}
  >
    <form on:submit={onSubmit} novalidate>
      <div class="wl-head">
        <div>
          <h2 class="wl-title" id="wl-title">{title}</h2>
          {#if sub}<p class="wl-sub" id="wl-sub">{sub}</p>{/if}
        </div>
        <button
          type="button"
          class="wl-x"
          aria-label={closeLabel}
          on:click={() => dispatch('close')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="wl-body">
        <slot />
      </div>

      <!-- Announced without stealing focus; the field-level error owns focus. -->
      <div class="wl-live" aria-live="polite">
        {#if error}
          <p class="wl-error">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v5M12 16.5v.01" stroke-linecap="round" />
            </svg>
            {error}
          </p>
        {/if}
      </div>

      <div class="wl-actions">
        <button type="button" class="wl-cancel" on:click={() => dispatch('close')}>
          {cancelLabel}
        </button>
        <button type="submit" class="wl-go" disabled={submitting || !canSubmit}>
          {#if submitting}
            <span class="wl-spinner" aria-hidden="true"></span>
            {savingLabel}
          {:else}
            {submitLabel}
          {/if}
        </button>
      </div>
    </form>
  </div>
</div>

<style>
  .wl-scrim {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: rgba(7, 8, 12, 0.75);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    overscroll-behavior: contain;
    animation: wlFade 0.15s ease;
  }
  .wl-box {
    background: var(--surface-1);
    border: 1px solid var(--border-h);
    border-radius: 14px;
    width: 440px;
    max-width: 100%;
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 24px 28px 26px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
    animation: wlSlide 0.2s ease;
  }
  .wl-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 20px;
  }
  .wl-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    color: var(--text-1);
    margin: 0;
    text-wrap: balance;
  }
  .wl-sub {
    font-size: 12.5px;
    color: var(--text-3);
    margin: 4px 0 0;
    line-height: 1.45;
  }
  .wl-x {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: 1px solid transparent;
    background: none;
    color: var(--text-3);
    cursor: pointer;
    touch-action: manipulation;
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  }
  .wl-x svg {
    width: 16px;
    height: 16px;
  }
  .wl-x:hover {
    color: var(--text-1);
    border-color: var(--border);
    background: var(--surface-2);
  }
  .wl-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .wl-live:empty {
    display: none;
  }
  .wl-error {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    margin: 14px 0 0;
    padding: 9px 11px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--red) 45%, transparent);
    background: color-mix(in srgb, var(--red) 12%, transparent);
    color: var(--text-1);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .wl-error svg {
    width: 15px;
    height: 15px;
    flex: none;
    margin-top: 1px;
    color: var(--red);
  }
  .wl-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 22px;
  }
  .wl-cancel,
  .wl-go {
    min-height: 36px;
    border-radius: 8px;
    font-size: 13px;
    font-family: var(--font-body);
    cursor: pointer;
    touch-action: manipulation;
  }
  .wl-cancel {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 8px 18px;
    transition: border-color 0.15s ease, color 0.15s ease;
  }
  .wl-cancel:hover {
    border-color: var(--border-h);
    color: var(--text-1);
  }
  .wl-go {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--gold);
    border: 1px solid var(--gold);
    color: var(--bg);
    font-weight: 700;
    padding: 8px 22px;
    transition: opacity 0.15s ease;
  }
  .wl-go:hover:not(:disabled) {
    opacity: 0.86;
  }
  .wl-go:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .wl-spinner {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--bg) 35%, transparent);
    border-top-color: var(--bg);
    animation: wlSpin 0.7s linear infinite;
  }

  /* One focus treatment for every control in the dialog. */
  .wl-box :global(:focus-visible) {
    outline: 2px solid var(--gold);
    outline-offset: 2px;
    border-radius: 6px;
  }

  @keyframes wlFade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes wlSlide {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }
  @keyframes wlSpin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .wl-scrim,
    .wl-box {
      animation: none;
    }
    .wl-spinner {
      animation-duration: 2.4s;
    }
  }
</style>
