<script lang="ts">
  /**
   * Streaming chat modal that replaces the legacy "New Office" form.
   *
   * Creates a fresh chat episode pinned to the claude_code provider, primed
   * with a system instruction that turns Claude into an "office architect"
   * with access to the kernel_agents_* MCP tools. The user describes what
   * they want; Claude asks clarifying questions, then actually creates the
   * flow + CEO agent through tool calls (visible live as tool cards).
   *
   * Reuses the streaming + permission infra from /chat (see
   * dashboard/src/lib/api.ts → sendChatMessageStream + respondChatPermission).
   */
  import { onMount, tick, createEventDispatcher } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import {
    startChatEpisode,
    sendChatMessageStream,
    respondChatPermission,
    type ChatStreamEvent,
  } from '$lib/api.js';

  const dispatch = createEventDispatcher();

  /** Parent passes the TOP AGENT (whoever holds the highest rank) so the
   *  chat title, avatar and instructions reflect whatever the user named
   *  the rank/agent in the Ranks/Agents UI — never a hardcoded persona.
   *  Defaults are intentionally generic so the chat still works if the
   *  parent doesn't supply props. */
  export let topAgentName: string = 'Chief';
  /** Optional system prompt override. When null/empty we use a generic
   *  free-form template that names the top agent but doesn't lock them
   *  into office-creation mode. The kernel seeder writes a full prompt
   *  into the DB agent's row; passing that through here keeps the chat
   *  persona in lockstep with what the agent run-loop would use. */
  export let topAgentSystemPrompt: string = '';
  /** Rank insignia (e.g. ✪✪✪) and color — used by the boot loader so the
   *  spinner pulses in the top agent's identity instead of a generic
   *  gold. Defaults to a single star + warm gold. */
  export let topAgentInsignia: string = '✪';
  export let topAgentColor: string = '#c9a84c';
  /** Rank name rendered as the eyebrow above the agent name. Whatever the
   *  user called the top rank — nothing themed is baked in. Hidden when it's
   *  empty or identical to the agent name (the default seed names the agent
   *  after its rank, so it would otherwise print twice). */
  export let topAgentRankLabel: string = '';

  /** Build the fallback system prompt when the caller doesn't pass one.
   *  Free-form conversation, no auto-greeting, no office-mode lock-in.
   *  Tool names use the `mcp__kernel__` prefix because this chat runs
   *  through the claude_code provider, which exposes kernel tools via
   *  its MCP server. */
  function defaultInstructions(name: string): string {
    return `You are ${name} — the top of the Kernl agent organization. You're talking to the human (the user) in a free-form conversation.

CRITICAL TOOL POLICY:
- For ANY question about agents, flows, runs, schedules, executions, errors, status: use the kernel MCP tools (mcp__kernel__kernel_agents_*). Those are the ONLY source of truth for this system.
- The kernel MCP tools may load DEFERRED. If a mcp__kernel__ tool isn't directly callable yet, FIRST load it with ToolSearch using the select syntax — e.g. ToolSearch({ query: "select:mcp__kernel__kernel_agents_list,mcp__kernel__kernel_agents_flows_list" }) — then call it immediately. If ToolSearch says the kernel server is still connecting, retry the same select once. ToolSearch is ONLY for loading mcp__kernel__ tools; never use it to browse other capabilities.
- You are FORBIDDEN from using: Bash, WebFetch, WebSearch, Glob, Grep, Read, Write, Edit, Task, NotebookEdit, SlashCommand. Do NOT call them — they exist but are off-policy for this conversation. If you think you need one, you don't. Use a kernel MCP tool or answer directly from what you already know.
- If the user is just chatting casually ("hi", "how's it going", "explain X"), answer DIRECTLY in plain text. NO tool calls — the kernel tool list below is exhaustive.

Conversation rules:
- Wait for the user's first message. Do NOT lead with a greeting or assume what they want.
- Be terse. One paragraph max for plain answers. No filler, no recaps, no "Let me check…" preambles.
- Match the user's language (Spanish or English).
- Decisive, professional tone. Respectful peer-to-peer.

Kernel MCP tools you have (use ONE per turn unless explicitly chained):
- mcp__kernel__kernel_agents_list({}) — list agents (filter by flow_id, role, active, etc.).
- mcp__kernel__kernel_agents_flows_list({}) — list flows / offices.
- mcp__kernel__kernel_agents_history({ agent_id, limit?, status? }) — past runs of ONE agent (use to answer "are there errors?" / "what happened today?"; agent_id is required — list agents first if you don't have it).
- mcp__kernel__kernel_agents_status({ run_id }) — step-by-step log of a specific run.
- mcp__kernel__kernel_agents_run({ agent_id, goal? }) — execute an agent manually.
- mcp__kernel__kernel_agents_stats({}) — fleet-wide aggregate stats.
- mcp__kernel__kernel_agents_flows_create({ name, description, color }) → returns flow with UUID.
- mcp__kernel__kernel_agents_create({ name, flow_id (the UUID just returned), role: "manager", allowed_tools: [], max_iterations: 15, show_on_dashboard: true, system_prompt, goal_template }) — NEVER invent a flow_id.
- mcp__kernel__kernel_agents_update({ id, ... }) — edit an agent. Flows have NO update/delete tool — if asked, say it must be done from the dashboard.
- mcp__kernel__kernel_agents_delete({ id }) — delete an agent (confirm with user first).

Destructive op rule: BEFORE deleting, confirm in one short line ("Confirm I should delete X?") and wait for a yes.

Office creation sequence (only when explicitly asked to create an office):
1. flows_create → get UUID.
2. agents_create with that UUID, role: "manager", allowed_tools: [].
3. agents_run with the CEO id.
4. Reply with a one-line summary.`;
  }

  /** Two-letter initials for the avatar — derives from the top agent's name
   *  so renaming the agent updates the bubble. Single-word names fall back
   *  to the first two characters; empty name → '?'. */
  function avatarInitials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  $: avatarText = avatarInitials(topAgentName);
  $: chatTitle = topAgentName;
  $: episodeTitle = `${topAgentName} (chat)`;
  $: chatPlaceholder = `Message ${topAgentName}…`;
  $: showRankLabel =
    !!topAgentRankLabel.trim() &&
    topAgentRankLabel.trim().toLowerCase() !== topAgentName.trim().toLowerCase();

  /** Built-in Claude Code tools the top agent must NOT use. Blocking
   *  these (instead of whitelisting kernel tools, which would force us to
   *  enumerate the MCP catalog with names that drift) lets the SDK keep
   *  serving kernel MCP tools by default while removing the noisy
   *  built-ins that were turning every plain question into a Bash +
   *  ToolSearch fishing expedition. */
  /** NOTE: ToolSearch is intentionally NOT here — the kernel MCP exposes
   *  hundreds of tools, so the SDK defers them behind ToolSearch. Blocking
   *  it made every mcp__kernel__ tool unreachable (the original "kernel
   *  tools not available" bug). The system prompt scopes ToolSearch to
   *  loading mcp__kernel__ tools only. */
  const TOP_AGENT_DISALLOWED_TOOLS = [
    'Bash',
    'WebFetch',
    'WebSearch',
    'Glob',
    'Grep',
    'Read',
    'Edit',
    'Write',
    'Task',
    'NotebookEdit',
    'SlashCommand',
  ];

  /** Auto-approve list passed to the SDK loop. The Claude Agent SDK
   *  treats `allowedTools` as "auto-approve, skip the canUseTool prompt"
   *  — NOT as a restriction. Including `mcp__kernel__*` means every
   *  kernel MCP tool the top agent calls fires immediately instead of
   *  bouncing through the permission bus (request_id → SSE → dashboard
   *  → respond → unpark) which is ~150ms per call and was the
   *  observable culprit behind the "not available" responses when the
   *  permission round-trip raced the SDK's own timeout. */
  const TOP_AGENT_ALLOWED_TOOLS = ['mcp__kernel__*', 'ToolSearch'];

  type StreamBlock =
    | { type: 'text'; text: string }
    | {
        type: 'tool_use';
        id: string;
        name: string;
        input: Record<string, unknown>;
        result?: string;
        is_error?: boolean;
      };

  type DisplayMessage = {
    role: 'user' | 'assistant';
    blocks: StreamBlock[];
  };

  let episodeId: string | null = null;
  let messages: DisplayMessage[] = [];
  let input = '';
  let inputEl: HTMLTextAreaElement;
  let scrollEl: HTMLDivElement;
  /** Boot phase — drives the loader. Once 'ready', the loader fades out
   *  and the chat slides in. Failure surfaces inside the loader. */
  let phase: 'connecting' | 'awakening' | 'ready' | 'error' = 'connecting';
  let startError = '';
  let sending = false;
  let streamingBlocks: StreamBlock[] = [];
  let streamAbort: AbortController | null = null;
  let warmupAbort: AbortController | null = null;
  /** Minimum total time the loader stays on-screen — gives the entry
   *  animation room to breathe even when the cold-start happens to be
   *  fast (cached subprocess). 1.2s feels intentional without dragging. */
  const LOADER_MIN_MS = 1200;

  type PendingPermission = {
    request_id: string;
    tool_name: string;
    input: Record<string, unknown>;
  };
  let pendingPermission: PendingPermission | null = null;

  onMount(async () => {
    const startedAt = performance.now();
    phase = 'connecting';
    // 1) Create the chat episode (fast — DB row + handshake).
    try {
      const ep = (await startChatEpisode({
        title: episodeTitle,
        provider: 'claude_code',
        instructions: (topAgentSystemPrompt && topAgentSystemPrompt.trim().length > 0)
          ? topAgentSystemPrompt
          : defaultInstructions(topAgentName),
      })) as { id: string };
      episodeId = ep?.id ?? null;
      if (!episodeId) throw new Error('episode id missing in response');
    } catch (e: any) {
      startError = e?.message || 'Failed to start chat';
      phase = 'error';
      return;
    }
    // 2) Warmup phase — fires a silent ping so the claude_code subprocess
    //    cold-starts, the model warms, and the system prompt caches NOW
    //    (during the loader) instead of when the user sends their first
    //    real message. The exchange is invisible: nothing lands in
    //    `messages` and the stream events are dropped.
    phase = 'awakening';
    await runWarmupTurn();
    // 3) Honor the loader's minimum visible time so the boot animation
    //    plays in full even if everything came back fast (subprocess
    //    cached from a previous open).
    const elapsed = performance.now() - startedAt;
    if (elapsed < LOADER_MIN_MS) {
      await new Promise(r => setTimeout(r, LOADER_MIN_MS - elapsed));
    }
    phase = 'ready';
    await tick();
    inputEl?.focus();
  });

  /** Send a tiny ping that warms the claude_code subprocess + caches the
   *  system prompt. The response is discarded — no `messages` mutation,
   *  no `streamingBlocks`. Permission requests for kernel tools auto-
   *  approve in case the warmup happens to call one (shouldn't, but
   *  bulletproof). Errors are swallowed so a flaky warmup doesn't strand
   *  the user at the loader. */
  async function runWarmupTurn(): Promise<void> {
    if (!episodeId) return;
    warmupAbort = new AbortController();
    try {
      // The warmup is persisted to the episode (the streaming endpoint
      // doesn't accept a skip-persistence flag) but stays hidden from the
      // UI — each modal open creates a throwaway episode so the user
      // never browses to it.
      const stream = sendChatMessageStream(
        {
          episode_id: episodeId,
          message: 'Ping. Respond with exactly the word "ready" and nothing else.',
          allowed_tools: TOP_AGENT_ALLOWED_TOOLS,
          disallowed_tools: TOP_AGENT_DISALLOWED_TOOLS,
          isolate_settings: true,
        },
        warmupAbort.signal,
      );
      for await (const ev of stream) {
        if (ev.type === 'permission_request' && ev.tool_name.startsWith('mcp__kernel__kernel_agents_')) {
          respondChatPermission(ev.request_id, 'allow').catch(() => {});
        }
        // Everything else (text, tool_use, tool_result, done, error) is
        // intentionally consumed and dropped — the warmup must leave no
        // trace in the conversation UI.
        if (ev.type === 'done' || ev.type === 'error') break;
      }
    } catch { /* ignore — warmup is best-effort */ }
    finally {
      warmupAbort = null;
    }
  }

  async function doSend() {
    if (sending || phase !== 'ready' || !episodeId) return;
    const msg = input.trim();
    if (!msg) return;
    input = '';
    if (inputEl) inputEl.style.height = 'auto';
    await runStreamingTurn(msg);
  }

  async function runStreamingTurn(msg: string) {
    if (!episodeId) return;
    messages = [
      ...messages,
      { role: 'user', blocks: [{ type: 'text', text: msg }] },
    ];
    sending = true;
    streamingBlocks = [];
    streamAbort = new AbortController();
    await tick();
    scrollToBottom();

    try {
      const stream = sendChatMessageStream(
        { episode_id: episodeId, message: msg, allowed_tools: TOP_AGENT_ALLOWED_TOOLS,
          disallowed_tools: TOP_AGENT_DISALLOWED_TOOLS, isolate_settings: true },
        streamAbort.signal,
      );
      for await (const ev of stream) {
        await handleStreamEvent(ev);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        messages = [
          ...messages,
          { role: 'assistant', blocks: [{ type: 'text', text: 'Error: ' + (e?.message ?? e) }] },
        ];
      }
    } finally {
      sending = false;
      streamingBlocks = [];
      streamAbort = null;
      await tick();
      scrollToBottom();
    }
  }

  async function handleStreamEvent(ev: ChatStreamEvent) {
    if (ev.type === 'assistant_text') {
      const last = streamingBlocks[streamingBlocks.length - 1];
      if (last && last.type === 'text') {
        last.text += ev.text;
        streamingBlocks = [...streamingBlocks];
      } else {
        streamingBlocks = [...streamingBlocks, { type: 'text', text: ev.text }];
      }
    } else if (ev.type === 'tool_use') {
      streamingBlocks = [
        ...streamingBlocks,
        { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input },
      ];
    } else if (ev.type === 'tool_result') {
      streamingBlocks = streamingBlocks.map((b) =>
        b.type === 'tool_use' && b.id === ev.tool_use_id
          ? { ...b, result: ev.content, is_error: ev.is_error }
          : b,
      );
      // Live-refresh the 3D scene as soon as a flow or agent is minted —
      // waiting for `done` makes the user think nothing happened.
      const justRan = streamingBlocks.find(
        (b) => b.type === 'tool_use' && b.id === ev.tool_use_id,
      );
      if (
        !ev.is_error &&
        justRan &&
        justRan.type === 'tool_use' &&
        (justRan.name.endsWith('kernel_agents_flows_create') ||
          justRan.name.endsWith('kernel_agents_create') ||
          justRan.name.endsWith('kernel_agents_run'))
      ) {
        dispatch('refresh');
      }
    } else if (ev.type === 'permission_request') {
      // Auto-approve our own kernel agent-management tools — they're the
      // whole point of this chat and scoped to local kernel data. Anything
      // else (Bash/Write/etc.) still pops the modal for explicit consent.
      if (
        ev.tool_name.startsWith('mcp__kernel__kernel_agents_') ||
        ev.tool_name === 'mcp__kernel__kernel_agents_flows_create' ||
        ev.tool_name === 'mcp__kernel__kernel_agents_flows_list'
      ) {
        respondChatPermission(ev.request_id, 'allow').catch((e) =>
          console.error('auto-approve failed', e),
        );
      } else {
        pendingPermission = {
          request_id: ev.request_id,
          tool_name: ev.tool_name,
          input: ev.input,
        };
      }
    } else if (ev.type === 'done') {
      // Lock in the message — drop the live stream and append a finished bubble.
      messages = [
        ...messages,
        { role: 'assistant', blocks: streamingBlocks.slice() },
      ];
      streamingBlocks = [];
      // Office likely just got created — let the parent refresh the 3D scene.
      dispatch('refresh');
    } else if (ev.type === 'error') {
      messages = [
        ...messages,
        { role: 'assistant', blocks: [{ type: 'text', text: 'Error: ' + ev.message }] },
      ];
      streamingBlocks = [];
    }
    await tick();
    scrollToBottom();
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

  function fmtToolInput(input: any): string {
    try {
      const s = JSON.stringify(input, null, 2);
      return s.length > 1200 ? s.slice(0, 1200) + '…' : s;
    } catch {
      return String(input);
    }
  }

  function scrollToBottom() {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    } else if (e.key === 'Escape') {
      handleClose();
    }
  }

  function autoResize(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }

  function handleClose() {
    if (streamAbort) {
      try { streamAbort.abort(); } catch { /* ignore */ }
    }
    if (warmupAbort) {
      try { warmupAbort.abort(); } catch { /* ignore */ }
    }
    dispatch('close');
  }

  /** Light markdown — paragraphs + code spans. The 3D modal is small so we
   *  keep formatting minimal; the full renderer lives in /chat. */
  function formatMd(text: string): string {
    if (!text) return '';
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    return `<p>${html}</p>`.replace(/<p><\/p>/g, '');
  }
</script>

<!-- Docked side panel — same geometry as the agent info panel so talking to
     the top agent feels like inspecting an agent, but with its own command
     identity (gold braid, insignia, rank header). No backdrop: the 3D world
     stays visible and interactive while the channel is open. -->
<div class="oc-overlay" role="presentation">
  <div
    class="oc-modal"
    style="--cmd-color:{topAgentColor};"
    on:click|stopPropagation
    on:keydown={(e) => e.key === 'Escape' && handleClose()}
    role="presentation"
  >
    {#if phase !== 'ready'}
      <!-- Boot loader. Visible while the claude_code subprocess cold-starts
           + the system prompt is cached. The rank insignia pulses inside
           concentric rings; the status text rotates through phases so the
           wait reads as intentional progress, not a frozen modal. -->
      <div
        class="oc-boot"
        style="--ins-color:{topAgentColor};"
        out:fade={{ duration: 200 }}
      >
        <div class="oc-boot-stage">
          <span class="oc-boot-ring oc-boot-ring-1"></span>
          <span class="oc-boot-ring oc-boot-ring-2"></span>
          <span class="oc-boot-ring oc-boot-ring-3"></span>
          <span class="oc-boot-insignia">{topAgentInsignia}</span>
        </div>
        <div class="oc-boot-name">{topAgentName}</div>
        <div class="oc-boot-status">
          {#if phase === 'connecting'}
            OPENING DIRECT CHANNEL<span class="oc-boot-dots"><span>.</span><span>.</span><span>.</span></span>
          {:else if phase === 'awakening'}
            STARTING UP<span class="oc-boot-dots"><span>.</span><span>.</span><span>.</span></span>
          {:else if phase === 'error'}
            <span class="oc-boot-error">CONNECTION FAILED</span>
          {/if}
        </div>
        {#if phase === 'error'}
          <div class="oc-boot-error-detail">{startError}</div>
          <button class="oc-boot-close" on:click={handleClose}>Close</button>
        {/if}
      </div>
    {/if}

    <!-- Chat surface — fades in from the bottom once the warmup completes.
         Wrapping with #if phase==='ready' (instead of a CSS opacity toggle)
         lets us drive Svelte transitions cleanly without flickering on
         re-renders during the loader phase. -->
    {#if phase === 'ready'}
    <div
      class="oc-stage"
      in:fly={{ x: 28, duration: 420, easing: cubicOut, delay: 80 }}
    >
    <header class="oc-head">
      <div class="oc-head-id">
        <div class="oc-insignia-wrap">
          <span class="oc-insignia">{topAgentInsignia}</span>
        </div>
        <div class="oc-head-txt">
          {#if showRankLabel}
            <div class="oc-rank-label">{topAgentRankLabel}</div>
          {/if}
          <div class="oc-title-name">{chatTitle}</div>
          <div class="oc-status">
            <span class="oc-dot"></span>
            <span>direct channel · online</span>
          </div>
        </div>
      </div>
      <button class="oc-close" on:click={handleClose} title="Close (Esc)">×</button>
    </header>

    <div class="oc-body" bind:this={scrollEl}>
      {#if startError}
        <div class="oc-error">{startError}</div>
      {:else}
        {#each messages as m}
          <div class="oc-msg oc-msg-{m.role}">
            <div class="oc-avatar" class:oc-avatar-user={m.role === 'user'}>
              {m.role === 'user' ? 'You' : avatarText}
            </div>
            <div class="oc-body-inner">
              {#each m.blocks as b}
                {#if b.type === 'text'}
                  <div class="oc-text">{@html formatMd(b.text)}</div>
                {:else}
                  <details class="oc-tool" class:oc-tool-error={b.is_error}>
                    <summary>
                      <span class="oc-tool-badge">{b.name}</span>
                      <span class="oc-tool-summary">
                        {Object.keys(b.input || {}).slice(0, 3).join(', ')}
                      </span>
                    </summary>
                    <pre class="oc-tool-input">{fmtToolInput(b.input)}</pre>
                    {#if b.result}
                      <pre class="oc-tool-result">{b.result}</pre>
                    {/if}
                  </details>
                {/if}
              {/each}
            </div>
          </div>
        {/each}

        {#if sending && streamingBlocks.length > 0}
          <div class="oc-msg oc-msg-assistant">
            <div class="oc-avatar">{avatarText}</div>
            <div class="oc-body-inner">
              {#each streamingBlocks as b}
                {#if b.type === 'text'}
                  <div class="oc-text">{@html formatMd(b.text)}</div>
                {:else}
                  <details class="oc-tool" open={!b.result} class:oc-tool-error={b.is_error}>
                    <summary>
                      <span class="oc-tool-badge">{b.name}</span>
                      <span class="oc-tool-summary">
                        {b.result ? Object.keys(b.input || {}).slice(0, 3).join(', ') : 'running…'}
                      </span>
                    </summary>
                    <pre class="oc-tool-input">{fmtToolInput(b.input)}</pre>
                    {#if b.result}
                      <pre class="oc-tool-result">{b.result}</pre>
                    {/if}
                  </details>
                {/if}
              {/each}
            </div>
          </div>
        {/if}

        {#if sending && streamingBlocks.length === 0}
          <div class="oc-msg oc-msg-assistant oc-thinking">
            <div class="oc-avatar">{avatarText}</div>
            <div class="oc-thinking-dots"><span></span><span></span><span></span></div>
          </div>
        {/if}
      {/if}
    </div>

    <footer class="oc-foot">
      <textarea
        bind:this={inputEl}
        class="oc-input"
        bind:value={input}
        on:keydown={onKeydown}
        on:input={autoResize}
        placeholder={chatPlaceholder}
        rows="1"
        disabled={sending}
      ></textarea>
      <button
        class="oc-send"
        on:click={doSend}
        disabled={sending || !input.trim()}
      >
        {sending ? '…' : 'Send'}
      </button>
    </footer>
    </div>
    {/if}
  </div>
</div>

{#if pendingPermission}
  <div class="oc-perm-scrim" role="presentation"></div>
  <div class="oc-perm-modal" role="dialog" aria-modal="true">
    <div class="oc-perm-head">
      <span>Tool permission</span>
      <span class="oc-perm-tool">{pendingPermission.tool_name}</span>
    </div>
    <pre class="oc-perm-input">{fmtToolInput(pendingPermission.input)}</pre>
    <div class="oc-perm-actions">
      <button class="oc-perm-deny" on:click={() => approvePermission(false)}>Deny</button>
      <button class="oc-perm-allow" on:click={() => approvePermission(true)}>Allow</button>
    </div>
  </div>
{/if}

<style>
  /* No backdrop — the panel docks to the right edge like the agent info
     panel; the 3D world stays visible and clickable around it. */
  .oc-overlay {
    position: fixed;
    inset: 0;
    z-index: 900;
    pointer-events: none;
  }
  .oc-modal {
    pointer-events: auto;
    position: absolute;
    top: 12px;
    right: 12px;
    bottom: 12px;
    width: min(560px, 46vw);
    min-width: 420px;
    background:
      radial-gradient(ellipse 120% 40% at 50% 0%, color-mix(in srgb, var(--cmd-color, #c9a84c) 9%, transparent) 0%, transparent 60%),
      linear-gradient(180deg, rgba(18, 17, 24, 0.97) 0%, rgba(10, 10, 16, 0.98) 100%);
    backdrop-filter: blur(16px) saturate(1.1);
    border: 1px solid color-mix(in srgb, var(--cmd-color, #c9a84c) 28%, transparent);
    border-radius: 14px;
    box-shadow:
      0 20px 60px -20px rgba(0, 0, 0, 0.7),
      0 0 36px -16px color-mix(in srgb, var(--cmd-color, #c9a84c) 55%, transparent),
      0 0 0 1px rgba(255, 255, 255, 0.02) inset;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: oc-slide 0.25s cubic-bezier(0.2, 0.9, 0.25, 1);
  }
  /* Gold accent stripe down the left edge — the top agent's counterpart
     to the flow-colored stripe on agent panels. */
  .oc-modal::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: 2px;
    background: linear-gradient(180deg, var(--cmd-color, #c9a84c) 0%, transparent 75%);
    opacity: 0.9;
    pointer-events: none;
    z-index: 1;
  }
  @keyframes oc-slide {
    from { transform: translateX(24px); opacity: 0; }
  }
  @media (max-width: 920px) {
    .oc-modal { width: min(560px, 94vw); min-width: 0; left: 12px; }
  }
  /* The chat surface (header + body + footer) is wrapped in .oc-stage so
     it can fly in as a single unit when phase flips to 'ready'. */
  .oc-stage {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  /* ─── Boot loader ─────────────────────────────────────────────── */
  .oc-boot {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    padding: 32px;
    background:
      radial-gradient(ellipse at center, rgba(201, 168, 76, 0.07) 0%, transparent 60%),
      linear-gradient(180deg, #0b0c14 0%, #07080f 100%);
    color: #f0eadb;
  }
  .oc-boot-stage {
    position: relative;
    width: 140px;
    height: 140px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .oc-boot-insignia {
    font: 900 38px 'Manrope', sans-serif;
    color: var(--ins-color, #c9a84c);
    text-shadow:
      0 0 18px var(--ins-color, #c9a84c),
      0 0 6px rgba(255, 255, 255, 0.4);
    letter-spacing: 1px;
    animation: oc-boot-pulse 2.2s ease-in-out infinite;
  }
  .oc-boot-ring {
    position: absolute;
    inset: 50%;
    width: 0; height: 0;
    border-radius: 50%;
    border: 1.5px solid var(--ins-color, #c9a84c);
    transform: translate(-50%, -50%);
    pointer-events: none;
    opacity: 0;
  }
  .oc-boot-ring-1 { animation: oc-boot-ring 2.4s ease-out infinite; }
  .oc-boot-ring-2 { animation: oc-boot-ring 2.4s ease-out infinite 0.8s; }
  .oc-boot-ring-3 { animation: oc-boot-ring 2.4s ease-out infinite 1.6s; }
  @keyframes oc-boot-ring {
    0%   { width: 30px; height: 30px; opacity: 0.9; }
    100% { width: 180px; height: 180px; opacity: 0; }
  }
  @keyframes oc-boot-pulse {
    0%, 100% { transform: scale(1);    filter: drop-shadow(0 0 4px var(--ins-color, #c9a84c)); }
    50%      { transform: scale(1.08); filter: drop-shadow(0 0 12px var(--ins-color, #c9a84c)); }
  }
  .oc-boot-name {
    font: 700 14px 'Syne', sans-serif;
    letter-spacing: 4px;
    text-transform: uppercase;
    color: #f3e9c7;
    text-shadow: 0 0 12px rgba(201, 168, 76, 0.4);
  }
  .oc-boot-status {
    font: 600 10px 'Manrope', sans-serif;
    letter-spacing: 2.4px;
    color: #8a8fa8;
    text-transform: uppercase;
    display: flex;
    align-items: baseline;
    gap: 2px;
    min-height: 14px;
  }
  .oc-boot-dots span {
    display: inline-block;
    animation: oc-boot-dot 1.4s ease-in-out infinite;
    opacity: 0.3;
  }
  .oc-boot-dots span:nth-child(1) { animation-delay: 0s; }
  .oc-boot-dots span:nth-child(2) { animation-delay: 0.2s; }
  .oc-boot-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes oc-boot-dot {
    0%, 80%, 100% { opacity: 0.2; transform: translateY(0); }
    40%           { opacity: 1;   transform: translateY(-2px); }
  }
  .oc-boot-error {
    color: #ff8080;
    letter-spacing: 3px;
  }
  .oc-boot-error-detail {
    font: 400 12px 'Manrope', sans-serif;
    color: #ff8080;
    text-align: center;
    max-width: 380px;
    line-height: 1.5;
    margin-top: -6px;
  }
  .oc-boot-close {
    margin-top: 8px;
    background: transparent;
    border: 1px solid #ff8080;
    color: #ff8080;
    padding: 6px 18px;
    border-radius: 6px;
    cursor: pointer;
    font: 600 12px 'Manrope', sans-serif;
    letter-spacing: 1px;
  }
  .oc-boot-close:hover { background: rgba(255, 128, 128, 0.12); }
  .oc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px 12px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--cmd-color, #c9a84c) 7%, transparent) 0%, transparent 100%);
    border-bottom: 1px solid color-mix(in srgb, var(--cmd-color, #c9a84c) 22%, transparent);
    position: relative;
    flex-shrink: 0;
  }
  /* Braid — thin gold chevron strip under the header, formal-uniform
     cue that no agent panel has. */
  .oc-head::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 3px;
    background: repeating-linear-gradient(
      -45deg,
      color-mix(in srgb, var(--cmd-color, #c9a84c) 65%, transparent) 0 6px,
      transparent 6px 12px
    );
    opacity: 0.5;
    pointer-events: none;
  }
  .oc-head-id { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .oc-insignia-wrap {
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--cmd-color, #c9a84c) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--cmd-color, #c9a84c) 45%, transparent);
    box-shadow: 0 0 18px -6px var(--cmd-color, #c9a84c);
  }
  .oc-insignia {
    font: 900 17px 'Manrope', sans-serif;
    color: var(--cmd-color, #c9a84c);
    text-shadow: 0 0 10px var(--cmd-color, #c9a84c);
    letter-spacing: 1px;
    animation: oc-boot-pulse 3s ease-in-out infinite;
  }
  .oc-head-txt { min-width: 0; }
  .oc-rank-label {
    font: 700 9px 'Manrope', sans-serif;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--cmd-color, #c9a84c) 80%, #fff);
    opacity: 0.85;
  }
  .oc-title-name {
    font: 700 16px 'Syne', 'Manrope', sans-serif;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: #f3e9c7;
    text-shadow: 0 0 14px color-mix(in srgb, var(--cmd-color, #c9a84c) 35%, transparent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .oc-status {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    font: 600 9px 'JetBrains Mono', monospace;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: #8a8fa8;
  }
  .oc-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--cmd-color, #d4a84b);
    box-shadow: 0 0 6px var(--cmd-color, #d4a84b);
    animation: oc-status-pulse 2.4s ease-in-out infinite;
  }
  @keyframes oc-status-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
  .oc-close {
    border: none;
    background: transparent;
    color: var(--text-2, #a0a0a0);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 6px;
  }
  .oc-close:hover { background: rgba(255, 255, 255, 0.06); color: var(--text-1, #f0f0f0); }

  .oc-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .oc-loading,
  .oc-error {
    color: var(--text-2, #a0a0a0);
    font-size: 13px;
    text-align: center;
    padding: 32px 0;
  }
  .oc-error { color: #ff8080; }

  .oc-msg { display: flex; gap: 10px; align-items: flex-start; }
  .oc-msg-user { flex-direction: row-reverse; }
  .oc-avatar {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--cmd-color, #d4a84b) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--cmd-color, #d4a84b) 45%, transparent);
    color: var(--cmd-color, #d4a84b);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.3px;
  }
  .oc-avatar-user { background: rgba(99, 102, 241, 0.18); border-color: rgba(99, 102, 241, 0.35); color: #a5b4fc; }

  .oc-body-inner { max-width: 82%; min-width: 0; }
  .oc-msg-user .oc-body-inner { text-align: right; }
  .oc-text {
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-1, #f0f0f0);
    word-wrap: break-word;
  }
  .oc-text :global(p) { margin: 0 0 6px; }
  .oc-text :global(p:last-child) { margin-bottom: 0; }
  .oc-text :global(code) {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid var(--border, #2a2a2a);
    padding: 1px 5px;
    border-radius: 4px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .oc-msg-user .oc-text {
    background: rgba(99, 102, 241, 0.14);
    border: 1px solid rgba(99, 102, 241, 0.3);
    padding: 8px 12px;
    border-radius: 10px;
    display: inline-block;
    text-align: left;
  }

  .oc-tool {
    margin: 6px 0;
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.02);
    font-size: 12px;
    overflow: hidden;
  }
  .oc-tool.oc-tool-error { border-color: rgba(255, 80, 80, 0.4); background: rgba(255, 80, 80, 0.05); }
  .oc-tool > summary {
    list-style: none;
    cursor: pointer;
    padding: 6px 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
  }
  .oc-tool > summary::-webkit-details-marker { display: none; }
  .oc-tool-badge {
    background: var(--cmd-color, #d4a84b);
    color: #1a1a1a;
    border-radius: 3px;
    padding: 1px 6px;
    font-weight: 600;
    font-family: ui-monospace, monospace;
    font-size: 11px;
  }
  .oc-tool-summary { color: var(--text-2, #a0a0a0); font-family: ui-monospace, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .oc-tool-input,
  .oc-tool-result {
    margin: 0;
    padding: 6px 10px;
    border-top: 1px solid var(--border, #2a2a2a);
    background: rgba(0, 0, 0, 0.22);
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--text-2, #a0a0a0);
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .oc-tool-result { color: var(--text-1, #f0f0f0); }
  .oc-tool.oc-tool-error .oc-tool-result { color: #ff8080; }

  .oc-thinking { align-items: center; }
  .oc-thinking-dots { display: flex; gap: 4px; padding: 6px 0; }
  .oc-thinking-dots span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-2, #a0a0a0);
    animation: oc-bounce 1.2s infinite;
  }
  .oc-thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
  .oc-thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes oc-bounce {
    0%, 80%, 100% { opacity: 0.3; transform: translateY(0); }
    40% { opacity: 1; transform: translateY(-3px); }
  }

  .oc-foot {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    padding: 10px 12px;
    border-top: 1px solid var(--border, #2a2a2a);
    background: rgba(255, 255, 255, 0.02);
  }
  .oc-input {
    flex: 1;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 8px;
    padding: 8px 12px;
    color: var(--text-1, #f0f0f0);
    font-family: inherit;
    font-size: 13px;
    resize: none;
    max-height: 160px;
    overflow-y: auto;
    line-height: 1.45;
  }
  .oc-input:focus { outline: none; border-color: var(--cmd-color, #d4a84b); }
  .oc-input:disabled { opacity: 0.5; cursor: not-allowed; }
  .oc-send {
    background: var(--cmd-color, #d4a84b);
    color: #1a1a1a;
    border: none;
    padding: 8px 18px;
    border-radius: 8px;
    font-weight: 700;
    cursor: pointer;
    font-size: 12px;
    letter-spacing: 0.4px;
    text-transform: uppercase;
  }
  .oc-send:disabled { opacity: 0.4; cursor: not-allowed; }
  .oc-send:not(:disabled):hover { filter: brightness(1.08); }

  /* Permission modal (mirrors /chat) */
  .oc-perm-scrim {
    position: fixed; inset: 0; z-index: 998; background: rgba(0,0,0,0.55); backdrop-filter: blur(2px);
  }
  .oc-perm-modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    z-index: 999; width: min(560px, 92vw);
    background: var(--bg, #0d0d0d);
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 10px;
    box-shadow: 0 18px 50px rgba(0,0,0,0.7);
    overflow: hidden;
  }
  .oc-perm-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--border, #2a2a2a);
    font-weight: 600; color: var(--text-1, #f0f0f0);
  }
  .oc-perm-tool {
    background: var(--gold, #d4a84b);
    color: #1a1a1a;
    padding: 2px 8px;
    border-radius: 4px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    font-weight: 600;
  }
  .oc-perm-input {
    margin: 0;
    padding: 12px 16px;
    background: rgba(0,0,0,0.3);
    border: 0;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--text-2, #a0a0a0);
    max-height: 280px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .oc-perm-actions {
    display: flex; gap: 8px; justify-content: flex-end;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--border, #2a2a2a);
    background: rgba(255,255,255,0.02);
  }
  .oc-perm-deny,
  .oc-perm-allow {
    border: 1px solid var(--border, #2a2a2a);
    background: transparent;
    color: var(--text-1, #f0f0f0);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 600;
    font-size: 12px;
  }
  .oc-perm-deny:hover { border-color: #ff8080; color: #ff8080; }
  .oc-perm-allow {
    background: var(--gold, #d4a84b);
    color: #1a1a1a;
    border-color: var(--gold, #d4a84b);
  }
  .oc-perm-allow:hover { filter: brightness(1.08); }
</style>
