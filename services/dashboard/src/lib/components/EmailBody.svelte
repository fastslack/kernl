<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { buildSrcdoc, remoteImageCount } from '$lib/mail-body.js';

  /** Sanitized HTML from the kernel; '' or null falls back to the text body. */
  export let html: string | null = null;
  export let text = '';

  let showImages = false;
  let plain = false;
  let frame: HTMLIFrameElement;
  let height = 120;
  let observer: ResizeObserver | null = null;

  // A different message starts blocked and formatted again.
  let lastHtml: string | null = null;
  $: if (html !== lastHtml) { lastHtml = html; showImages = false; plain = false; }

  $: hasHtml = !!html && html.trim() !== '';
  $: blocked = hasHtml ? remoteImageCount(html ?? '') : 0;
  $: srcdoc = hasHtml ? buildSrcdoc(html ?? '', showImages) : '';

  // Same-origin (allow-same-origin, never allow-scripts) so the frame can be
  // sized to its content instead of scrolling inside the detail pane.
  function fit() {
    observer?.disconnect();
    const doc = frame?.contentDocument;
    if (!doc?.documentElement) return;
    const measure = () => { height = Math.max(60, doc.documentElement.scrollHeight); };
    measure();
    observer = new ResizeObserver(measure);
    observer.observe(doc.documentElement);
  }
  onDestroy(() => observer?.disconnect());
</script>

{#if hasHtml && !plain}
  <div class="body-tools">
    {#if blocked > 0 && !showImages}
      <div class="images-bar" role="note">
        <span class="images-icon" aria-hidden="true">🛡️</span>
        <span class="images-text">{$t('mailbody.images_blocked', { n: blocked })}</span>
        <button class="images-btn" on:click={() => (showImages = true)}>{$t('mailbody.show_images')}</button>
      </div>
    {/if}
    <button class="view-toggle" on:click={() => (plain = true)}>{$t('mailbody.view_text')}</button>
  </div>
  <iframe
    bind:this={frame}
    class="body-frame"
    title="email"
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    referrerpolicy="no-referrer"
    {srcdoc}
    style="height: {height}px"
    on:load={fit}
  ></iframe>
{:else}
  {#if hasHtml}
    <div class="body-tools">
      <button class="view-toggle" on:click={() => (plain = false)}>{$t('mailbody.view_html')}</button>
    </div>
  {/if}
  <div class="body-text">{text || $t('mailbody.empty')}</div>
{/if}

<style>
  .body-tools {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 10px;
  }
  .images-bar {
    flex: 1 1 320px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--gold, #d4a72c) 45%, transparent);
    background: color-mix(in srgb, var(--gold, #d4a72c) 10%, transparent);
    font-size: 12px;
    color: var(--text-2);
  }
  .images-text { flex: 1; min-width: 0; }
  .images-btn {
    flex: none;
    padding: 5px 12px;
    border-radius: 6px;
    border: none;
    background: var(--gold, #d4a72c);
    color: #111;
    font-weight: 600;
    font-size: 12px;
    cursor: pointer;
  }
  .images-btn:hover { filter: brightness(1.08); }
  .view-toggle {
    flex: none;
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: none;
    color: var(--text-3);
    font-size: 11px;
    cursor: pointer;
  }
  .view-toggle:hover { color: var(--text-1); border-color: var(--border-h, var(--border)); }
  .body-frame {
    display: block;
    width: 100%;
    border: none;
    border-radius: 8px;
    background: #fff;
  }
  .body-text { white-space: pre-wrap; word-break: break-word; }
</style>
