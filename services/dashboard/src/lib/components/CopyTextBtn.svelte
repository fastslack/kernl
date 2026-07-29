<!--
  Small floating "copy to clipboard" button. Drop it inside a container that
  has `position: relative` (or wrap the target with `.copy-wrap`). Visually it
  sits in the top-right corner with low opacity until the container is hovered.

  Usage:
    <div class="copy-wrap">
      <CopyTextBtn text={someString} title="Copy transcript" />
      <pre>{someString}</pre>
    </div>

  The component owns its "✓ copied" feedback state — no shared `copiedKey`
  needed in the parent.
-->
<script lang="ts">
  export let text: string | null | undefined = '';
  export let title: string = 'Copy to clipboard';
  /** When true, render inline (no absolute positioning) — useful in headers. */
  export let inline: boolean = false;

  let state: 'idle' | 'ok' | 'err' = 'idle';
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  async function handleCopy(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    const t = text ?? '';
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      state = 'ok';
    } catch {
      // Some sandboxed iframes block clipboard API — fall back to a hidden
      // textarea + execCommand. Still a no-op if even that's blocked.
      try {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        state = 'ok';
      } catch {
        state = 'err';
      }
    }
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { state = 'idle'; }, 1400);
  }
</script>

<button
  class="copy-btn"
  class:copy-btn--inline={inline}
  class:copy-btn--ok={state === 'ok'}
  class:copy-btn--err={state === 'err'}
  type="button"
  title={state === 'ok' ? 'Copied!' : state === 'err' ? 'Copy failed' : title}
  aria-label={title}
  on:click={handleCopy}
>
  {state === 'ok' ? '✓' : state === 'err' ? '✗' : '⧉'}
</button>

<style>
  .copy-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border: 1px solid rgba(120, 130, 160, 0.18);
    background: rgba(20, 24, 36, 0.72);
    color: #b8bcc8;
    border-radius: 6px;
    cursor: pointer;
    font: 600 13px/1 'JetBrains Mono', monospace;
    opacity: 0;
    transform: translateY(-2px);
    transition:
      opacity .14s ease,
      transform .14s ease,
      color .14s ease,
      border-color .14s ease,
      background .14s ease;
    z-index: 3;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  /* Reveal on hover/focus of the wrapping container OR direct hover. */
  :global(.copy-wrap:hover) > .copy-btn,
  :global(.copy-wrap:focus-within) > .copy-btn,
  .copy-btn:hover,
  .copy-btn:focus-visible {
    opacity: 1;
    transform: translateY(0);
  }
  .copy-btn:hover {
    color: #fff;
    border-color: rgba(120, 130, 160, 0.45);
    background: rgba(40, 48, 70, 0.92);
  }
  .copy-btn--ok {
    color: #78dc8c;
    border-color: rgba(120, 220, 140, 0.45);
    background: rgba(30, 50, 38, 0.92);
    opacity: 1 !important;
    transform: translateY(0) !important;
  }
  .copy-btn--err {
    color: #ef5d6e;
    border-color: rgba(239, 93, 110, 0.45);
    background: rgba(50, 28, 32, 0.92);
    opacity: 1 !important;
    transform: translateY(0) !important;
  }
  .copy-btn--inline {
    position: static;
    opacity: 1;
    transform: none;
    width: 22px;
    height: 22px;
    font-size: 11px;
  }
</style>
