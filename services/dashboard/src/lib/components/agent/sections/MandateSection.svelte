<!--
  MandateSection — what the agent was told to be.

  Moved out of AgentWorld3D.svelte's overview body unchanged except for one
  thing the spec asks for: it now COLLAPSES.

  The old block printed the description and the whole system prompt, and the
  prompt is long. It took the best space on a panel whose first question is
  "is this agent OK?" while being the least actionable thing on it — nobody
  edits a prompt from here, and the answer to "what is this agent" fits in the
  one line the record already carries. So the description stays visible and the
  `<pre>` is one click away. Everything the old block could show, it still
  shows; the copy button still copies the full prompt without expanding.

  Since 2026-10-05 the prompt is also editable here (✎ edit): a textarea in
  place of the rendered markdown, saved through agents.update.
-->
<script lang="ts">
  import type { Readable } from 'svelte/store';
  import { tick } from 'svelte';
  import { formatRunOutput } from '$lib/run-format.js';
  import { updateAgent } from '$lib/api.js';

  /** The drawer's agent store (`AgentDrawer` publishes it on the overview slot). */
  export let store: Readable<any>;
  /** Reserved for the embedded mount on /agents — tightens the spacing. */
  export let compact = false;
  /**
   * The prompt, when the caller already resolved it.
   *
   * The 3D world computes `selPrompt` from its own detail fetch and prefers it
   * over the list row, so it passes that value in and the section renders
   * exactly what it rendered inline. Left null, the section reads the agent —
   * which is what the embedded mount will do once the store loads its own
   * detail row.
   */
  export let prompt: string | null = null;
  /** Detail fetch in flight, same reason as `prompt`. Null → ask the store. */
  export let loading: boolean | null = null;
  /** Bindable so the caller can keep the state across a close/reopen. */
  export let collapsed = false;

  $: state = $store ?? {};
  $: agent = (state.agent ?? {}) as Record<string, any>;
  // ── Editing ──
  // The prompt edits in place: Edit swaps the rendered markdown for a
  // textarea, Save writes system_prompt through agents.update. The saved text
  // shows at once (savedText) — the caller's `prompt` comes from its own
  // detail fetch, which only catches up on its next refresh.
  let editing = false;
  let draft = '';
  let saving = false;
  let saveError = '';
  let savedText: string | null = null;
  /** Bumped on every successful save: re-keys the "saved" flash so it replays each time. */
  let savedTick = 0;
  let savedVisible = false;
  let savedTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every failure: re-keys the shake. */
  let errorTick = 0;
  let editor: HTMLTextAreaElement;
  let lastAgentId = '';
  $: if (String(agent.id ?? '') !== lastAgentId) {
    lastAgentId = String(agent.id ?? '');
    savedText = null;
    editing = false;
    saveError = '';
  }

  $: text = savedText ?? prompt ?? String(agent.system_prompt ?? '');
  $: isLoading = loading ?? !!state.loading;
  $: description = String(agent.description ?? '');
  $: builtin = String(agent.builtin_handler ?? '');

  /**
   * The line the section collapses to.
   *
   * The description when there is one — that is the point of the change. With
   * no description a prompt-carrying agent would collapse to a bare heading,
   * so the prompt's own first line stands in for it.
   */
  $: summary =
    description ||
    (text ? firstLine(text) : '');

  function firstLine(s: string): string {
    const l = s.split('\n').map((x) => x.trim()).find((x) => x.length > 0) ?? '';
    return l.length > 140 ? l.slice(0, 140) + '…' : l;
  }

  async function startEdit() {
    draft = text;
    saveError = '';
    editing = true;
    collapsed = false;
    await tick();
    editor?.focus();
  }

  function cancelEdit() {
    editing = false;
    saveError = '';
  }

  /**
   * Save, then check the kernel kept it: agents.update answers with the stored
   * agent, and a save counts only when its system_prompt is what was sent.
   * Anything else — no agent in the answer, a different prompt, a thrown
   * error — stays on screen as an error with the editor still open.
   */
  async function save() {
    const id = String(agent.id ?? '');
    if (saving) return;
    if (!id) { fail('This agent has no id yet — reopen it and try again.'); return; }
    saving = true;
    saveError = '';
    const sent = draft;
    console.debug('[mandate] saving', { id, chars: sent.length });
    try {
      const res = (await updateAgent(id, { system_prompt: sent })) as { agent?: { system_prompt?: unknown } } | null;
      const stored = res?.agent?.system_prompt;
      if (typeof stored !== 'string') throw new Error('The kernel answered without the agent — the change may not be stored.');
      if (stored !== sent) throw new Error('The kernel answered, but the stored prompt is different from what you wrote.');
      console.debug('[mandate] saved', { id, chars: stored.length });
      savedText = stored;
      editing = false;
      savedTick++;
      savedVisible = true;
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (savedVisible = false), 2600);
    } catch (err) {
      console.error('[mandate] save failed', err);
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      saving = false;
    }
  }

  function fail(message: string) {
    saveError = message;
    errorTick++;
  }

  function onEditorKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); }
  }

  let copiedKey: string | null = null;
  async function copy(t: string, key: string) {
    try {
      await navigator.clipboard.writeText(t);
      copiedKey = key;
      setTimeout(() => { if (copiedKey === key) copiedKey = null; }, 1200);
    } catch {
      copiedKey = key + ':err';
      setTimeout(() => { copiedKey = null; }, 1200);
    }
  }
</script>

<!-- Editing, the section takes its natural height (not the leftover-height
     flex of an open mandate), so the editor and its buttons never spill over
     the sections below; the tab scrolls instead. -->
<section class="ip-sec ip-mandate" class:sec-compact={compact} class:ip-mandate-open={!collapsed && !!text && !editing} class:ip-mandate-editing={editing}>
  <div class="ip-sec-hrow">
    <button class="ip-sec-h ip-sec-btn" on:click={() => (collapsed = !collapsed)}>
      <span class="ip-caret" class:open={!collapsed}>▸</span>
      Mandate
      {#if text}<span class="ip-sec-c">{text.length} chars</span>{/if}
    </button>
    {#if savedVisible}
      {#key savedTick}
        <span class="ip-saved-chip" role="status">✓ Saved</span>
      {/key}
    {/if}
    <span class="ip-mandate-actions">
      {#if !builtin && agent.id && !editing}
        <button class="ip-icon-btn" title="edit the system prompt" on:click={startEdit}>✎ edit</button>
      {/if}
      {#if text && !editing}
        <button class="ip-icon-btn" title="copy system prompt" on:click={() => copy(text, 'sys')}>{copiedKey === 'sys' ? '✓ copied' : '⧉ copy'}</button>
      {/if}
    </span>
  </div>

  {#if summary}
    <p class="ip-role">{summary}</p>
  {/if}

  {#if editing}
    <div class="ip-progress" class:on={saving} aria-hidden="true"><span></span></div>
    <textarea
      class="ip-mandate-edit"
      class:is-saving={saving}
      class:is-error={!!saveError}
      readonly={saving}
      bind:this={editor}
      bind:value={draft}
      on:keydown={onEditorKey}
      spellcheck="false"
      aria-label="System prompt"
    ></textarea>
    {#key errorTick}
    <div class="ip-mandate-editbar" class:shake={errorTick > 0 && !!saveError}>
      <span class="ip-sec-c">{draft.length} chars</span>
      {#if draft !== text && !saving && !saveError}<span class="ip-dirty" title="Unsaved changes">● unsaved</span>{/if}
      <span class="ip-mandate-hint">Ctrl+Enter saves · Esc cancels</span>
      <span class="ip-spacer"></span>
      <button class="ip-icon-btn" type="button" on:click={cancelEdit} disabled={saving}>Cancel</button>
      <button class="ip-icon-btn ip-save" class:busy={saving} type="button" on:click={save} disabled={saving || (draft === text && !saveError)}>
        {#if saving}<span class="ip-spin" aria-hidden="true"></span>Saving…{:else if saveError}Retry{:else}Save{/if}
      </button>
    </div>
    {/key}
    {#if saveError}<p class="ip-mandate-err" role="alert">✗ Not saved — {saveError}</p>{/if}
  {:else if !collapsed}
    {#if text}
      {#key savedTick}
      <div class="ip-flash-wrap" class:flash={savedTick > 0}>
      <!-- Rendered, not raw: prompts are written in markdown. formatRunOutput
           escapes HTML first (the same renderer as the run output). -->
      <div class="ip-mandate-md">{@html formatRunOutput(text)}</div>
      </div>
      {/key}
    {:else if builtin}
      <div class="ip-mandate-alt">
        Runs a builtin handler — no system prompt.
        <code class="ip-code">{builtin}</code>
      </div>
    {:else if isLoading}
      <div class="ip-mandate-alt">Loading system prompt…</div>
    {:else}
      <div class="ip-mandate-alt">No system prompt set.</div>
    {/if}
  {:else if !text}
    <!-- Collapsed with nothing to expand into: the state IS the content, so
         it stays on screen instead of hiding behind a caret that opens onto
         the same one line. -->
    {#if builtin}
      <div class="ip-mandate-alt">
        Runs a builtin handler — no system prompt.
        <code class="ip-code">{builtin}</code>
      </div>
    {:else if isLoading}
      <div class="ip-mandate-alt">Loading system prompt…</div>
    {:else}
      <div class="ip-mandate-alt">No system prompt set.</div>
    {/if}
  {/if}
</section>

<style>
  /* Every rule below is a copy of the one AgentWorld3D.svelte applied to this
     markup while it lived there. Svelte scopes CSS per component: a rule left
     in the parent does not reach markup that moved into a child. */
  .ip-sec{margin-bottom:18px}
  .sec-compact{margin-bottom:12px}
  .ip-sec-h, .ip-sec-btn{
    font:600 10px 'Syne',sans-serif;
    color:#8a8fa8;text-transform:uppercase;letter-spacing:1.5px;
    margin:0 0 8px;display:inline-flex;align-items:center;gap:6px;
  }
  .ip-sec-btn{
    background:none;border:none;cursor:pointer;padding:0;
    color:#8a8fa8;font:inherit;letter-spacing:inherit;
  }
  .ip-sec-btn:hover{color:#d8dae3}
  .ip-sec-hrow{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .ip-sec-hrow .ip-sec-h{margin-bottom:0}
  .ip-sec-c{
    font:600 9px 'JetBrains Mono',monospace;
    padding:1px 6px;border-radius:4px;
    background:rgba(120,130,160,.15);color:#a0a5b8;
    letter-spacing:0;text-transform:none;
  }
  .ip-caret{
    display:inline-block;font:400 9px monospace;
    transition:transform .2s;color:#6a6f82;
  }
  .ip-caret.open{transform:rotate(90deg)}
  /* ── Mandate ───────────────────
     The block that opens Overview: the role the agent was given and the prompt
     that spells it out. The role is the lead line of the card it belongs to,
     not a loose paragraph under the tabs. */
  .ip-mandate{
    padding-left:12px;
    border-left:2px solid color-mix(in srgb, var(--flow-color) 55%, transparent);
  }
  .ip-mandate .ip-role{
    font:500 13px/1.5 'Manrope',sans-serif;
    color:#dfe2ec;margin:0 0 8px;
  }
  .ip-mandate-alt{
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;
    padding:10px 12px;border-radius:8px;
    background:rgba(120,130,160,.05);
    border:1px dashed rgba(120,130,160,.18);
    font:400 11px 'Manrope',sans-serif;color:#8a8fa8;
  }
  .ip-code{
    font:500 11px 'JetBrains Mono',monospace;
    background:rgba(0,0,0,.3);color:#d8dae3;
    padding:2px 7px;border-radius:4px;
    border:1px solid rgba(120,130,160,.12);
  }
  /* Open, the mandate takes the rest of the tab's height and scrolls
     inside; with little room left it still gets 260px. */
  .ip-mandate-open{flex:1 1 0;min-height:260px;display:flex;flex-direction:column}
  .ip-mandate-md{
    flex:1;min-height:0;overflow-y:auto;
    padding:12px 16px;border-radius:8px;
    background:rgba(0,0,0,.28);border:1px solid rgba(120,130,160,.1);
    font:400 12.5px/1.6 'Manrope',sans-serif;color:#d0d4e0;
    word-break:break-word;overflow-wrap:anywhere;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  .ip-mandate-md :global(.md-h){font:700 13px 'Syne',sans-serif;color:#e5e8f0;margin:14px 0 6px;letter-spacing:.3px}
  .ip-mandate-md :global(h3.md-h){font-size:14.5px;color:#fff}
  .ip-mandate-md :global(h5.md-h){font-size:12px;color:#c8ccd8;text-transform:uppercase;letter-spacing:.6px}
  .ip-mandate-md :global(.md-h:first-child), .ip-mandate-md :global(.md-p:first-child){margin-top:0}
  .ip-mandate-md :global(.md-p){margin:6px 0}
  .ip-mandate-md :global(.md-ul), .ip-mandate-md :global(.md-ol){margin:6px 0 6px 20px;padding:0}
  .ip-mandate-md :global(li){margin:3px 0}
  .ip-mandate-md :global(strong){color:#f0f2f7;font-weight:700}
  .ip-mandate-md :global(.md-code){font:500 11.5px 'JetBrains Mono',monospace;background:rgba(120,130,160,.14);padding:1px 5px;border-radius:4px;color:#e5e8f0}
  .ip-mandate-md :global(.md-codeblock){
    margin:8px 0;padding:10px 12px;border-radius:6px;background:#0a0b14;border:1px solid rgba(120,130,160,.16);
    font:500 11px/1.5 'JetBrains Mono',monospace;color:#cbd0e8;white-space:pre-wrap;overflow-x:auto;
  }
  .ip-mandate-md :global(a){color:#9fb4e8}
  .ip-icon-btn{
    background:rgba(120,130,160,.08);
    border:1px solid rgba(120,130,160,.15);
    color:#a0a5b8;
    padding:4px 8px;border-radius:5px;
    font:500 9px 'JetBrains Mono',monospace;letter-spacing:.3px;
    cursor:pointer;transition:all .12s;
    display:inline-flex;align-items:center;gap:4px;
    white-space:nowrap;
  }
  .ip-icon-btn:hover{background:rgba(120,130,160,.16);color:#f0f2f7}
  .ip-mandate-actions{display:inline-flex;gap:6px}
  .ip-mandate-editing{flex:none}
  .ip-mandate-edit{
    display:block;height:min(60vh,560px);min-height:200px;width:100%;box-sizing:border-box;resize:vertical;
    padding:12px 14px;border-radius:8px;
    background:rgba(0,0,0,.35);border:1px solid color-mix(in srgb, var(--flow-color) 45%, rgba(120,130,160,.2));
    font:400 12px/1.55 'JetBrains Mono',monospace;color:#e0e3ec;
  }
  .ip-mandate-edit:focus{outline:none;border-color:var(--flow-color)}
  .ip-mandate-editbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;position:relative;z-index:1}
  .ip-mandate-hint{font:400 10.5px 'Manrope',sans-serif;color:#6a6f82}
  .ip-mandate-err{margin:8px 0 0;padding:8px 10px;border-radius:6px;font:500 11.5px/1.45 'Manrope',sans-serif;color:#ffb0b0;background:rgba(255,90,90,.08);border:1px solid rgba(255,90,90,.3);animation:ip-fade-in .2s ease-out}
  .ip-mandate-edit.is-saving{opacity:.6}
  .ip-mandate-edit.is-error{border-color:rgba(255,110,110,.7)}
  .ip-dirty{font:600 10.5px 'Manrope',sans-serif;color:#f5c26b}
  /* Indeterminate bar over the editor while the save is in flight. */
  .ip-progress{height:2px;margin-bottom:4px;border-radius:2px;overflow:hidden;background:transparent}
  .ip-progress.on{background:rgba(159,232,192,.12)}
  .ip-progress span{display:block;height:100%;width:35%;background:#9fe8c0;transform:translateX(-110%)}
  .ip-progress.on span{animation:ip-indeterminate 1s ease-in-out infinite}
  .ip-spin{display:inline-block;width:9px;height:9px;margin-right:6px;vertical-align:-1px;border-radius:50%;border:1.5px solid rgba(159,232,192,.35);border-top-color:#9fe8c0;animation:ip-rot .7s linear infinite}
  .ip-save.busy{opacity:1;cursor:progress}
  .shake{animation:ip-shake .4s ease-in-out}
  /* Saved: the chip pops in by the heading, the mandate glows once. */
  .ip-saved-chip{margin-left:auto;margin-right:8px;font:700 10.5px 'Manrope',sans-serif;color:#0d2a1c;background:#9fe8c0;padding:2px 8px;border-radius:999px;animation:ip-pop 2.6s ease-out forwards}
  .ip-flash-wrap{display:flex;flex-direction:column;flex:1;min-height:0;border-radius:8px}
  .ip-flash-wrap.flash{animation:ip-glow 1.4s ease-out}
  @keyframes ip-indeterminate{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}
  @keyframes ip-rot{to{transform:rotate(360deg)}}
  @keyframes ip-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(5px)}60%{transform:translateX(-4px)}80%{transform:translateX(2px)}}
  @keyframes ip-pop{0%{opacity:0;transform:scale(.6)}12%{opacity:1;transform:scale(1.12)}22%{transform:scale(1)}80%{opacity:1}100%{opacity:0}}
  @keyframes ip-glow{0%{box-shadow:0 0 0 0 rgba(159,232,192,.75)}60%{box-shadow:0 0 0 6px rgba(159,232,192,0)}100%{box-shadow:none}}
  @keyframes ip-fade-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: reduce){
    .ip-progress.on span,.ip-spin,.shake,.ip-saved-chip,.ip-flash-wrap.flash{animation:none}
    .ip-progress.on span{transform:none;width:100%}
  }
  .ip-spacer{flex:1}
  .ip-save{color:#9fe8c0;border-color:rgba(159,232,192,.35)}
  .ip-save:disabled{opacity:.45;cursor:default}
</style>
