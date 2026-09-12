<script lang="ts">
  /**
   * CHAT tab of the agent drawer — the thread with one agent, or the
   * explanation of why there isn't one.
   *
   * The conversation itself stays in AgentWorld3D: sending a message starts a
   * run, polls it, and folds the reply back into the world's state. So the
   * thread arrives as a prop and the actions are callbacks. Only `input` and
   * the scroll element are two-way bound, because the parent clears the box
   * and scrolls the list when a reply lands.
   */
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import ChatComposer from '$lib/components/ChatComposer.svelte';
  import { fmtClock } from '$lib/display-format.js';
  import { formatRunOutput } from '$lib/run-format.js';
  import { isLlmConfigError, LLM_SETTINGS_HREF } from '$lib/llm-error.js';

  /** The selected agent — only the fields this tab renders. */
  export let agent: { name: string; description?: string; builtin_handler: string } | null = null;

  /**
   * False for a builtin agent: its executor calls `handler()` with no
   * arguments, so anything typed here would be discarded.
   */
  export let canConverse = false;

  export let history: Array<{ role: 'you' | 'agent'; text: string; ts: number }> = [];
  export let historyLoading = false;
  export let error = '';
  /** The run was accepted and the agent is working. */
  export let pending = false;

  /** Bound — the parent clears it once the message is away. */
  export let input = '';
  export let sending = false;
  export let suggestions: string[] = [];

  /** Bound — the parent scrolls this element when a reply lands. */
  export let scrollEl: HTMLDivElement | null = null;

  /** A run started from the script-agent branch is in flight. */
  export let starting = false;

  export let onSend: (text: string) => void = () => {};
  export let onStart: () => void = () => {};
  export let onSeeHistory: () => void = () => {};
  /** UUID chips inside a reply open the entity preview; the world owns it. */
  export let onOutputClick: (e: MouseEvent) => void = () => {};
</script>

<div class="chat-section">
  {#if !canConverse}
    <!-- A builtin agent never sees what you type: the executor calls
         `handler()` with no arguments and throws the goal away. Rather
         than offer a field that quietly does something else, say what
         this agent is and point at the controls that do work. -->
    <div class="chat-noop">
      <div class="chat-noop-glyph" aria-hidden="true">▣</div>
      <h4 class="chat-noop-h">{agent?.name} doesn't read messages</h4>
      <p class="chat-noop-p">
        It's a script agent. Anything sent here would be discarded and the script
        would run unchanged — the same thing <b>Run now</b> does.
      </p>
      <div class="chat-noop-kv">
        <span class="chat-noop-lbl">runs</span>
        <code class="ip-code">{agent?.builtin_handler}</code>
      </div>
      {#if agent?.description}
        <div class="chat-noop-kv">
          <span class="chat-noop-lbl">does</span>
          <span class="chat-noop-desc">{agent.description}</span>
        </div>
      {/if}
      <div class="chat-noop-actions">
        <button class="ip-btn ip-btn-primary" on:click={onStart} disabled={starting}>
          <span class="ip-btn-ico">{starting ? '●' : '▶'}</span>
          <span>{starting ? 'starting…' : 'Run now'}</span>
        </button>
        <button class="ip-btn ip-btn-ghost" on:click={onSeeHistory}>
          <span class="ip-btn-ico">◷</span><span>See what it did</span>
        </button>
      </div>
    </div>
  {:else}
    <div class="chat-messages" bind:this={scrollEl}>
      {#if historyLoading && history.length === 0}
        <div class="ip-loading">Loading the conversation…</div>
      {:else if history.length === 0}
        <div class="chat-intro">
          <div class="chat-intro-h">Talk to {agent?.name}</div>
          <p class="chat-intro-p">
            {#if agent?.description}{agent.description} — a{:else}A{/if}sk a question or hand
            over a one-off task. It answers here using its own tools, and the thread is
            stored with the agent, so it's still here next time you open this panel.
          </p>
        </div>
      {:else}
        {#each history as msg, i (msg.ts + '-' + msg.role + '-' + i)}
          <div class="chat-msg copy-wrap" class:chat-you={msg.role === 'you'} class:chat-agent={msg.role === 'agent'}>
            <CopyTextBtn text={msg.text} title="Copy message" />
            <div class="chat-meta">
              <span class="chat-role">{msg.role === 'you' ? 'You' : agent?.name}</span>
              <span class="chat-time">{fmtClock(new Date(msg.ts).toISOString())}</span>
            </div>
            {#if msg.role === 'agent'}
              <div class="chat-text ip-out-md" on:click={onOutputClick} role="presentation">{@html formatRunOutput(msg.text)}</div>
              {#if isLlmConfigError(msg.text)}
                <a class="llm-fix" href={LLM_SETTINGS_HREF}>⚙ Configure LLM →</a>
              {/if}
            {:else}
              <span class="chat-text">{msg.text}</span>
            {/if}
          </div>
        {/each}
      {/if}

      {#if pending}
        <!-- Named work, not a bare spinner: these runs take minutes and
             an unlabelled dot reads as a hang. -->
        <div class="chat-msg chat-agent chat-typing" aria-live="polite">
          <div class="chat-meta"><span class="chat-role">{agent?.name}</span></div>
          <div class="chat-typing-row">
            <span class="chat-typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>
            <span class="chat-typing-txt">working — running its tools, this can take a few minutes</span>
          </div>
        </div>
      {/if}
    </div>

    {#if error}
      <div class="chat-err" role="alert">
        <span class="chat-err-ico" aria-hidden="true">⚠</span>
        <span>{error}</span>
        {#if isLlmConfigError(error)}
          <a class="llm-fix" href={LLM_SETTINGS_HREF}>⚙ Configure LLM →</a>
        {/if}
      </div>
    {/if}

    <ChatComposer
      bind:value={input}
      {sending}
      placeholder={`Ask ${agent?.name} something, or hand over a task…`}
      hint="Enter sends · Shift+Enter for a new line · the thread is saved with the agent"
      {suggestions}
      sendLabel={`Send to ${agent?.name}`}
      on:send={(e) => onSend(e.detail)}
    />
  {/if}
</div>

<style>
  /* Moved from AgentWorld3D: every `.chat-*` rule, plus `.ip-btn*` and
     `.ip-code`, which nothing outside this tab used.

     Copied, not moved, because the parent still needs them: `.ip-loading`
     (only the loading half of its `.ip-loading,.ip-empty` pair), the base
     `.ip-out-md` rule (its `:global` children stay in the parent and reach
     the rendered markdown from there), and `.llm-fix` — `.llm-fix-row` was
     left behind, it is only ever used outside this tab.

     `.copy-wrap` is not here at all: it is `:global` in the parent.
     `--flow-color` comes from an ancestor and inherits through the DOM. */

  .ip-loading{
    font:500 11px 'Manrope',sans-serif;color:#6a6f82;
    text-align:center;padding:24px 12px;
  }
  .ip-out-md{
    font:400 12.5px/1.6 'Manrope',sans-serif;color:#d0d4e0;
    padding:14px 18px;border-radius:6px;background:rgba(0,0,0,.22);
    word-break:break-word;overflow-wrap:anywhere;max-height:380px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }

  /* ── Primary actions ─────────── */
  .ip-btn{
    display:inline-flex;align-items:center;gap:6px;
    padding:8px 14px;border-radius:8px;
    font:600 11px 'Syne',sans-serif;letter-spacing:.4px;
    cursor:pointer;transition:all .15s;
    border:1px solid transparent;
  }
  .ip-btn-ico{font:500 11px 'JetBrains Mono',monospace}
  .ip-btn-primary{
    background:#78dc8c;color:#0a0e14;border-color:#78dc8c;
    box-shadow:0 6px 16px -8px rgba(120,220,140,.5);
  }
  .ip-btn-primary:hover:not(:disabled){background:#8ee4a0;border-color:#8ee4a0}
  .ip-btn-primary:disabled{opacity:.5;cursor:wait;background:rgba(120,220,140,.3);border-color:rgba(120,220,140,.2)}
  .ip-btn-ghost{
    background:rgba(255,255,255,.03);
    border-color:rgba(120,130,160,.2);
    color:#d8dae3;
  }
  .ip-btn-ghost:hover{background:rgba(255,255,255,.06);border-color:rgba(120,130,160,.35)}

  .ip-code{
    font:500 11px 'JetBrains Mono',monospace;
    background:rgba(0,0,0,.3);color:#d8dae3;
    padding:2px 7px;border-radius:4px;
    border:1px solid rgba(120,130,160,.12);
  }

  /* ═══════════════════════════════════════════════════════════════
     CHAT — message input + conversation thread
     ═══════════════════════════════════════════════════════════════ */
  .chat-section{
    flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;
    padding:16px 18px;
  }
  .chat-messages{
    flex:1;overflow-y:auto;margin-bottom:12px;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
    display:flex;flex-direction:column;gap:10px;
  }
  .chat-msg{
    padding:10px 12px;border-radius:10px;
    font:400 13px/1.5 'Manrope',sans-serif;
    max-width:90%;
    word-break:break-word;
  }
  .chat-you{
    align-self:flex-end;
    background:color-mix(in srgb, var(--flow-color) 14%, transparent);
    border:1px solid color-mix(in srgb, var(--flow-color) 28%, transparent);
  }
  .chat-agent{
    align-self:flex-start;
    background:rgba(120,130,160,.06);
    border:1px solid rgba(120,130,160,.15);
  }
  /* Author and clock on one line — a reply that lands minutes after you asked
     needs a timestamp to be readable as a conversation. */
  .chat-meta{display:flex;align-items:baseline;gap:8px;margin-bottom:4px}
  .chat-role{
    font:600 9px 'JetBrains Mono',monospace;
    text-transform:uppercase;letter-spacing:.5px;
  }
  .chat-time{font:400 9px 'JetBrains Mono',monospace;color:#6a6f82;font-variant-numeric:tabular-nums}
  .chat-you .chat-role{color:var(--flow-color)}
  .chat-agent .chat-role{color:#a78bfa}
  .chat-text{color:#e0e2ea}
  .chat-agent .chat-text{max-height:300px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.2) transparent}

  /* ── Empty thread ──
     Says who you are about to talk to and what happens to the thread, instead
     of a one-liner floating over 500px of nothing. */
  .chat-intro{margin:auto 0;padding:4px 2px;max-width:46ch}
  .chat-intro-h{font:600 14px 'Syne',sans-serif;color:#e0e2ea;margin-bottom:6px}
  .chat-intro-p{font:400 12px/1.6 'Manrope',sans-serif;color:#8a8fa8;margin:0}

  /* ── Working ────────────────── */
  .chat-typing{opacity:.9}
  .chat-typing-row{display:flex;align-items:center;gap:8px}
  .chat-typing-txt{font:400 11px 'Manrope',sans-serif;color:#8a8fa8}
  .chat-typing-dots{display:inline-flex;gap:3px;flex-shrink:0}
  .chat-typing-dots span{
    width:5px;height:5px;border-radius:50%;background:#a78bfa;
    animation:chat-blink 1.2s ease-in-out infinite;
  }
  .chat-typing-dots span:nth-child(2){animation-delay:.18s}
  .chat-typing-dots span:nth-child(3){animation-delay:.36s}
  @keyframes chat-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
  @media (prefers-reduced-motion: reduce){
    .chat-typing-dots span{animation:none;opacity:.7}
  }

  .chat-err{
    display:flex;align-items:flex-start;gap:8px;
    margin-bottom:10px;padding:8px 10px;border-radius:8px;
    background:rgba(239,93,110,.08);
    border:1px solid rgba(239,93,110,.25);
    font:400 11px/1.45 'Manrope',sans-serif;color:#f0a0aa;
  }
  .chat-err-ico{flex-shrink:0}

  /* ── "Configure LLM" chip ──
     A run that dies with no provider configured is not a report, it is a task.
     The kernel already names the screen in prose ("Settings → AI"); this is
     that sentence as something you can click. */
  .llm-fix{
    flex-shrink:0;align-self:center;
    padding:3px 9px;border-radius:999px;text-decoration:none;white-space:nowrap;
    font:600 10px 'JetBrains Mono',monospace;letter-spacing:.3px;
    background:rgba(201,168,76,.10);
    border:1px solid rgba(201,168,76,.45);
    color:#d4a84b;transition:background .12s,border-color .12s;
  }
  .llm-fix:hover{background:rgba(201,168,76,.20);border-color:#d4a84b}

  /* ── Script agents ──
     The tab stays, the input does not. Same call as the office environment:
     an affordance that cannot work is explained, not silently removed. */
  .chat-noop{
    margin:auto 0;padding:18px;border-radius:12px;max-width:52ch;
    background:rgba(120,130,160,.04);
    border:1px solid rgba(120,130,160,.14);
  }
  .chat-noop-glyph{font:400 20px 'JetBrains Mono',monospace;color:#8a8fa8;margin-bottom:8px}
  .chat-noop-h{font:600 14px 'Syne',sans-serif;color:#e0e2ea;margin:0 0 6px}
  .chat-noop-p{font:400 12px/1.6 'Manrope',sans-serif;color:#8a8fa8;margin:0 0 14px}
  .chat-noop-kv{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
  .chat-noop-lbl{
    flex-shrink:0;width:38px;
    font:600 9px 'JetBrains Mono',monospace;color:#6a6f82;
    text-transform:uppercase;letter-spacing:.5px;
  }
  .chat-noop-desc{font:400 12px/1.5 'Manrope',sans-serif;color:#c0c5d8}
  .chat-noop-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
</style>
