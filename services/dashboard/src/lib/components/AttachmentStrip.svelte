<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import AttachmentViewer from '$lib/components/AttachmentViewer.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import { attachmentFrameUrl, attachmentThumbUrl, docTypeLabel, formatBytes, formatDuration } from '$lib/attachments/files.js';
  import { loadAttachmentMeta, mediaUrl, releaseMedia } from '$lib/attachments/media.js';
  import type { AttachmentMeta } from '$lib/attachments/types.js';

  /**
   * The attachments of one sent message, inside its bubble: images as 96 px
   * thumbs, documents as a chip with type and pages, videos as their first
   * frame with the duration. Click opens the viewer.
   *
   * Takes metas, or bare ids (what a stored message envelope holds) that are
   * fetched here, once each — the meta cache is shared across strips.
   */
  export let attachments: Array<AttachmentMeta | string> = [];

  type Slot = { id: string; meta?: AttachmentMeta; missing?: boolean };

  let slots: Slot[] = [];
  let thumbs: Record<string, string> = {};
  let viewing: AttachmentMeta | null = null;
  let alive = true;
  /** Media URLs this strip holds, released when it goes away. */
  const held = new Set<string>();
  onDestroy(() => {
    alive = false;
    for (const url of held) releaseMedia(url);
    held.clear();
  });

  $: resolve(attachments);

  function resolve(list: Array<AttachmentMeta | string>) {
    slots = list.map((a) => (typeof a === 'string' ? { id: a } : { id: a.id, meta: a }));
    for (const s of slots) {
      if (s.meta) loadThumb(s.meta);
      else loadAttachmentMeta(s.id).then(
        (m) => { if (alive) { setSlot(s.id, { meta: m }); loadThumb(m); } },
        () => { if (alive) setSlot(s.id, { missing: true }); },
      );
    }
  }

  function setSlot(id: string, change: Partial<Slot>) {
    slots = slots.map((s) => (s.id === id ? { ...s, ...change } : s));
  }

  function loadThumb(m: AttachmentMeta) {
    if (m.status !== 'ready' || thumbs[m.id]) return;
    const url = m.kind === 'image' ? attachmentThumbUrl(m.id)
      : m.kind === 'video' && m.derived?.frames?.length ? attachmentFrameUrl(m.id, 0)
      : '';
    if (!url || held.has(url)) return;
    held.add(url);
    mediaUrl(url).then((u) => { if (alive) thumbs = { ...thumbs, [m.id]: u }; }, () => {});
  }

  /** Thumb width from the stored dimensions, so the row does not jump as images arrive. */
  function thumbWidth(m: AttachmentMeta): number {
    const { width, height } = m.derived ?? {};
    if (!width || !height) return m.kind === 'video' ? 170 : 96;
    return Math.round(Math.min(220, Math.max(48, (96 * width) / height)));
  }

  function docLine(m: AttachmentMeta): string {
    return [docTypeLabel(m), m.derived?.pages ? $t('attach.pages', { n: m.derived.pages }) : formatBytes(m.size_bytes)].join(' · ');
  }
</script>

{#if slots.length}
  <div class="as" role="list">
    {#each slots as s (s.id)}
      {@const m = s.meta}
      <div role="listitem" class="as-item">
        {#if s.missing || m?.status === 'failed'}
          <span class="as-chip as-chip--off" title={m?.error || ''}>
            <span class="as-ico"><Icon name="x" size={12} /></span>
            <span class="as-name">{m?.filename ?? $t('attach.unavailable')}</span>
          </span>
        {:else if !m}
          <span class="as-chip as-chip--loading" aria-busy="true"><span class="as-spin" aria-hidden="true"></span></span>
        {:else if m.status === 'processing'}
          <span class="as-chip" title={$t('attach.state.processing')}>
            <span class="as-spin" aria-hidden="true"></span>
            <span class="as-name">{m.filename}</span>
          </span>
        {:else if m.kind === 'document'}
          <button type="button" class="as-chip" on:click={() => (viewing = m ?? null)} aria-label={$t('attach.open', { name: m.filename })} title={m.filename}>
            <svg class="as-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
            <span class="as-name">{m.filename}</span>
            <span class="as-meta">{docLine(m)}</span>
          </button>
        {:else}
          <button
            type="button"
            class="as-thumb"
            style="width:{thumbWidth(m)}px"
            on:click={() => (viewing = m ?? null)}
            aria-label={$t('attach.open', { name: m.filename })}
            title={m.filename}
          >
            {#if thumbs[m.id]}<img src={thumbs[m.id]} alt="" />{/if}
            {#if m.kind === 'video'}
              <span class="as-play" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 4v16l13-8Z" /></svg>
              </span>
              {#if m.derived?.duration_s}<span class="as-dur">{formatDuration(m.derived.duration_s)}</span>{/if}
            {/if}
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<AttachmentViewer meta={viewing} on:close={() => (viewing = null)} />

<style>
  .as { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0; }
  .as-item { display: contents; }

  .as-thumb {
    position: relative; height: 96px; padding: 0;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface-2); overflow: hidden; cursor: zoom-in;
  }
  .as-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .as-thumb:hover { border-color: var(--border-h); }
  .as-thumb:focus-visible, .as-chip:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .as-play {
    position: absolute; inset: 0; margin: auto; width: 28px; height: 28px;
    display: grid; place-items: center; border-radius: 50%;
    background: rgba(0, 0, 0, .55); color: #fff;
  }
  .as-dur {
    position: absolute; right: 4px; bottom: 4px; padding: 1px 5px; border-radius: 3px;
    background: rgba(0, 0, 0, .65); color: #fff;
    font: 500 10px var(--font-mono); font-variant-numeric: tabular-nums;
  }

  .as-chip {
    display: inline-flex; align-items: center; gap: 6px;
    height: 32px; max-width: 280px; padding: 0 10px;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface-2); color: var(--text-1);
    font: 500 12px var(--font-body); cursor: pointer;
  }
  button.as-chip:hover { border-color: var(--border-h); background: var(--surface-3); }
  .as-chip--off { color: var(--text-3); cursor: default; }
  .as-chip--loading { width: 96px; justify-content: center; cursor: default; }
  .as-ico { flex: none; color: var(--text-3); }
  .as-name { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .as-meta { flex: none; color: var(--text-3); font: 500 10px var(--font-mono); }
  .as-spin {
    flex: none; width: 10px; height: 10px; border-radius: 50%;
    border: 1.5px solid var(--border-h); border-top-color: var(--text-2);
    animation: as-spin .8s linear infinite;
  }
  @keyframes as-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .as-spin { animation: none; } }
</style>
