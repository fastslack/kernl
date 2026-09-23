<script lang="ts">
  import { onMount, tick, afterUpdate } from 'svelte';
  import ToolCard from '$lib/components/ToolCard.svelte';
  import {
    msgAuthError, streamAuthError, parseContentBlocks, parseStoredMessage,
    imageSrc, providerIcon, providerColor, isDateBreak, formatDateBreak,
  } from '$lib/chat-view.js';
  import { formatMd } from '$lib/chat-md.js';
  import EpisodeSidebar from './EpisodeSidebar.svelte';
  import ChatModelPicker, { type ProviderWithModels } from './ChatModelPicker.svelte';
  import ChatInputArea, { type PendingAttach } from './ChatInputArea.svelte';
  import PermissionModal, { type PendingPermission } from './PermissionModal.svelte';

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

  import { fmtTime } from '$shared/utils';
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
  let sidebarCollapsed = false;

  // Attachments pending for the next send
  let pendingAttachments: PendingAttach[] = [];

  $: selectedEp = episodes.find(e => e.id === selectedEpisodeId);

  onMount(async () => {
    await loadEpisodes();
    piiStatus = await getPiiStatus().catch(() => null);
    void modelPicker?.loadAvailableProviders();
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

  /** The sidebar has already deleted it on the kernel; this drops it here. */
  async function onEpisodeDeleted(id: string) {
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

  // ── Provider + model picker ──────────────────────────────────────
  // The menu, its catalogue and its keyboard live in ChatModelPicker; the
  // pill that opens it sits in the header, so the state both read is bound
  // back up to here.
  let modelPicker: ChatModelPicker;
  let provMenuOpen = false;
  let provMenuTrigger: HTMLButtonElement | null = null;
  let providerSwitching = false;
  let providerError = '';
  let currentProvider: ProviderWithModels | null = null;

  /**
   * The model an episode answers with is fixed by its first message: every
   * answer above a mid-conversation swap came from a different model, so
   * switching would attribute one model's words to another. `message_count`
   * arrives with the episode list and `messages` fills in async on select —
   * trust whichever already says the chat started, so the pill never flashes
   * unlocked while messages load. The kernel enforces the same rule (409).
   */
  $: modelLocked = !!selectedEp && (((selectedEp.message_count ?? 0) > 0) || messages.length > 0);

  /** The kernel answered a switch with the updated episode. */
  function onModelSwitched(ep: any) {
    const idx = episodes.findIndex(e => e.id === ep.id);
    if (idx >= 0) {
      episodes[idx] = ep;
      episodes = episodes;
    }
  }

  /** A locked chat's pick opened a new episode on the chosen model. */
  async function onModelForked(ep: any) {
    episodes = [ep, ...episodes];
    await selectEpisode(ep.id);
  }
</script>

<div class="cx" class:sidebar-collapsed={sidebarCollapsed}>
  <!-- Sidebar -->
  <EpisodeSidebar
    {episodes}
    {selectedEpisodeId}
    bind:sidebarCollapsed
    onSelect={selectEpisode}
    onNew={newEpisode}
    onDeleted={onEpisodeDeleted}
  />

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
                  class:cx-prov-trigger-locked={modelLocked}
                  style="--badge-c: {providerColor(selectedEp.llm_provider)}"
                  bind:this={provMenuTrigger}
                  on:click={() => modelPicker.toggleProvMenu()}
                  on:keydown={(e) => modelPicker.onProvMenuKey(e)}
                  disabled={providerSwitching}
                  title={modelLocked
                    ? 'This conversation is fixed to this model — open to start a new chat with another one'
                    : 'Pick the LLM that answers this conversation'}
                  aria-haspopup="listbox"
                  aria-expanded={provMenuOpen}
                >
                  <span class="cx-prov-dot"></span>
                  <span class="cx-prov-name">{currentProvider?.name ?? selectedEp.llm_provider ?? 'default'}</span>
                  {#if selectedEp.llm_model}
                    <span class="cx-prov-model" title="Active model">{selectedEp.llm_model}</span>
                  {/if}
                  {#if modelLocked}
                    <svg class="cx-prov-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="11" height="11" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                  {:else}
                    <svg class="cx-prov-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="11" height="11" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
                  {/if}
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
                  <a class="cx-fix-auth" href="/settings?section=ai&card=providers&connect=claude-code">
                    Sign in to Claude Code
                  </a>
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
                <a class="cx-fix-auth" href="/settings?section=ai&card=providers&connect=claude-code">
                  Sign in to Claude Code
                </a>
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
      <ChatInputArea
        bind:input
        bind:pendingAttachments
        bind:inputEl
        {sending}
        onSend={doSend}
      />
    {/if}
  </main>
</div>

<!-- Tool permission modal — fires when the SDK's canUseTool hook asks
     us before running a tool. One prompt at a time; the kernel parks the
     SDK call until we POST allow/deny back. -->
{#if pendingPermission}
  <PermissionModal permission={pendingPermission} onRespond={approvePermission} />
{/if}

<!-- LLM picker menu — rendered at root level so it escapes nested
     stacking contexts (.cx-head/.cx-input-area each create their own,
     and z-index inside them can't beat z-index outside). With the menu
     here, its z-index competes against the document root only. -->
<ChatModelPicker
  bind:this={modelPicker}
  bind:provMenuOpen
  bind:providerSwitching
  bind:providerError
  bind:currentProvider
  {provMenuTrigger}
  {selectedEp}
  {modelLocked}
  onSwitched={onModelSwitched}
  onForked={onModelForked}
/>

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

  /* Locked: the pill still opens the menu (that's the way to a new chat on
     another model) but drops the affordances that promise a switch here —
     the chevron becomes a padlock and the accent goes quiet. */
  .cx-prov-trigger-locked {
    background: color-mix(in srgb, var(--badge-c, var(--gold)) 5%, transparent);
    border-color: color-mix(in srgb, var(--badge-c, var(--gold)) 14%, transparent);
    color: color-mix(in srgb, var(--badge-c, var(--gold)) 78%, var(--text-3));
  }
  .cx-prov-lock {
    opacity: 0.65;
    flex-shrink: 0;
  }

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
    display: inline-block; margin-top: 8px; background: var(--teal, #2dd4bf); color: #04211d; border: 0;
    border-radius: 6px; padding: 6px 12px; font-size: 12.5px; font-weight: 650; cursor: pointer;
    text-decoration: none;
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
  /* Lists — the model answers with them constantly ("here is what I can do:
     …"), so they are a primary reading surface, not an edge case. Custom
     marker instead of the browser bullet: a small dot in the accent colour,
     aligned to the first line of text, with the item hanging off it. */
  .cx-msg-content :global(ul),
  .cx-msg-content :global(ol) {
    margin: 6px 0 8px;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .cx-msg-content :global(li) {
    position: relative;
    padding-left: 16px;
    line-height: 1.5;
  }
  .cx-msg-content :global(li)::before {
    content: "";
    position: absolute;
    left: 4px;
    top: 0.62em;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--gold, #d4a84b);
    opacity: 0.75;
  }
  /* A list that closes a message should not push the following line away. */
  .cx-msg-content :global(ul:last-child),
  .cx-msg-content :global(ol:last-child) { margin-bottom: 0; }
  .cx-msg-content :global(li > p) { margin: 0; }

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
</style>
