<script lang="ts">
  /**
   * Meeting history — the last 10 meetings, top-left. Clicking a row re-opens
   * the live transcript modal, which stays in AgentWorld3D.
   *
   * Presentational: the meeting store, the transcript modal and the archive
   * endpoints all live in the parent, so this takes the list as a prop and
   * reports what the user did through callbacks. The parent's hq-bar toggle
   * reads `show` and the list length reactively, which is why visibility is
   * two-way bound rather than driven by a method.
   */

  /** Newest first — the parent derives and sorts this. Top 10 are shown. */
  export let meetings: Array<{
    id: string;
    topic: string;
    status: 'requested' | 'started' | 'completed' | 'failed';
    moderatorName: string;
    participants: Array<{ id: string; name: string }>;
    turns: Array<{ tokens?: number }>;
    summary?: string;
  }> = [];

  /** Bound — the panel's own × closes it, and so does the hq-bar View menu. */
  export let show = false;

  /** Row clicked: the parent points the transcript modal at this meeting. */
  export let onOpen: (id: string) => void = () => {};
  /** Single row dismissed — only offered on completed/failed meetings. */
  export let onDismiss: (id: string) => void = () => {};
  /** Archive every completed/failed meeting at once. */
  export let onDismissAllRead: () => void = () => {};
</script>

{#if show && meetings.length > 0}
  {@const closedCount = meetings.filter(m => m.status === 'completed' || m.status === 'failed').length}
  <div class="hist-panel hist-open">
    <div class="hist-head">
      <span class="hist-head-badge">{meetings.length}</span>
      <span class="hist-head-label">Meetings</span>
      {#if closedCount > 0}
        <button class="hist-clear-all"
                title="Archive every completed/failed meeting"
                on:click={onDismissAllRead}>
          Clear {closedCount} read
        </button>
      {/if}
      <button class="hist-head-close"
              title="Hide this panel (also via the hq-bar View menu)"
              on:click={() => (show = false)}>×</button>
    </div>
    <div class="hist-body">
        {#each meetings.slice(0, 10) as m (m.id)}
          <div class="hist-row hist-row-{m.status}"
               role="button"
               tabindex="0"
               on:click={() => onOpen(m.id)}
               on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(m.id); }}>
            <div class="hist-row-head">
              {#if m.status === 'started'}<span class="hist-dot hist-dot-live"></span>
              {:else if m.status === 'completed'}<span class="hist-dot hist-dot-done"></span>
              {:else if m.status === 'failed'}<span class="hist-dot hist-dot-fail"></span>
              {:else}<span class="hist-dot hist-dot-pending"></span>{/if}
              <span class="hist-row-topic">{(m.topic || '(no topic)').slice(0, 60)}</span>
              {#if m.status === 'completed' || m.status === 'failed'}
                <button class="hist-row-x"
                        title="Dismiss this meeting"
                        on:click|stopPropagation={() => onDismiss(m.id)}>✕</button>
              {/if}
            </div>
            <div class="hist-row-meta">
              <span>{m.moderatorName}</span>
              <span>·</span>
              <span>{m.participants.length} participants</span>
              <span>·</span>
              <span>{m.turns.length} turns</span>
              {#if m.turns.length > 0}
                <span>·</span>
                <span>{m.turns.reduce((s, t) => s + (t.tokens || 0), 0).toLocaleString()} tk</span>
              {/if}
            </div>
            {#if m.summary}
              <div class="hist-row-summary">{m.summary.slice(0, 110)}{m.summary.length > 110 ? '…' : ''}</div>
            {/if}
          </div>
        {/each}
    </div>
  </div>
{/if}

<style>
  /* `.hist-panel` animates with lm-turn-in, whose @keyframes lives in
     AgentWorld3D and does not cross the component boundary — duplicated
     here. This is the later of the two definitions there, which is the one
     that actually wins the cascade. */
  @keyframes lm-turn-in {
    from { opacity:0; transform:translateY(6px); }
    to   { opacity:1; transform:translateY(0); }
  }

  /* ── Meeting history panel (top-left, under stats bar) ──────────
     Positioned on the left so it doesn't fight the live-meeting modal,
     which now occupies the entire right column.

     `.hist-badge`, `.hist-label` and `.hist-chev` used to sit in this block
     with no markup referencing them anywhere; they were left behind rather
     than carried over. */
  .hist-panel{
    position:absolute; top:60px; left:18px; z-index:11;
    width:min(340px, 38vw);
    background:#0f1018; border:1px solid #2a2f4a; border-radius:8px;
    box-shadow:0 6px 22px rgba(0,0,0,.35);
    animation:lm-turn-in .3s ease-out;
    font:500 11px 'JetBrains Mono',monospace; color:#cbd0e8;
  }
  .hist-head{
    display:flex; align-items:center; gap:8px;
    padding:8px 12px; color:#e7e9f4;
    font:700 11px 'JetBrains Mono',monospace;
    border-bottom:1px solid #1f2236;
  }
  .hist-head-badge{
    background:#ffd166; color:#0f1018; padding:1px 7px; border-radius:10px;
    font:700 10px 'JetBrains Mono',monospace;
  }
  .hist-head-label{ flex:1; }
  .hist-head-close{
    background:transparent; border:none; color:#6b7090; cursor:pointer;
    font:700 14px 'JetBrains Mono',monospace; padding:0 4px; line-height:1;
  }
  .hist-head-close:hover{ color:#fff; }
  .hist-clear-all{
    padding:2px 8px; background:#2a1818; color:#ffb4b4;
    border:1px solid #553030; border-radius:4px;
    cursor:pointer; font:600 10px 'JetBrains Mono',monospace;
    transition:background .12s, color .12s;
  }
  .hist-clear-all:hover{ background:#3a2020; color:#ff7a7a; }
  .hist-row-x{
    margin-left:auto; padding:0 6px; background:transparent;
    color:#5a5f7a; border:1px solid transparent; border-radius:3px;
    cursor:pointer; font:700 11px 'JetBrains Mono',monospace;
    line-height:1.2;
    transition:color .12s, border-color .12s, background .12s;
  }
  .hist-row-x:hover{ color:#ff7a7a; border-color:#553030; background:#2a1818; }
  .hist-body{
    max-height:50vh; overflow-y:auto; padding:4px;
  }
  .hist-body::-webkit-scrollbar{ width:6px; }
  .hist-body::-webkit-scrollbar-thumb{ background:#2a2f4a; border-radius:3px; }
  .hist-row{
    display:block; width:100%; text-align:left;
    border:none; background:#13152080;
    border-left:3px solid #5b8def;
    padding:7px 10px; margin:3px 0;
    cursor:pointer; color:#cbd0e8;
    font:500 11px 'JetBrains Mono',monospace;
    transition:background .12s, transform .12s;
  }
  .hist-row:hover{ background:#1a1d2c; transform:translateX(-2px); }
  .hist-row-started{ border-left-color:#ffd166; }
  .hist-row-completed{ border-left-color:#78dc8c; }
  .hist-row-failed{ border-left-color:#ff6b6b; }
  .hist-row-requested{ border-left-color:#5b8def; }
  .hist-row-head{
    display:flex; align-items:center; gap:6px; font:700 11px 'JetBrains Mono',monospace;
    color:#e7e9f4;
  }
  .hist-dot{
    width:7px; height:7px; border-radius:50%;
    flex-shrink:0;
  }
  .hist-dot-live{ background:#ffd166; animation:hist-pulse 1.4s ease-in-out infinite; }
  .hist-dot-done{ background:#78dc8c; }
  .hist-dot-fail{ background:#ff6b6b; }
  .hist-dot-pending{ background:#5b8def; }
  @keyframes hist-pulse{ 0%,100%{opacity:1;} 50%{opacity:.4;} }
  .hist-row-topic{ flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hist-row-meta{
    display:flex; gap:5px; flex-wrap:wrap; margin-top:3px;
    font-size:10px; color:#7e84a3;
  }
  .hist-row-summary{
    margin-top:4px; font-size:10px; color:#9298b8; line-height:1.4;
  }
</style>
