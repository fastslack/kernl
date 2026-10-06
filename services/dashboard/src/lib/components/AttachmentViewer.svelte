<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import { t } from '$lib/i18n/index.js';
  import { attachmentFileUrl, attachmentFrameUrl, derivedText, docTypeLabel, formatBytes, formatDuration } from '$lib/attachments/files.js';
  import { fetchBlobUrl, mediaUrl, releaseMedia } from '$lib/attachments/media.js';
  import type { AttachmentMeta } from '$lib/attachments/types.js';

  /**
   * One attachment, full size, in a modal of fixed height — the image, the
   * video with its controls, or for a PDF a button that opens it in a new tab
   * (an inline PDF viewer would need the token in the URL). The ⋯ menu adds
   * download and "what the model read": the extracted text, the transcript,
   * the description, the frames — exactly what the kernel derived and fed
   * to the model, so a strange answer can be checked against its input.
   *
   * `meta` null means closed.
   */
  export let meta: AttachmentMeta | null = null;

  const dispatch = createEventDispatcher<{ close: void }>();

  type Mode = 'original' | 'derived';
  let mode: Mode = 'original';
  let src = '';
  let loadError = false;
  let menuOpen = false;
  let frameSrcs: string[] = [];
  /** The shown original is not cached; this is the blob: URL to revoke. */
  let ownedUrl = '';
  let shownId = '';

  $: isPdf = meta?.mime === 'application/pdf';
  // Without a preview of their own, docx/txt/md/csv/json open on their text.
  $: hasPreview = meta ? meta.kind !== 'document' || isPdf : false;
  $: text = meta ? derivedText(meta) : null;
  $: frames = meta?.derived?.frames ?? [];
  $: warnings = meta?.derived?.warnings ?? [];
  $: if ((meta?.id ?? '') !== shownId) show(meta);
  $: if (mode === 'derived' && meta?.kind === 'video' && frames.length && frameSrcs.length === 0) void loadFrames(meta);

  /** Frame URLs held in the shared media cache while this attachment is shown. */
  let heldFrames: string[] = [];

  function release() {
    if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    ownedUrl = '';
    for (const url of heldFrames) releaseMedia(url);
    heldFrames = [];
  }

  async function show(m: AttachmentMeta | null) {
    release();
    shownId = m?.id ?? '';
    src = ''; loadError = false; menuOpen = false; frameSrcs = [];
    if (!m) return;
    mode = m.kind === 'document' && m.mime !== 'application/pdf' ? 'derived' : 'original';
    if (m.kind !== 'image' && m.kind !== 'video') return;
    try {
      const url = await fetchBlobUrl(attachmentFileUrl(m.id));
      if (shownId !== m.id) { URL.revokeObjectURL(url); return; }
      ownedUrl = url;
      src = url;
    } catch {
      if (shownId === m.id) loadError = true;
    }
  }

  async function loadFrames(m: AttachmentMeta) {
    const id = m.id;
    const keys = (m.derived.frames ?? []).map((_, i) => attachmentFrameUrl(id, i));
    heldFrames = keys;
    const urls = await Promise.all(keys.map((k) => mediaUrl(k).catch(() => '')));
    if (shownId === id) frameSrcs = urls;
  }

  async function download() {
    menuOpen = false;
    if (!meta) return;
    const m = meta;
    try {
      const url = await fetchBlobUrl(attachmentFileUrl(m.id));
      const a = document.createElement('a');
      a.href = url; a.download = m.filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      loadError = true;
    }
  }

  async function openInTab() {
    menuOpen = false;
    if (!meta) return;
    // Open the tab inside the click, before the fetch: a window.open after an
    // await is a popup the browser blocks.
    const w = window.open('', '_blank');
    try {
      const url = await fetchBlobUrl(attachmentFileUrl(meta.id));
      if (w) w.location.href = url; else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      w?.close();
      loadError = true;
    }
  }

  function close() {
    release();
    dispatch('close');
  }

  onDestroy(release);

  // The modal's title does not wrap or clip; a long name would push ⋯ out.
  $: title = !meta ? '' : meta.filename.length > 48 ? meta.filename.slice(0, 45) + '…' : meta.filename;
  $: subtitle = meta ? [
    meta.kind === 'document' ? docTypeLabel(meta) : $t(`attach.kind.${meta.kind}`),
    meta.derived?.pages ? $t('attach.pages', { n: meta.derived.pages }) : '',
    meta.derived?.duration_s ? formatDuration(meta.derived.duration_s) : '',
    meta.derived?.width && meta.derived?.height ? `${meta.derived.width}×${meta.derived.height}` : '',
    formatBytes(meta.size_bytes),
  ].filter(Boolean).join(' · ') : '';
</script>

<svelte:window on:click={() => (menuOpen = false)} />

<Modal open={!!meta} title={title} width="760px" on:close={close}>
  <svelte:fragment slot="header">
    <span class="av-sub">{subtitle}</span>
    <div class="av-menu-wrap">
      <button
        type="button"
        class="k-icon-btn"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={$t('attach.viewer.more')}
        title={$t('attach.viewer.more')}
        on:click|stopPropagation={() => (menuOpen = !menuOpen)}
      >
        <Icon name="more" />
      </button>
      {#if menuOpen}
        <div class="av-menu" role="menu">
          <button type="button" role="menuitem" class="av-item" on:click|stopPropagation={download}>
            <Icon name="download" size={14} /> {$t('attach.viewer.download')}
          </button>
          {#if hasPreview}
            <button type="button" role="menuitem" class="av-item" on:click|stopPropagation={openInTab}>
              <Icon name="fit" size={14} /> {$t('attach.viewer.open_tab')}
            </button>
          {/if}
          {#if mode === 'original'}
            <button type="button" role="menuitem" class="av-item" on:click|stopPropagation={() => { mode = 'derived'; menuOpen = false; }}>
              <Icon name="eye" size={14} /> {$t('attach.viewer.derived')}
            </button>
          {:else if hasPreview}
            <button type="button" role="menuitem" class="av-item" on:click|stopPropagation={() => { mode = 'original'; menuOpen = false; }}>
              <Icon name="eye" size={14} /> {$t('attach.viewer.original')}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </svelte:fragment>

  {#if meta}
    <div class="av-stage" class:av-stage--text={mode === 'derived'}>
      {#if mode === 'original'}
        {#if loadError}
          <p class="av-note">{$t('attach.viewer.load_error')}</p>
        {:else if meta.kind === 'image'}
          {#if src}<img class="av-media" {src} alt={meta.derived?.description || meta.filename} />{:else}<p class="av-note">{$t('attach.viewer.loading')}</p>{/if}
        {:else if meta.kind === 'video'}
          {#if src}
            <!-- svelte-ignore a11y-media-has-caption -->
            <video class="av-media" {src} controls preload="metadata"></video>
          {:else}<p class="av-note">{$t('attach.viewer.loading')}</p>{/if}
        {:else if isPdf}
          <div class="av-doc">
            <span class="av-doc-type">{docTypeLabel(meta)}</span>
            <p class="av-note">{$t('attach.viewer.pdf_hint')}</p>
            <button type="button" class="k-btn k-btn--primary" on:click={openInTab}>{$t('attach.viewer.open_tab')}</button>
          </div>
        {:else}
          <p class="av-note">{$t('attach.viewer.no_preview')}</p>
        {/if}
      {:else}
        {#if warnings.length}
          <div class="av-warn" role="note">
            <Icon name="alert" size={13} />
            <span><strong>{$t('attach.viewer.warnings')}:</strong> {warnings.join(' · ')}</span>
          </div>
        {/if}
        {#if meta.kind === 'video' && frames.length}
          <p class="k-section-title av-h">{$t('attach.viewer.frames', { n: frames.length })}</p>
          <div class="av-frames">
            {#each frames as _, i (i)}
              <div class="av-frame">{#if frameSrcs[i]}<img src={frameSrcs[i]} alt="" />{/if}</div>
            {/each}
          </div>
        {/if}
        {#if text}
          <p class="k-section-title av-h">
            {meta.kind === 'video' ? $t('attach.viewer.transcript') : meta.kind === 'image' ? $t('attach.viewer.description') : $t('attach.viewer.text')}
          </p>
          <pre class="av-text">{text}</pre>
        {:else if !(meta.kind === 'video' && frames.length)}
          <p class="av-note">{$t('attach.viewer.no_derived')}</p>
        {/if}
      {/if}
    </div>
  {/if}
</Modal>

<style>
  .av-sub {
    min-width: 0; margin-right: 4px;
    font: 500 11px var(--font-mono); color: var(--text-3);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .av-menu-wrap { position: relative; flex: none; }
  .av-menu {
    position: absolute; top: calc(100% + 4px); right: 0; z-index: 2;
    min-width: 210px; padding: 4px;
    background: var(--surface-2); border: 1px solid var(--border-h); border-radius: var(--radius-sm);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
  }
  .av-item {
    width: 100%; height: 32px; padding: 0 10px;
    display: flex; align-items: center; gap: 8px;
    background: none; border: none; border-radius: 4px;
    color: var(--text-1); font: 500 12px var(--font-body); text-align: left; cursor: pointer;
  }
  .av-item:hover, .av-item:focus-visible { background: var(--surface-3); outline: none; }

  /* Fixed height whatever the content: switching between the file and what
     the model read must not make the dialog jump. */
  .av-stage {
    height: min(60vh, 520px);
    display: grid; place-items: center;
    background: var(--bg); border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .av-stage--text {
    display: block; padding: 12px 14px; overflow-y: auto;
    scrollbar-width: thin; scrollbar-color: var(--border-h) transparent;
  }
  .av-media { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
  .av-note { margin: 0; color: var(--text-3); font: 400 12px var(--font-body); text-align: center; }
  .av-doc { display: grid; justify-items: center; gap: 12px; }
  .av-doc-type {
    padding: 10px 14px; border-radius: var(--radius-sm);
    background: var(--surface-2); border: 1px solid var(--border);
    font: 600 14px var(--font-mono); color: var(--text-2);
  }
  .av-h { margin: 0 0 6px; }
  .av-h:not(:first-child) { margin-top: 12px; }
  .av-text {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font: 400 12px/1.55 var(--font-mono); color: var(--text-2);
  }
  .av-frames { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; }
  .av-frame { aspect-ratio: 16 / 9; border-radius: 4px; overflow: hidden; background: var(--surface-2); }
  .av-frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .av-warn {
    display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px;
    padding: 6px 10px; border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--orange) 10%, transparent);
    color: var(--orange); font: 400 11px var(--font-body);
  }
</style>
