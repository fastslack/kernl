<script context="module" lang="ts">
  export type PendingAttach = {
    kind: 'image' | 'document';
    filename: string;
    media_type: string;
    data: string;       // base64 payload
    preview: string;    // data URL for thumbnail
    sizeBytes: number;
  };
</script>

<script lang="ts">
  /**
   * The chat's composer: textarea, attachments (picker, drag-and-drop and
   * paste) and the send button.
   *
   * Sending stays in the page — it owns the transcript and the stream — so
   * the text, the pending attachments and the textarea element are bound:
   * the page clears the first two on send (and puts the attachments back on
   * failure), and focuses and resizes the textarea itself.
   */
  export let input = '';
  export let pendingAttachments: PendingAttach[] = [];
  export let inputEl: HTMLTextAreaElement | undefined = undefined;
  export let sending = false;
  export let onSend: () => void = () => {};

  let fileInputEl: HTMLInputElement;
  let dragActive = false;
  const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
  const ACCEPTED_IMAGE = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const ACCEPTED_DOC = ['application/pdf'];

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files);
    for (const f of list) {
      const isImage = ACCEPTED_IMAGE.includes(f.type);
      const isDoc = ACCEPTED_DOC.includes(f.type);
      if (!isImage && !isDoc) {
        alert(`"${f.name}": formato no soportado. Solo imágenes (PNG/JPG/GIF/WEBP) o PDF.`);
        continue;
      }
      if (f.size > MAX_ATTACH_BYTES) {
        alert(`"${f.name}": 10 MB maximum.`);
        continue;
      }
      const b64 = await fileToBase64(f);
      const preview = isImage
        ? `data:${f.type};base64,${b64}`
        : '';
      pendingAttachments = [...pendingAttachments, {
        kind: isImage ? 'image' : 'document',
        filename: f.name,
        media_type: f.type,
        data: b64,
        preview,
        sizeBytes: f.size,
      }];
    }
  }

  function fileToBase64(f: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result ?? '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      r.onerror = () => reject(r.error);
      r.readAsDataURL(f);
    });
  }

  function removeAttachment(idx: number) {
    pendingAttachments = pendingAttachments.filter((_, i) => i !== idx);
  }

  function onPickFiles(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.files) handleFiles(t.files);
    t.value = '';
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragActive = false;
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  }

  function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      handleFiles(files);
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  }

  function autoResize(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }
</script>

<div class="cx-input-area">
  <div
    class="cx-input-box"
    class:cx-drag={dragActive}
    on:dragover|preventDefault={() => dragActive = true}
    on:dragleave={() => dragActive = false}
    on:drop={onDrop}
  >
    {#if pendingAttachments.length > 0}
      <div class="cx-pending">
        {#each pendingAttachments as a, i}
          <div class="cx-pending-item" title={a.filename}>
            {#if a.kind === 'image'}
              <img src={a.preview} alt={a.filename} class="cx-pending-thumb" />
            {:else}
              <div class="cx-pending-doc">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="18" height="18">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
                <span class="cx-pending-doc-name">{a.filename}</span>
              </div>
            {/if}
            <button class="cx-pending-x" on:click={() => removeAttachment(i)} title="Remove">×</button>
          </div>
        {/each}
      </div>
    {/if}

    <textarea
      bind:this={inputEl}
      class="cx-textarea"
      bind:value={input}
      on:keydown={onKeydown}
      on:input={autoResize}
      on:paste={onPaste}
      placeholder={pendingAttachments.length ? 'Describe the attachment or ask a question…' : 'Message…'}
      rows="1"
      disabled={sending}
    ></textarea>

    <input
      bind:this={fileInputEl}
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
      multiple
      style="display:none"
      on:change={onPickFiles}
    />

    <div class="cx-input-actions">
      <button class="cx-attach-btn" on:click={() => fileInputEl?.click()} title="Attach image or PDF" disabled={sending}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21.44 11.05L12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
        </svg>
      </button>
      <span class="cx-input-hint">
        {#if sending}
          Thinking…
        {:else if dragActive}
          Drop file to attach
        {:else}
          Enter to send · Shift+Enter newline
        {/if}
      </span>
      <button class="cx-send" on:click={onSend} disabled={sending || (!input.trim() && pendingAttachments.length === 0)}>
        {#if sending}
          <div class="cx-send-spinner"></div>
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        {/if}
      </button>
    </div>
  </div>
</div>

<style>
  .cx-input-area {
    flex-shrink: 0;
    padding: 12px 24px 16px;
    position: relative;
    z-index: 1;
    background: linear-gradient(180deg, transparent 0%, var(--bg) 20%);
  }

  .cx-input-box {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 4px;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .cx-input-box:focus-within {
    border-color: rgba(212, 168, 75, 0.4);
    box-shadow: 0 0 0 3px rgba(212, 168, 75, 0.06), 0 4px 24px rgba(0, 0, 0, 0.15);
  }

  .cx-textarea {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text-1);
    font-size: 13.5px;
    font-family: var(--font-body);
    padding: 10px 14px 4px;
    outline: none;
    resize: none;
    min-height: 36px;
    max-height: 160px;
    overflow-y: auto;
    line-height: 1.5;
  }

  .cx-textarea::placeholder { color: var(--text-3); }
  .cx-textarea:disabled { opacity: 0.5; }

  .cx-input-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 6px 4px 8px;
  }

  .cx-input-hint {
    font-size: 10px;
    color: var(--text-3);
    font-family: var(--font-mono);
    flex: 1;
  }

  .cx-attach-btn {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: none;
    background: transparent;
    color: var(--text-3);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    flex-shrink: 0;
  }
  .cx-attach-btn svg { width: 16px; height: 16px; }
  .cx-attach-btn:hover:not(:disabled) { background: var(--surface-2); color: var(--gold); }
  .cx-attach-btn:disabled { opacity: 0.35; cursor: default; }

  .cx-input-box.cx-drag {
    border-color: var(--gold);
    box-shadow: 0 0 0 3px rgba(212, 168, 75, 0.12);
  }

  .cx-pending {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 10px 2px;
  }

  .cx-pending-item {
    position: relative;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    overflow: hidden;
  }

  .cx-pending-thumb {
    width: 64px;
    height: 64px;
    object-fit: cover;
    display: block;
  }

  .cx-pending-doc {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    max-width: 220px;
    color: var(--text-2);
  }

  .cx-pending-doc-name {
    font-size: 11.5px;
    font-family: var(--font-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cx-pending-x {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: none;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .cx-pending-x:hover { background: var(--red, #f04770); }

  .cx-send {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    border: none;
    background: var(--gold);
    color: var(--bg);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
    flex-shrink: 0;
  }

  .cx-send svg { width: 16px; height: 16px; }

  .cx-send:hover:not(:disabled) {
    transform: scale(1.05);
    box-shadow: 0 2px 12px rgba(212, 168, 75, 0.3);
  }

  .cx-send:disabled {
    opacity: 0.25;
    cursor: default;
    transform: none;
    box-shadow: none;
  }

  .cx-send-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid transparent;
    border-top-color: var(--bg);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
