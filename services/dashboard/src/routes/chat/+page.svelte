<script lang="ts">
  import { onMount, tick, afterUpdate } from 'svelte';
  import ClaudeCodeAuthModal from '$lib/components/ClaudeCodeAuthModal.svelte';
  import ToolCard from '$lib/components/ToolCard.svelte';
  import { isClaudeCodeAuthError } from '$lib/claude-code-auth.js';
  import { modelIds } from '$lib/llm-models.js';
  import { formatMd } from '$lib/chat-md.js';
  import { formatToolInput } from '$lib/tool-presentation.js';

  /** The provider's session lapsed — offer the fix instead of a dead instruction. */
  let ccAuthOpen = false;

  /** The auth failure can arrive as plain content OR inside content_blocks. */
  function msgAuthError(m: any): boolean {
    if (isClaudeCodeAuthError(m?.content)) return true;
    try {
      const blocks = typeof m?.content_blocks === 'string' ? JSON.parse(m.content_blocks) : m?.content_blocks;
      if (!Array.isArray(blocks)) return false;
      return isClaudeCodeAuthError(blocks.map((b: any) => b?.text ?? '').join(' '));
    } catch {
      return false;
    }
  }

  /** The live bubble is a separate render path and needs the same affordance. */
  function streamAuthError(blocks: any[]): boolean {
    return isClaudeCodeAuthError((blocks ?? []).filter((b) => b?.type === 'text').map((b) => b?.text ?? '').join(' '));
  }

  /**
   * A failed turn is reported twice — once by the SSE `error` event and once by
   * the HTTP reply — so the same text landed in the transcript as two bubbles.
   * Whichever arrives second is dropped.
   */
  function appendError(text: string): void {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && last.content === text) return;
    messages = [...messages, { role: 'assistant', content: text, created_at: new Date().toISOString() }];
  }

  import { fmtTime, timeAgo } from '$lib/utils.js';
  import {
    getChatEpisodes,
    getChatMessages,
    startChatEpisode,
    sendChatMessage,
    sendChatMessageStream,
    respondChatPermission,
    getPiiStatus,
    type ChatStreamEvent,
  } from '$lib/api.js';

  /** Permission prompt currently waiting on the user. Only one at a time —
   *  the SDK serializes its canUseTool calls so we never have two pending. */
  type PendingPermission = {
    request_id: string;
    tool_name: string;
    input: Record<string, unknown>;
  };
  let pendingPermission: PendingPermission | null = null;

  /** While streaming, this message accumulates SDK events. Rendered as a
   *  live "assistant" bubble that shows text deltas + tool cards as they
   *  arrive. Cleared and replaced with the persisted message on `done`. */
  type StreamBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; result?: string; is_error?: boolean };
  let streamingBlocks: StreamBlock[] = [];
  let streamingActive = false;
  let streamAbort: AbortController | null = null;

  let episodes: any[] = [];
  let selectedEpisodeId: string | null = null;
  let messages: any[] = [];
  let input = '';
  let sending = false;
  let loading = false;
  let piiStatus: any = null;
  let msgArea: HTMLDivElement;
  let inputEl: HTMLTextAreaElement;
  let fileInputEl: HTMLInputElement;
  let sidebarCollapsed = false;
  let searchQuery = '';
  let deleteConfirmId: string | null = null;

  // Attachments pending for the next send
  type PendingAttach = {
    kind: 'image' | 'document';
    filename: string;
    media_type: string;
    data: string;       // base64 payload
    preview: string;    // data URL for thumbnail
    sizeBytes: number;
  };
  let pendingAttachments: PendingAttach[] = [];
  let dragActive = false;
  const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
  const ACCEPTED_IMAGE = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const ACCEPTED_DOC = ['application/pdf'];

  $: selectedEp = episodes.find(e => e.id === selectedEpisodeId);
  $: filteredEpisodes = searchQuery
    ? episodes.filter(e => (e.title || '').toLowerCase().includes(searchQuery.toLowerCase()))
    : episodes;

  onMount(async () => {
    await loadEpisodes();
    piiStatus = await getPiiStatus().catch(() => null);
    void loadAvailableProviders();
    // Focus input on load
    setTimeout(() => inputEl?.focus(), 100);
  });

  // Auto-scroll when messages change
  afterUpdate(() => {
    scrollBottom();
  });

  async function loadEpisodes() {
    episodes = await getChatEpisodes().catch(() => []);
    if (!selectedEpisodeId && episodes.length) {
      await selectEpisode(episodes[0].id);
    }
  }

  async function selectEpisode(id: string) {
    selectedEpisodeId = id;
    loading = true;
    try {
      const msgs = await getChatMessages(id);
      messages = (msgs as any[]).filter(m => m.role !== 'system');
    } finally { loading = false; }
    await tick();
    scrollBottom();
    inputEl?.focus();
  }

  async function newEpisode() {
    const ep = await startChatEpisode() as any;
    episodes = [ep, ...episodes];
    await selectEpisode(ep.id);
  }

  // ── Delete episode ─────────────────────────────────
  // Two-step: first click on trash arms `deleteConfirmId`, second click on
  // the same row's confirm icon actually deletes. Click anywhere else cancels.
  let deletingEpisodeId: string | null = null;

  function askDelete(id: string, ev: Event) {
    ev.stopPropagation();
    deleteConfirmId = deleteConfirmId === id ? null : id;
  }
  function cancelDelete(ev?: Event) {
    if (ev) ev.stopPropagation();
    deleteConfirmId = null;
  }
  async function confirmDelete(id: string, ev: Event) {
    ev.stopPropagation();
    deletingEpisodeId = id;
    try {
      const r = await fetch('/api/chat/episode/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episode_id: id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      // Drop from local list
      episodes = episodes.filter(e => e.id !== id);
      // If the deleted one was active, pick the next one or clear
      if (selectedEpisodeId === id) {
        if (episodes.length > 0) {
          await selectEpisode(episodes[0].id);
        } else {
          selectedEpisodeId = null;
          messages = [];
        }
      }
      deleteConfirmId = null;
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
    } finally {
      deletingEpisodeId = null;
    }
  }

  function scrollBottom() {
    if (msgArea) {
      msgArea.scrollTo({ top: msgArea.scrollHeight, behavior: 'smooth' });
    }
  }

  async function doSend() {
    if (sending || !selectedEpisodeId) return;
    const msg = input.trim();
    if (!msg && pendingAttachments.length === 0) return;

    const images = pendingAttachments
      .filter(a => a.kind === 'image')
      .map(a => ({ data: a.data, media_type: a.media_type }));
    const documents = pendingAttachments
      .filter(a => a.kind === 'document')
      .map(a => ({ data: a.data, media_type: a.media_type, filename: a.filename }));

    // Build optimistic user content (text + inline attachments for local echo)
    const optimisticContent = images.length || documents.length
      ? JSON.stringify({
          text: msg,
          images: pendingAttachments.filter(a => a.kind === 'image').map(a => a.preview),
          documents: pendingAttachments.filter(a => a.kind === 'document').map(a => ({ filename: a.filename })),
          _local: true,
        })
      : msg;

    input = '';
    if (inputEl) inputEl.style.height = 'auto';
    const sentAttachments = pendingAttachments;
    pendingAttachments = [];

    messages = [...messages, { role: 'user', content: optimisticContent, created_at: new Date().toISOString() }];
    sending = true;
    await tick();
    scrollBottom();

    // The streaming SDK path only handles plain text — when the episode is
    // claude_code AND there are no attachments, we get the rich live tool
    // trace. Otherwise (other provider, or images/docs) fall back to the
    // synchronous POST so attachments still work.
    const providerSlug = (selectedEp?.llm_provider || '').toLowerCase();
    const canStream = (providerSlug === 'claude_code' || providerSlug === 'claude-code')
      && images.length === 0 && documents.length === 0;

    try {
      if (canStream) {
        await runStreamingSend(selectedEpisodeId, msg);
      } else {
        const body: Record<string, unknown> = { episode_id: selectedEpisodeId, message: msg };
        if (images.length) body.images = images;
        if (documents.length) body.documents = documents;
        const data = await sendChatMessage(body) as any;
        if (data.message) {
          messages = [...messages, { role: 'assistant', content: data.message.content, created_at: new Date().toISOString() }];
        } else if (data.error) {
          appendError('Error: ' + data.error);
        }
      }
    } catch (e: any) {
      messages = [...messages, { role: 'assistant', content: 'Connection error: ' + e.message, created_at: new Date().toISOString() }];
      // restore attachments so user can retry
      pendingAttachments = sentAttachments;
    } finally {
      sending = false;
      streamingActive = false;
      streamingBlocks = [];
      streamAbort = null;
      await tick();
      scrollBottom();
      loadEpisodes();
    }
  }

  async function runStreamingSend(episodeId: string, msg: string) {
    streamingActive = true;
    streamingBlocks = [];
    streamAbort = new AbortController();
    try {
      const stream = sendChatMessageStream(
        { episode_id: episodeId, message: msg },
        streamAbort.signal,
      );
      for await (const ev of stream) {
        await handleStreamEvent(ev);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') throw e;
    }
  }

  async function handleStreamEvent(ev: ChatStreamEvent) {
    if (ev.type === 'assistant_text') {
      // Merge consecutive text into the last text block.
      const last = streamingBlocks[streamingBlocks.length - 1];
      if (last && last.type === 'text') {
        last.text += ev.text;
        streamingBlocks = [...streamingBlocks];
      } else {
        streamingBlocks = [...streamingBlocks, { type: 'text', text: ev.text }];
      }
    } else if (ev.type === 'tool_use') {
      streamingBlocks = [...streamingBlocks, {
        type: 'tool_use',
        id: ev.id,
        name: ev.name,
        input: ev.input,
      }];
    } else if (ev.type === 'tool_result') {
      streamingBlocks = streamingBlocks.map(b =>
        b.type === 'tool_use' && b.id === ev.tool_use_id
          ? { ...b, result: ev.content, is_error: ev.is_error }
          : b,
      );
    } else if (ev.type === 'permission_request') {
      pendingPermission = {
        request_id: ev.request_id,
        tool_name: ev.tool_name,
        input: ev.input,
      };
    } else if (ev.type === 'done') {
      // Replace the live stream with the persisted assistant message so its
      // content_blocks render the same on reload. Pass the rich blocks
      // through `content_blocks` so the rendering path picks them up.
      const blocks = streamingBlocks.map(b => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        return {
          type: 'tool_use',
          id: b.id,
          name: b.name,
          input: b.input,
          _result: b.result,
          _is_error: b.is_error,
        };
      });
      messages = [...messages, {
        role: 'assistant',
        content: ev.final_text,
        content_blocks: JSON.stringify(blocks),
        created_at: new Date().toISOString(),
      }];
      streamingBlocks = [];
      streamingActive = false;
    } else if (ev.type === 'error') {
      appendError('Error: ' + ev.message);
      streamingBlocks = [];
      streamingActive = false;
    }
    await tick();
    scrollBottom();
  }

  async function approvePermission(allow: boolean) {
    if (!pendingPermission) return;
    const p = pendingPermission;
    pendingPermission = null;
    try {
      await respondChatPermission(p.request_id, allow ? 'allow' : 'deny');
    } catch (e: any) {
      console.error('permission respond failed', e);
    }
  }

  /** Render a parsed content_blocks array for a persisted assistant message. */
  function parseContentBlocks(raw: string | undefined): any[] {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

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

  /** Parse stored user message that may contain attachment refs. */
  function parseStoredMessage(raw: string): { text: string; images: string[]; documents: Array<{ filename?: string; path?: string }>; local: boolean } {
    if (!raw || !raw.startsWith('{')) return { text: raw, images: [], documents: [], local: false };
    try {
      const p = JSON.parse(raw);
      if (typeof p !== 'object' || p === null) return { text: raw, images: [], documents: [], local: false };
      const images: string[] = Array.isArray(p.images) ? p.images : [];
      const docs: Array<{ filename?: string; path?: string }> = Array.isArray(p.documents)
        ? p.documents.map((d: any) => typeof d === 'string' ? { path: d } : { filename: d?.filename, path: d?.path })
        : [];
      return { text: typeof p.text === 'string' ? p.text : '', images, documents: docs, local: !!p._local };
    } catch {
      return { text: raw, images: [], documents: [], local: false };
    }
  }

  function imageSrc(ref: string, local: boolean): string {
    // Local echoes already hold a data: URL preview. Persisted refs are relative paths served by /api/chat/images.
    if (local || ref.startsWith('data:') || ref.startsWith('http')) return ref;
    return '/api/chat/images?path=' + encodeURIComponent(ref);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  }

  function autoResize(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }

  function providerIcon(p: string | undefined): string {
    if (!p) return 'M';
    const map: Record<string, string> = { anthropic: 'A', openai: 'O', lmstudio: 'L', ollama: 'O' };
    return map[p.toLowerCase()] || p[0]?.toUpperCase() || 'M';
  }

  function providerColor(p: string | undefined): string {
    if (!p) return 'var(--gold)';
    const map: Record<string, string> = {
      anthropic: '#D4A84B', claude: '#D4A84B', 'claude-code': '#D4A84B',
      openai: '#3DD68C', lmstudio: '#8B7CF6', ollama: '#5B9BF7',
      grok: '#E0E0E0', nvidia: '#76B900',
    };
    return map[p.toLowerCase()] || 'var(--gold)';
  }

  // ── Provider + model picker (custom dropdown with search) ──────────
  type LlmProviderStatus = {
    slug: string;
    name: string;
    ready: boolean;
    error?: string;
    exhausted?: boolean;
    lastModel?: string;
    capabilities?: { contextWindow?: number; tools?: boolean; vision?: boolean; thinking?: boolean };
  };
  type ProviderWithModels = LlmProviderStatus & { models: string[] };

  let availableProviders: ProviderWithModels[] = [];
  let providerSwitching = false;
  let providerError = '';
  let provMenuOpen = false;
  let provMenuTrigger: HTMLButtonElement | null = null;
  let provSearch = '';
  let provSearchInput: HTMLInputElement | null = null;
  // Menu position is computed from the trigger's bounding rect because
  // .cx-main has overflow:hidden — using `position: absolute` would clip
  // the dropdown. With `position: fixed` we escape the parent's clipping.
  let provMenuPos = { top: 0, left: 0 };

  function positionProvMenu() {
    if (!provMenuTrigger) return;
    const rect = provMenuTrigger.getBoundingClientRect();
    provMenuPos = { top: rect.bottom + 8, left: rect.left };
  }

  async function loadAvailableProviders() {
    try {
      const r = await fetch('/api/llm-providers');
      if (!r.ok) return;
      const body = await r.json();
      const list = (body.providers ?? []) as LlmProviderStatus[];
      // Discover models per provider in parallel (only for ready ones — offline ones return empty)
      const enriched = await Promise.all(list.map(async (p) => {
        let models: string[] = [];
        if (p.ready) {
          try {
            const mr = await fetch(`/api/llm-providers/${encodeURIComponent(p.slug)}/models`);
            if (mr.ok) {
              const mb = await mr.json();
              models = modelIds(mb.models);
            }
          } catch { /* ignore */ }
        }
        return { ...p, models } as ProviderWithModels;
      }));
      availableProviders = enriched;
    } catch { /* keep silent — selector just won't populate */ }
  }

  // Only close on OUTER page scrolls — scrolling inside the menu's own scroll
  // area is what the user wants. Without this filter, capture:true catches
  // every scroll event including the menu's internal one and closes prematurely.
  function onOuterScroll(e: Event) {
    const t = e.target as Node | null;
    if (t instanceof Element && t.closest('.cx-prov-menu')) return;
    closeProvMenu();
  }
  function onOuterResize() { closeProvMenu(); }

  function toggleProvMenu() {
    if (provMenuOpen) { closeProvMenu(); return; }
    provSearch = '';
    positionProvMenu();
    provMenuOpen = true;
    void loadAvailableProviders();
    setTimeout(() => provSearchInput?.focus(), 30);
    // Use capture so we see scrolls before the inner handler — but bail out
    // when the scroll target is the menu itself (handled in onOuterScroll).
    window.addEventListener('scroll', onOuterScroll, { capture: true, passive: true });
    window.addEventListener('resize', onOuterResize);
  }
  function closeProvMenu() {
    if (!provMenuOpen) return;
    provMenuOpen = false;
    provSearch = '';
    window.removeEventListener('scroll', onOuterScroll, { capture: true } as EventListenerOptions);
    window.removeEventListener('resize', onOuterResize);
  }
  function onProvMenuKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { closeProvMenu(); provMenuTrigger?.focus(); }
  }

  async function pickModel(slug: string, model: string) {
    if (!selectedEp || !slug) return;
    if (slug === selectedEp.llm_provider && (model || '') === (selectedEp.llm_model || '')) {
      provMenuOpen = false;
      return;
    }
    providerSwitching = true;
    providerError = '';
    try {
      const r = await fetch('/api/chat/episode/provider', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episode_id: selectedEp.id, provider: slug, model }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      const idx = episodes.findIndex(e => e.id === body.id);
      if (idx >= 0) {
        episodes[idx] = body;
        episodes = episodes;
      }
      provMenuOpen = false;
    } catch (err) {
      providerError = (err as Error).message;
      setTimeout(() => (providerError = ''), 4000);
    } finally {
      providerSwitching = false;
    }
  }

  function fmtCtx(n?: number): string {
    if (!n || n <= 0) return '';
    if (n >= 1000) return `${Math.round(n / 1000)}k ctx`;
    return `${n} ctx`;
  }

  $: currentProvider = availableProviders.find(p => p.slug === selectedEp?.llm_provider) ?? null;

  // Filter by search; keep providers in order, but only show models matching the query.
  // Also include "(default)" virtual entry so users can let the provider pick.
  $: filteredGroups = (() => {
    const q = provSearch.trim().toLowerCase();
    return availableProviders
      .map(p => {
        const items: Array<{ model: string; label: string }> = [];
        items.push({ model: '', label: '(provider default)' });
        for (const m of p.models) items.push({ model: m, label: m });
        const filtered = q
          ? items.filter(it => it.label.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
          : items;
        return { provider: p, items: filtered };
      })
      .filter(g => g.items.length > 0);
  })();

  function isDateBreak(msgs: any[], idx: number): boolean {
    if (idx === 0) return true;
    const prev = new Date(msgs[idx - 1].created_at).toDateString();
    const curr = new Date(msgs[idx].created_at).toDateString();
    return prev !== curr;
  }

  function formatDateBreak(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }
</script>

<div class="cx" class:sidebar-collapsed={sidebarCollapsed}>
  <!-- Sidebar -->
  <aside class="cx-side">
    <div class="cx-side-head">
      <div class="cx-side-brand">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="cx-side-icon">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span>Conversations</span>
      </div>
      <button class="cx-new" on:click={newEpisode} title="New conversation">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
          <path d="M12 5v14M5 12h14"/>
        </svg>
      </button>
    </div>

    <!-- Search -->
    <div class="cx-search-wrap">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cx-search-icon">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
      <input
        class="cx-search"
        type="text"
        bind:value={searchQuery}
        placeholder="Search chats..."
      />
    </div>

    <!-- Episode list -->
    <div class="cx-list">
      {#each filteredEpisodes as ep, i (ep.id)}
        <div
          class="cx-ep"
          class:active={ep.id === selectedEpisodeId}
          class:cx-ep-confirming={deleteConfirmId === ep.id}
          role="button"
          tabindex="0"
          on:click={() => selectEpisode(ep.id)}
          on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectEpisode(ep.id); } }}
          style="animation-delay: {i * 30}ms"
        >
          <div class="cx-ep-avatar" style="color: {providerColor(ep.llm_provider)}">
            {providerIcon(ep.llm_provider)}
          </div>
          <div class="cx-ep-body">
            <div class="cx-ep-title">{ep.title || 'New conversation'}</div>
            <div class="cx-ep-sub">
              <span class="cx-ep-count">{ep.message_count}</span>
              <span class="cx-ep-time">{timeAgo(ep.updated_at)}</span>
            </div>
          </div>

          {#if deleteConfirmId === ep.id}
            <!-- Confirmation pair -->
            <div class="cx-ep-actions cx-ep-actions-confirm">
              <button
                class="cx-ep-act cx-ep-act-confirm"
                title="Confirm delete"
                aria-label="Confirm delete"
                disabled={deletingEpisodeId === ep.id}
                on:click={(e) => confirmDelete(ep.id, e)}
              >
                {#if deletingEpisodeId === ep.id}
                  <svg viewBox="0 0 24 24" width="14" height="14" class="cx-ep-spin"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="14 28" stroke-linecap="round"/></svg>
                {:else}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="14" height="14" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
                {/if}
              </button>
              <button
                class="cx-ep-act cx-ep-act-cancel"
                title="Cancel"
                aria-label="Cancel delete"
                on:click={cancelDelete}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="14" height="14" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          {:else}
            <!-- Default: live dot + trash on hover -->
            <div class="cx-ep-actions">
              {#if ep.status !== 'archived'}
                <div class="cx-ep-live"></div>
              {/if}
              <button
                class="cx-ep-act cx-ep-act-trash"
                title="Delete conversation"
                aria-label="Delete conversation"
                on:click={(e) => askDelete(ep.id, e)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14" aria-hidden="true">
                  <path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                </svg>
              </button>
            </div>
          {/if}
        </div>
      {/each}

      {#if !filteredEpisodes.length}
        <div class="cx-list-empty">
          {#if searchQuery}
            <span>No matches</span>
          {:else}
            <span>No conversations yet</span>
            <button class="cx-list-empty-btn" on:click={newEpisode}>Start one</button>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Sidebar toggle -->
    <button class="cx-collapse" on:click={() => sidebarCollapsed = !sidebarCollapsed} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
        {#if sidebarCollapsed}
          <path d="m9 18 6-6-6-6"/>
        {:else}
          <path d="m15 18-6-6 6-6"/>
        {/if}
      </svg>
    </button>
  </aside>

  <!-- Main chat area -->
  <main class="cx-main">
    <!-- Header bar -->
    <header class="cx-head">
      <div class="cx-head-left">
        {#if sidebarCollapsed}
          <button class="cx-head-menu" on:click={() => sidebarCollapsed = false}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <path d="M3 12h18M3 6h18M3 18h18"/>
            </svg>
          </button>
        {/if}
        <div class="cx-head-info">
          <h1 class="cx-head-title">{selectedEp?.title || 'Select a conversation'}</h1>
          {#if selectedEp}
            <div class="cx-head-meta">
              <div class="cx-prov-wrap">
                <button
                  class="cx-prov-trigger"
                  class:cx-prov-trigger-open={provMenuOpen}
                  style="--badge-c: {providerColor(selectedEp.llm_provider)}"
                  bind:this={provMenuTrigger}
                  on:click={toggleProvMenu}
                  on:keydown={onProvMenuKey}
                  disabled={providerSwitching}
                  title="Switch the LLM that answers this conversation"
                  aria-haspopup="listbox"
                  aria-expanded={provMenuOpen}
                >
                  <span class="cx-prov-dot"></span>
                  <span class="cx-prov-name">{currentProvider?.name ?? selectedEp.llm_provider ?? 'default'}</span>
                  {#if selectedEp.llm_model}
                    <span class="cx-prov-model" title="Active model">{selectedEp.llm_model}</span>
                  {/if}
                  <svg class="cx-prov-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="11" height="11" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
                </button>

              </div>
              {#if providerError}
                <span class="cx-badge cx-badge-warn" title={providerError}>switch failed</span>
              {/if}
              {#if piiStatus}
                <span class="cx-badge" class:cx-badge-safe={piiStatus.enabled} class:cx-badge-warn={!piiStatus.enabled}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10">
                    {#if piiStatus.enabled}
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    {:else}
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m4 4 16 16"/>
                    {/if}
                  </svg>
                  PII {piiStatus.enabled ? 'protected' : 'exposed'}
                </span>
              {/if}
              <span class="cx-badge">{messages.length} messages</span>
            </div>
          {/if}
        </div>
      </div>
    </header>

    <!-- Messages area -->
    <div bind:this={msgArea} class="cx-messages">
      {#if loading}
        <div class="cx-loader">
          <div class="cx-loader-bar"></div>
          <span>Loading messages...</span>
        </div>
      {:else if !selectedEpisodeId}
        <div class="cx-empty">
          <div class="cx-empty-glyph">
            <svg viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="1.2">
              <rect x="8" y="8" width="64" height="48" rx="8" stroke-dasharray="4 3" opacity="0.3"/>
              <circle cx="28" cy="32" r="3" fill="var(--gold)" stroke="none" opacity="0.6"/>
              <circle cx="40" cy="32" r="3" fill="var(--gold)" stroke="none" opacity="0.4"/>
              <circle cx="52" cy="32" r="3" fill="var(--gold)" stroke="none" opacity="0.2"/>
              <path d="M24 64l-8 12V56" stroke="var(--text-3)" opacity="0.3"/>
            </svg>
          </div>
          <h2 class="cx-empty-title">Start a conversation</h2>
          <p class="cx-empty-desc">Select a chat from the sidebar or create a new one to begin.</p>
          <button class="cx-empty-action" on:click={newEpisode}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            New conversation
          </button>
        </div>
      {:else if !messages.length}
        <div class="cx-empty">
          <div class="cx-empty-glyph">
            <svg viewBox="0 0 80 80" fill="none">
              <path d="M20 25C20 20.5817 23.5817 17 28 17H52C56.4183 17 60 20.5817 60 25V45C60 49.4183 56.4183 53 52 53H34L22 63V53H20C20 53 20 49.4183 20 45V25Z" stroke="var(--gold)" stroke-width="1.5" opacity="0.5"/>
              <path d="M32 33H48" stroke="var(--text-3)" stroke-width="1.5" stroke-linecap="round" opacity="0.3"/>
              <path d="M32 39H44" stroke="var(--text-3)" stroke-width="1.5" stroke-linecap="round" opacity="0.2"/>
            </svg>
          </div>
          <h2 class="cx-empty-title">Ready to chat</h2>
          <p class="cx-empty-desc">Type your first message below. Shift+Enter for new lines.</p>
        </div>
      {:else}
        {#each messages as m, i (m.created_at + m.role + i)}
          <!-- Date separator -->
          {#if isDateBreak(messages, i)}
            <div class="cx-date-break">
              <span>{formatDateBreak(m.created_at)}</span>
            </div>
          {/if}

          <div class="cx-msg cx-msg-{m.role}" style="animation-delay: {Math.min(i * 20, 300)}ms">
            <!-- Avatar -->
            <div class="cx-msg-avatar" class:cx-msg-avatar-user={m.role === 'user'} class:cx-msg-avatar-ai={m.role === 'assistant'}>
              {#if m.role === 'user'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
              {:else}
                <span style="font-size: 11px; font-weight: 700; color: {providerColor(selectedEp?.llm_provider)}">{providerIcon(selectedEp?.llm_provider)}</span>
              {/if}
            </div>

            <!-- Content -->
            <div class="cx-msg-body">
              <div class="cx-msg-role">
                {m.role === 'user' ? 'You' : (selectedEp?.llm_provider || 'Assistant')}
                <span class="cx-msg-ts">{fmtTime(m.created_at)}</span>
              </div>
              {#if m.role === 'user'}
                {@const parsed = parseStoredMessage(m.content)}
                {#if parsed.images.length || parsed.documents.length}
                  <div class="cx-attachments">
                    {#each parsed.images as ref}
                      <a class="cx-attach cx-attach-img" href={imageSrc(ref, parsed.local)} target="_blank" rel="noopener">
                        <img src={imageSrc(ref, parsed.local)} alt="attachment" />
                      </a>
                    {/each}
                    {#each parsed.documents as doc}
                      <a class="cx-attach cx-attach-doc"
                         href={doc.path ? imageSrc(doc.path, parsed.local) : '#'}
                         target="_blank" rel="noopener" title={doc.filename ?? 'PDF'}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="18" height="18">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                        </svg>
                        <span>{doc.filename ?? 'document.pdf'}</span>
                      </a>
                    {/each}
                  </div>
                {/if}
                {#if parsed.text}
                  <div class="cx-msg-content">{@html formatMd(parsed.text)}</div>
                {/if}
              {:else}
                {@const blocks = parseContentBlocks(m.content_blocks)}
                {#if blocks.length > 0}
                  <div class="cx-msg-content">
                    {#each blocks as b}
                      {#if b.type === 'text'}
                        {@html formatMd(b.text || '')}
                      {:else if b.type === 'tool_use'}
                        <ToolCard name={b.name} input={b.input} result={b._result} isError={!!b._is_error} />
                      {/if}
                    {/each}
                  </div>
                {:else if msgAuthError(m)}
                  <!-- The CLI's wording says to run /login, a command that does
                       not exist in this chat. Say what actually works here. -->
                  <div class="cx-msg-content">
                    Claude Code has no active session, so this agent can't answer.
                    Sign in once and it will work from the next message.
                  </div>
                {:else}
                  <div class="cx-msg-content">{@html formatMd(m.content)}</div>
                {/if}
                {#if msgAuthError(m)}
                  <button class="cx-fix-auth" on:click={() => (ccAuthOpen = true)}>
                    Sign in to Claude Code
                  </button>
                {/if}
              {/if}
            </div>
          </div>
        {/each}

        <!-- Live streaming bubble — shows text deltas + tool cards as the SDK fires them -->
        {#if streamingActive && streamingBlocks.length > 0}
          <div class="cx-msg cx-msg-assistant">
            <div class="cx-msg-avatar cx-msg-avatar-ai">
              <span style="font-size: 11px; font-weight: 700; color: {providerColor(selectedEp?.llm_provider)}">{providerIcon(selectedEp?.llm_provider)}</span>
            </div>
            <div class="cx-msg-body">
              <div class="cx-msg-role">{selectedEp?.llm_provider || 'Assistant'} <span class="cx-msg-ts">live</span></div>
              <div class="cx-msg-content">
                {#each streamingBlocks as b}
                  {#if b.type === 'text'}
                    {@html formatMd(b.text)}
                  {:else}
                    <ToolCard name={b.name} input={b.input} result={b.result} isError={!!b.is_error} />
                  {/if}
                {/each}
              </div>
              {#if streamAuthError(streamingBlocks)}
                <button class="cx-fix-auth" on:click={() => (ccAuthOpen = true)}>
                  Sign in to Claude Code
                </button>
              {/if}
            </div>
          </div>
        {/if}

        <!-- Thinking indicator — shown when send is in-flight but no stream blocks yet -->
        {#if sending && (!streamingActive || streamingBlocks.length === 0)}
          <div class="cx-msg cx-msg-assistant cx-thinking">
            <div class="cx-msg-avatar cx-msg-avatar-ai">
              <span style="font-size: 11px; font-weight: 700; color: {providerColor(selectedEp?.llm_provider)}">{providerIcon(selectedEp?.llm_provider)}</span>
            </div>
            <div class="cx-msg-body">
              <div class="cx-msg-role">{selectedEp?.llm_provider || 'Assistant'}</div>
              <div class="cx-thinking-dots">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        {/if}

        <!-- Scroll anchor -->
        <div class="cx-scroll-anchor"></div>
      {/if}
    </div>

    <!-- Input area -->
    {#if selectedEpisodeId}
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
            <button class="cx-send" on:click={doSend} disabled={sending || (!input.trim() && pendingAttachments.length === 0)}>
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
    {/if}
  </main>
</div>

<!-- Tool permission modal — fires when the SDK's canUseTool hook asks
     us before running a tool. One prompt at a time; the kernel parks the
     SDK call until we POST allow/deny back. -->
{#if pendingPermission}
  <div class="cx-perm-scrim" role="presentation"></div>
  <div class="cx-perm-modal" role="dialog" aria-modal="true">
    <div class="cx-perm-head">
      <span class="cx-perm-title">Tool permission</span>
      <span class="cx-perm-tool">{pendingPermission.tool_name}</span>
    </div>
    <div class="cx-perm-body">
      <div class="cx-perm-label">Input</div>
      <pre class="cx-perm-input">{formatToolInput(pendingPermission.input)}</pre>
    </div>
    <div class="cx-perm-actions">
      <button class="cx-perm-deny" on:click={() => approvePermission(false)}>Deny</button>
      <button class="cx-perm-allow" on:click={() => approvePermission(true)}>Allow</button>
    </div>
  </div>
{/if}

<!-- LLM picker menu — rendered at root level so it escapes nested
     stacking contexts (.cx-head/.cx-input-area each create their own,
     and z-index inside them can't beat z-index outside). With the menu
     here, its z-index competes against the document root only. -->
{#if provMenuOpen && selectedEp}
  <div class="cx-prov-scrim" on:click={closeProvMenu} role="presentation"></div>
  <div
    class="cx-prov-menu"
    role="listbox"
    tabindex="-1"
    on:keydown={onProvMenuKey}
    style="top: {provMenuPos.top}px; left: {provMenuPos.left}px;"
  >
    <div class="cx-prov-menu-head">
      <span>Provider + model</span>
      <input
        type="text"
        class="cx-prov-search"
        placeholder="Search models…"
        bind:value={provSearch}
        bind:this={provSearchInput}
      />
    </div>
    {#if availableProviders.length === 0}
      <div class="cx-prov-empty">Loading providers…</div>
    {:else if filteredGroups.length === 0}
      <div class="cx-prov-empty">No models match “{provSearch}”</div>
    {:else}
      <div class="cx-prov-scroll">
        {#each filteredGroups as g (g.provider.slug)}
          <div
            class="cx-prov-group"
            class:cx-prov-group-disabled={!g.provider.ready}
            style="--row-c: {providerColor(g.provider.slug)}"
          >
            <div class="cx-prov-group-head">
              <span class="cx-prov-group-dot"></span>
              <span class="cx-prov-group-name">{g.provider.name}</span>
              <span class="cx-prov-group-meta">
                {#if !g.provider.ready}
                  <span class="cx-prov-status cx-prov-status-off" title={g.provider.error ?? 'Not configured'}>offline</span>
                {:else if g.provider.exhausted}
                  <span class="cx-prov-status cx-prov-status-quota" title="Quota exhausted">quota</span>
                {:else}
                  <span class="cx-prov-group-count">{g.provider.models.length} {g.provider.models.length === 1 ? 'model' : 'models'}</span>
                {/if}
                {#if g.provider.capabilities?.contextWindow}
                  <span class="cx-prov-sep">·</span>
                  <span class="cx-prov-group-ctx">{fmtCtx(g.provider.capabilities.contextWindow)}</span>
                {/if}
              </span>
            </div>
            <div class="cx-prov-group-list">
              {#each g.items as it (g.provider.slug + '::' + it.model)}
                {@const isCurrent = g.provider.slug === selectedEp.llm_provider && (it.model || '') === (selectedEp.llm_model || '')}
                {@const isDefault = it.model === ''}
                <button
                  type="button"
                  class="cx-prov-row"
                  class:cx-prov-row-current={isCurrent}
                  class:cx-prov-row-default={isDefault}
                  on:click={() => pickModel(g.provider.slug, it.model)}
                  disabled={!g.provider.ready || providerSwitching}
                  role="option"
                  aria-selected={isCurrent}
                >
                  <span class="cx-prov-row-name">{it.label}</span>
                  {#if isCurrent}
                    <svg class="cx-prov-row-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="11" height="11" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
    <div class="cx-prov-menu-foot">
      <a href="/extensions" class="cx-prov-foot-link">Configure providers →</a>
    </div>
  </div>
{/if}


<ClaudeCodeAuthModal open={ccAuthOpen} on:close={() => (ccAuthOpen = false)} />

<style>
  /* ── Chat Container ─────────────────────────────────────── */
  .cx {
    display: flex;
    flex: 1;
    min-height: 0;
    height: 100%;
    background: var(--bg);
    position: relative;
    overflow: hidden;
  }

  /* ── Sidebar ──────────────────────────────────────────────── */
  .cx-side {
    width: 280px;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    background: var(--surface-1);
    border-right: 1px solid var(--border);
    transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s;
    position: relative;
    z-index: 2;
  }

  .sidebar-collapsed .cx-side {
    width: 0;
    border-right: none;
    overflow: hidden;
    opacity: 0;
  }

  .cx-side-head {
    padding: 16px 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: linear-gradient(180deg, var(--surface-2) 0%, var(--surface-1) 100%);
  }

  .cx-side-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
    color: var(--text-1);
    letter-spacing: -0.02em;
  }

  .cx-side-icon {
    width: 18px;
    height: 18px;
    color: var(--gold);
  }

  .cx-new {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    transition: all 0.2s;
  }

  .cx-new:hover {
    border-color: var(--gold);
    color: var(--gold);
    background: rgba(212, 168, 75, 0.06);
    transform: scale(1.05);
  }

  /* Search */
  .cx-search-wrap {
    padding: 12px 14px;
    position: relative;
    flex-shrink: 0;
  }

  .cx-search-icon {
    position: absolute;
    left: 24px;
    top: 50%;
    transform: translateY(-50%);
    width: 13px;
    height: 13px;
    color: var(--text-3);
    pointer-events: none;
  }

  .cx-search {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-1);
    font-size: 12px;
    font-family: var(--font-body);
    padding: 7px 10px 7px 30px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .cx-search::placeholder { color: var(--text-3); }
  .cx-search:focus {
    border-color: var(--gold);
    box-shadow: 0 0 0 2px rgba(212, 168, 75, 0.08);
  }

  /* Episode list */
  .cx-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 10px 10px;
  }

  .cx-list::-webkit-scrollbar { width: 3px; }
  .cx-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  .cx-ep {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
    color: var(--text-1);
    font-family: var(--font-body);
    margin-bottom: 2px;
    animation: fadeSlideIn 0.3s ease both;
  }

  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateX(-8px); }
    to { opacity: 1; transform: translateX(0); }
  }

  .cx-ep:hover {
    background: var(--surface-2);
    border-color: var(--border);
  }

  .cx-ep.active {
    background: var(--surface-3);
    border-color: rgba(212, 168, 75, 0.2);
    box-shadow: inset 3px 0 0 var(--gold);
  }

  .cx-ep-avatar {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: var(--surface-3);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 12px;
    flex-shrink: 0;
  }

  .cx-ep-body {
    flex: 1;
    min-width: 0;
  }

  .cx-ep-title {
    font-size: 12.5px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.3;
  }

  .cx-ep-sub {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    font-size: 10.5px;
    color: var(--text-3);
  }

  .cx-ep-count {
    background: var(--surface-3);
    border-radius: 4px;
    padding: 0 4px;
    font-family: var(--font-mono);
    font-size: 9.5px;
  }

  .cx-ep-live {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
    flex-shrink: 0;
    box-shadow: 0 0 6px rgba(61, 214, 140, 0.4);
  }

  /* ── Episode row actions (delete trash + confirm pair) ── */
  .cx-ep-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    margin-left: 4px;
  }
  .cx-ep-act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    padding: 0;
    transition: background 0.12s, color 0.12s, border-color 0.12s, opacity 0.12s;
  }
  .cx-ep-act:disabled { cursor: progress; opacity: 0.6; }
  .cx-ep-act:focus-visible { outline: none; border-color: var(--text-2); }

  /* Trash icon: hidden by default, fades in on row hover (or when row is active) */
  .cx-ep-act-trash { opacity: 0; }
  .cx-ep:hover .cx-ep-act-trash,
  .cx-ep.active .cx-ep-act-trash,
  .cx-ep-act-trash:focus-visible { opacity: 1; }
  .cx-ep-act-trash:hover {
    background: rgba(240, 71, 112, 0.12);
    color: var(--red, #f04770);
    border-color: rgba(240, 71, 112, 0.3);
  }

  /* Confirm row: green check + red X, always visible while confirming */
  .cx-ep-confirming { background: rgba(240, 71, 112, 0.06); }
  .cx-ep-actions-confirm { gap: 4px; }
  .cx-ep-act-confirm {
    color: var(--red, #f04770);
    background: rgba(240, 71, 112, 0.1);
    border-color: rgba(240, 71, 112, 0.25);
  }
  .cx-ep-act-confirm:hover:not(:disabled) {
    background: rgba(240, 71, 112, 0.22);
    color: var(--red, #f04770);
  }
  .cx-ep-act-cancel {
    color: var(--text-2);
    background: rgba(255, 255, 255, 0.04);
    border-color: var(--border);
  }
  .cx-ep-act-cancel:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text-1);
  }
  .cx-ep-spin { animation: cx-ep-spin 0.7s linear infinite; }
  @keyframes cx-ep-spin { to { transform: rotate(360deg); } }


  .cx-list-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 32px 16px;
    color: var(--text-3);
    font-size: 12px;
  }

  .cx-list-empty-btn {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--gold);
    font-size: 11px;
    padding: 4px 12px;
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .cx-list-empty-btn:hover { border-color: var(--gold); }

  /* Collapse toggle */
  .cx-collapse {
    position: absolute;
    right: -12px;
    top: 50%;
    transform: translateY(-50%);
    width: 24px;
    height: 48px;
    border-radius: 0 8px 8px 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-left: none;
    color: var(--text-3);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3;
    transition: color 0.15s, background 0.15s;
    opacity: 0;
  }

  .cx-side:hover .cx-collapse,
  .sidebar-collapsed .cx-collapse { opacity: 1; }

  .sidebar-collapsed .cx-collapse {
    position: fixed;
    left: calc(var(--sidebar-w) + 0px);
    right: auto;
    border-radius: 0 8px 8px 0;
    border-left: 1px solid var(--border);
  }

  .cx-collapse:hover {
    color: var(--gold);
    background: var(--surface-3);
  }

  /* ── Main Chat Area ──────────────────────────────────────── */
  .cx-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    background: var(--bg);
    position: relative;
  }

  /* Subtle noise texture */
  .cx-main::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at 50% 0%, rgba(212, 168, 75, 0.015) 0%, transparent 60%);
    pointer-events: none;
    z-index: 0;
  }

  /* Header */
  .cx-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--surface-1);
    position: relative;
    z-index: 1;
  }

  .cx-head-left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .cx-head-menu {
    background: transparent;
    border: none;
    color: var(--text-2);
    cursor: pointer;
    padding: 4px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s;
  }

  .cx-head-menu:hover { background: var(--surface-2); }

  .cx-head-info { min-width: 0; }

  .cx-head-title {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin: 0;
  }

  .cx-head-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
  }

  .cx-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 9.5px;
    font-family: var(--font-mono);
    background: var(--surface-3);
    border-radius: 5px;
    padding: 2px 7px;
    color: var(--text-3);
    letter-spacing: 0.02em;
  }

  .cx-badge-provider {
    color: var(--badge-c, var(--gold));
    background: color-mix(in srgb, var(--badge-c, var(--gold)) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--badge-c, var(--gold)) 15%, transparent);
  }

  .cx-badge-safe {
    color: var(--green);
    background: rgba(61, 214, 140, 0.08);
    border: 1px solid rgba(61, 214, 140, 0.15);
  }

  .cx-badge-warn {
    color: var(--red);
    background: rgba(240, 71, 112, 0.08);
    border: 1px solid rgba(240, 71, 112, 0.15);
  }

  /* ── Provider picker ────────────────────────────────────────
     Trigger is a pill that mimics cx-badge-provider; the menu
     is a custom dropdown with rows showing brand color, status,
     and last model. */
  .cx-prov-wrap { position: relative; }

  .cx-prov-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 4px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    text-transform: lowercase;
    color: var(--badge-c, var(--gold));
    background: color-mix(in srgb, var(--badge-c, var(--gold)) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--badge-c, var(--gold)) 22%, transparent);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
    font-family: inherit;
    line-height: 1.4;
  }
  .cx-prov-trigger:hover {
    background: color-mix(in srgb, var(--badge-c, var(--gold)) 16%, transparent);
    border-color: color-mix(in srgb, var(--badge-c, var(--gold)) 35%, transparent);
  }
  .cx-prov-trigger:disabled { cursor: progress; opacity: 0.7; }
  .cx-prov-trigger-open {
    background: color-mix(in srgb, var(--badge-c, var(--gold)) 18%, transparent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--badge-c, var(--gold)) 25%, transparent);
  }
  .cx-prov-trigger-open .cx-prov-chev { transform: rotate(180deg); }

  .cx-prov-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--badge-c, var(--gold));
    box-shadow: 0 0 8px color-mix(in srgb, var(--badge-c, var(--gold)) 70%, transparent);
    flex-shrink: 0;
  }
  .cx-prov-name { font-weight: 600; letter-spacing: 0.01em; }
  .cx-prov-model {
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    color: color-mix(in srgb, var(--text-1) 60%, transparent);
    padding: 1px 6px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--badge-c, var(--gold)) 10%, transparent);
    text-transform: none;
    letter-spacing: 0;
  }
  .cx-prov-chev {
    opacity: 0.7;
    flex-shrink: 0;
    transition: transform 0.18s ease;
  }

  .cx-prov-scrim {
    position: fixed;
    inset: 0;
    background: transparent;
    z-index: 99;
  }
  .cx-prov-menu {
    /* `fixed` instead of `absolute` because the chat layout (.cx-main) uses
       overflow:hidden and would clip an absolutely-positioned child. We
       compute top/left from the trigger's bounding rect at open time. */
    position: fixed;
    z-index: 1000;
    min-width: 360px;
    max-width: 440px;
    background: var(--surface-1, #14181f);
    border: 1px solid var(--border-1, rgba(255, 255, 255, 0.08));
    border-radius: 10px;
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.45),
      0 4px 12px rgba(0, 0, 0, 0.3),
      0 0 0 1px rgba(255, 255, 255, 0.02) inset;
    /* Don't clip — the inner .cx-prov-scroll handles its own scroll. Letting
       the menu clip (overflow:hidden) was preventing the inner scrollbar
       from being interacted with on some layouts. */
    overflow: visible;
    display: flex;
    flex-direction: column;
    max-height: min(70vh, 560px);
    animation: cx-prov-menu-in 0.14s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes cx-prov-menu-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  .cx-prov-menu-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 12px 9px 14px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
    border-bottom: 1px solid var(--border-1);
    background: rgba(255, 255, 255, 0.015);
    border-top-left-radius: 10px;
    border-top-right-radius: 10px;
    flex-shrink: 0;
  }
  .cx-prov-search {
    appearance: none;
    background: var(--surface-2, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--border-1);
    border-radius: 6px;
    color: var(--text-1);
    font: inherit;
    font-size: 11px;
    text-transform: none;
    letter-spacing: 0;
    padding: 4px 8px;
    width: 160px;
  }
  .cx-prov-search:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--gold) 50%, transparent);
  }
  .cx-prov-empty {
    padding: 18px 14px;
    color: var(--text-3);
    font-size: 12px;
    text-align: center;
  }

  .cx-prov-scroll {
    flex: 1 1 auto;
    min-height: 0; /* required for flex children to shrink and scroll */
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .cx-prov-scroll::-webkit-scrollbar { width: 10px; }
  .cx-prov-scroll::-webkit-scrollbar-track { background: transparent; }
  .cx-prov-scroll::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--text-3) 35%, transparent);
    border-radius: 10px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }
  .cx-prov-scroll::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--text-3) 60%, transparent);
    background-clip: padding-box;
    border: 2px solid transparent;
  }

  .cx-prov-group + .cx-prov-group {
    border-top: 1px solid color-mix(in srgb, var(--border-1) 60%, transparent);
  }
  .cx-prov-group-disabled { opacity: 0.55; }

  .cx-prov-group-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px 6px;
    background: color-mix(in srgb, var(--row-c, var(--gold)) 6%, transparent);
    position: sticky;
    top: 0;
    z-index: 1;
    backdrop-filter: blur(6px);
  }
  .cx-prov-group-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--row-c, var(--gold));
    box-shadow: 0 0 8px color-mix(in srgb, var(--row-c, var(--gold)) 70%, transparent);
    flex-shrink: 0;
  }
  .cx-prov-group-disabled .cx-prov-group-dot {
    background: var(--text-3);
    box-shadow: none;
  }
  .cx-prov-group-name {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-1);
    letter-spacing: 0.01em;
    flex: 1;
    min-width: 0;
  }
  .cx-prov-group-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: var(--text-3);
  }
  .cx-prov-group-count, .cx-prov-group-ctx {
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    color: var(--text-3);
  }
  .cx-prov-sep { opacity: 0.5; }

  .cx-prov-group-list {
    display: flex;
    flex-direction: column;
    padding: 2px 0 6px;
  }

  .cx-prov-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 6px 14px 6px 28px;
    background: transparent;
    border: 0;
    border-left: 2px solid transparent;
    text-align: left;
    color: var(--text-2);
    font: inherit;
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    cursor: pointer;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }
  .cx-prov-row:hover:not(:disabled) {
    background: color-mix(in srgb, var(--row-c, var(--gold)) 10%, transparent);
    color: var(--text-1);
    border-left-color: var(--row-c, var(--gold));
  }
  .cx-prov-row:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .cx-prov-row-current {
    background: color-mix(in srgb, var(--row-c, var(--gold)) 14%, transparent);
    color: var(--row-c, var(--gold));
    border-left-color: var(--row-c, var(--gold));
    font-weight: 700;
  }
  .cx-prov-row-default {
    color: color-mix(in srgb, var(--text-1) 75%, transparent);
    font-style: italic;
  }
  .cx-prov-row-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .cx-prov-row-check {
    color: var(--row-c, var(--gold));
    flex-shrink: 0;
  }

  .cx-prov-status {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .cx-prov-status-ok {
    color: var(--green, #3DD68C);
    background: color-mix(in srgb, var(--green, #3DD68C) 12%, transparent);
  }
  .cx-prov-status-off {
    color: var(--text-3);
    background: color-mix(in srgb, var(--text-3) 12%, transparent);
  }
  .cx-prov-status-quota {
    color: var(--gold, #D4A84B);
    background: color-mix(in srgb, var(--gold, #D4A84B) 14%, transparent);
  }

  .cx-prov-menu-foot {
    padding: 8px 14px;
    border-top: 1px solid var(--border-1);
    background: rgba(255, 255, 255, 0.015);
    border-bottom-left-radius: 10px;
    border-bottom-right-radius: 10px;
    flex-shrink: 0;
  }
  .cx-prov-foot-link {
    font-size: 11px;
    color: var(--text-3);
    text-decoration: none;
    transition: color 0.12s;
  }
  .cx-prov-foot-link:hover { color: var(--text-1); }


  /* ── Messages Area ───────────────────────────────────────── */
  .cx-messages {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: relative;
    z-index: 1;
    scroll-behavior: smooth;
    overscroll-behavior: contain;
  }

  .cx-messages::-webkit-scrollbar { width: 5px; }
  .cx-messages::-webkit-scrollbar-track { background: transparent; }
  .cx-messages::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 3px;
  }
  .cx-messages::-webkit-scrollbar-thumb:hover { background: var(--border-h); }

  /* Date breaks */
  .cx-date-break {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px 0 8px;
    position: relative;
  }

  .cx-date-break::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 1px;
    background: var(--border);
    opacity: 0.5;
  }

  .cx-date-break span {
    position: relative;
    background: var(--bg);
    padding: 0 14px;
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-3);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  /* Messages */
  .cx-msg {
    display: flex;
    gap: 12px;
    padding: 12px 0;
    animation: msgAppear 0.35s ease both;
    max-width: 85%;
  }

  @keyframes msgAppear {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .cx-msg-user {
    align-self: flex-end;
    flex-direction: row-reverse;
  }

  .cx-msg-assistant {
    align-self: flex-start;
  }

  .cx-msg-avatar {
    width: 30px;
    height: 30px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-top: 2px;
  }

  .cx-msg-avatar-user {
    background: var(--surface-3);
    border: 1px solid var(--border-h);
    color: var(--text-2);
  }

  .cx-msg-avatar-ai {
    background: rgba(212, 168, 75, 0.08);
    border: 1px solid rgba(212, 168, 75, 0.15);
  }

  .cx-msg-body {
    min-width: 0;
    flex: 1;
  }

  .cx-msg-role {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-2);
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .cx-msg-user .cx-msg-role {
    justify-content: flex-end;
  }

  .cx-msg-ts {
    font-weight: 400;
    font-size: 10px;
    color: var(--text-3);
    font-family: var(--font-mono);
  }

  .cx-fix-auth {
    margin-top: 8px; background: var(--teal, #2dd4bf); color: #04211d; border: 0;
    border-radius: 6px; padding: 6px 12px; font-size: 12.5px; font-weight: 650; cursor: pointer;
  }
  .cx-msg-content {
    font-size: 13.5px;
    line-height: 1.65;
    color: var(--text-1);
    word-break: break-word;
  }

  .cx-msg-user .cx-msg-content {
    text-align: right;
  }

  /* Bubble styling for user messages */
  .cx-msg-user .cx-msg-content {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 14px 14px 4px 14px;
    padding: 10px 16px;
  }

  /* AI message content styling */
  .cx-msg-assistant .cx-msg-content {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 14px 14px 14px 4px;
    padding: 10px 16px;
  }

  /* Markdown content styles */
  .cx-msg-content :global(p) { margin: 0 0 6px; }
  .cx-msg-content :global(p:last-child) { margin-bottom: 0; }
  .cx-msg-content :global(strong) { color: var(--text-1); font-weight: 600; }
  .cx-msg-content :global(em) { color: var(--text-2); font-style: italic; }
  .cx-msg-content :global(a) { color: var(--gold); text-decoration: none; border-bottom: 1px solid rgba(212,168,75,0.3); transition: border-color 0.15s; }
  .cx-msg-content :global(a:hover) { border-color: var(--gold); }

  .cx-msg-content :global(.ic) {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--teal);
  }

  .cx-msg-content :global(.cb-wrap) {
    position: relative;
    margin: 10px 0;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--border);
  }

  .cx-msg-content :global(.cb-lang) {
    position: absolute;
    top: 6px;
    right: 8px;
    font-size: 9px;
    font-family: var(--font-mono);
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* ── Reasoning scratchpad (<think> folded by chat-md) ──────────────
     Collapsed by default and deliberately quiet: it sits above the actual
     answer, so anything louder than this competes with the thing the user
     came to read. <details> carries the open/closed state itself — no
     component state, and it survives a re-render mid-stream. */
  .cx-msg-content :global(details.think) {
    margin: 0 0 8px;
    border: 1px solid var(--border);
    border-left: 2px solid var(--purple);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    overflow: hidden;
  }

  .cx-msg-content :global(details.think .think-head) {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 9px;
    cursor: pointer;
    user-select: none;
    font-size: 11px;
    line-height: 1.4;
    transition: background 0.15s;
  }

  /* Both spellings — the default triangle would sit beside our own chevron. */
  .cx-msg-content :global(details.think .think-head::-webkit-details-marker) { display: none; }
  .cx-msg-content :global(details.think .think-head) { list-style: none; }

  .cx-msg-content :global(details.think .think-head:hover) { background: var(--surface-2); }

  .cx-msg-content :global(details.think .think-icon) {
    font-size: 12px;
    opacity: 0.85;
    filter: saturate(0.9);
  }

  .cx-msg-content :global(details.think .think-label) {
    color: var(--purple);
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .cx-msg-content :global(details.think .think-count) {
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  /* Pushed right, rotates to point down when the block is open. */
  .cx-msg-content :global(details.think .think-chevron) {
    margin-left: auto;
    color: var(--text-3);
    font-size: 9px;
    transition: transform 0.18s ease, color 0.15s;
  }
  .cx-msg-content :global(details.think[open] .think-chevron) {
    transform: rotate(90deg);
    color: var(--purple);
  }
  .cx-msg-content :global(details.think .think-head:hover .think-chevron) { color: var(--purple); }

  .cx-msg-content :global(details.think .think-body) {
    padding: 8px 10px 9px;
    border-top: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.65;
    color: var(--text-2);
    white-space: normal;
    /* Long uninterrupted reasoning must not widen the transcript. */
    overflow-wrap: anywhere;
  }

  .cx-msg-content :global(.cb) {
    background: var(--bg);
    padding: 12px 14px;
    overflow-x: auto;
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
  }

  .cx-msg-content :global(.cb code) {
    font-family: var(--font-mono);
    background: none;
    border: none;
    padding: 0;
    color: var(--text-1);
  }

  .cx-msg-content :global(h2),
  .cx-msg-content :global(h3),
  .cx-msg-content :global(h4) {
    font-family: var(--font-display);
    font-weight: 700;
    margin: 8px 0 4px;
    color: var(--text-1);
  }

  .cx-msg-content :global(h2) { font-size: 15px; }
  .cx-msg-content :global(h3) { font-size: 14px; }
  .cx-msg-content :global(h4) { font-size: 13px; color: var(--text-2); }

  .cx-msg-content :global(ul),
  .cx-msg-content :global(ol) {
    padding-left: 18px;
    margin: 4px 0;
  }

  .cx-msg-content :global(li) {
    margin-bottom: 2px;
    line-height: 1.5;
  }

  .cx-msg-content :global(blockquote) {
    border-left: 3px solid var(--gold);
    padding-left: 12px;
    margin: 8px 0;
    color: var(--text-2);
    font-style: italic;
  }

  /* Thinking indicator */
  .cx-thinking {
    animation: msgAppear 0.35s ease both;
  }

  .cx-thinking-dots {
    display: flex;
    gap: 4px;
    padding: 10px 0;
  }

  .cx-thinking-dots span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--gold);
    opacity: 0.4;
    animation: thinkPulse 1.4s ease-in-out infinite;
  }

  .cx-thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
  .cx-thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes thinkPulse {
    0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
    40% { opacity: 0.8; transform: scale(1.1); }
  }

  .cx-scroll-anchor { height: 1px; flex-shrink: 0; }

  /* ── Empty states ────────────────────────────────────────── */
  .cx-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 48px 32px;
    text-align: center;
  }

  .cx-empty-glyph {
    width: 80px;
    height: 80px;
    margin-bottom: 8px;
    opacity: 0.7;
    color: var(--text-3);
  }

  .cx-empty-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 800;
    color: var(--text-1);
    letter-spacing: -0.03em;
    margin: 0;
  }

  .cx-empty-desc {
    font-size: 13px;
    color: var(--text-2);
    max-width: 300px;
    line-height: 1.6;
    margin: 0;
  }

  .cx-empty-action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 1px solid var(--gold);
    border-radius: 8px;
    color: var(--gold);
    font-size: 13px;
    font-weight: 600;
    font-family: var(--font-body);
    padding: 8px 20px;
    cursor: pointer;
    transition: all 0.2s;
    margin-top: 4px;
  }

  .cx-empty-action:hover {
    background: rgba(212, 168, 75, 0.08);
    transform: translateY(-1px);
    box-shadow: 0 4px 16px rgba(212, 168, 75, 0.1);
  }

  /* Loader */
  .cx-loader {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--text-3);
    font-size: 12px;
  }

  .cx-loader-bar {
    width: 120px;
    height: 2px;
    background: var(--surface-3);
    border-radius: 2px;
    overflow: hidden;
    position: relative;
  }

  .cx-loader-bar::after {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    width: 40%;
    background: var(--gold);
    border-radius: 2px;
    animation: loaderSlide 1.2s ease-in-out infinite;
  }

  @keyframes loaderSlide {
    0% { left: -40%; }
    100% { left: 100%; }
  }

  /* ── Input Area ──────────────────────────────────────────── */
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

  /* Attachments inside rendered messages */
  .cx-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }
  .cx-msg-user .cx-attachments { justify-content: flex-end; }

  .cx-attach {
    display: inline-flex;
    align-items: center;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    text-decoration: none;
    overflow: hidden;
    transition: border-color 0.15s;
  }
  .cx-attach:hover { border-color: var(--gold); }
  .cx-attach-img img {
    max-width: 220px;
    max-height: 220px;
    display: block;
  }
  .cx-attach-doc {
    gap: 8px;
    padding: 8px 12px;
    color: var(--text-2);
    font-size: 12px;
    font-family: var(--font-mono);
    max-width: 260px;
  }
  .cx-attach-doc span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

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

  /* ── Permission modal ───────────────────────────────────── */
  .cx-perm-scrim {
    position: fixed; inset: 0; z-index: 998;
    background: rgba(0,0,0,0.55);
    backdrop-filter: blur(2px);
  }
  .cx-perm-modal {
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    z-index: 999;
    width: min(560px, 92vw);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 18px 50px rgba(0,0,0,0.6);
    overflow: hidden;
  }
  .cx-perm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .cx-perm-title { font-weight: 600; color: var(--text-1); }
  .cx-perm-tool {
    background: var(--gold);
    color: #1a1a1a;
    padding: 2px 8px;
    border-radius: 4px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    font-weight: 600;
  }
  .cx-perm-body { padding: 12px 16px; }
  .cx-perm-label {
    font-size: 11px;
    color: var(--text-2);
    text-transform: uppercase;
    letter-spacing: 0.4px;
    margin-bottom: 6px;
  }
  .cx-perm-input {
    margin: 0;
    padding: 10px;
    background: rgba(0,0,0,0.3);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--text-2);
    max-height: 280px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cx-perm-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.02);
  }
  .cx-perm-deny,
  .cx-perm-allow {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-1);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 600;
    font-size: 12px;
  }
  .cx-perm-deny:hover { border-color: #ff8080; color: #ff8080; }
  .cx-perm-allow {
    background: var(--gold);
    color: #1a1a1a;
    border-color: var(--gold);
  }
  .cx-perm-allow:hover { filter: brightness(1.1); }
</style>
