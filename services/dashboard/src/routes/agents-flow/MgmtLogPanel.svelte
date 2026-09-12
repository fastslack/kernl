<script lang="ts">
  /**
   * Management log — the floating record of manager edits and cross-office
   * escalations, bottom-left.
   *
   * Presentational on purpose. The entries live in AgentWorld3D because the
   * event loop pushes into them and the HQ toggle reads their count
   * reactively; a `bind:this` handle would not give the parent that. So the
   * list arrives as a prop and visibility is two-way bound.
   */
  import { mgmtKindIcon, mgmtKindColor } from '$lib/agent-helpers.js';

  /** Newest first. The parent caps the list at 40; this shows the top 10. */
  export let entries: Array<{
    kind: 'edit' | 'directive' | 'escalation';
    from: string;
    to: string;
    detail: string;
    preview: string;
    ts: number;
    crossOffice?: boolean;
    role?: string;
  }> = [];

  /** Bound — the panel's own × closes it, and so does the hq-bar View menu. */
  export let show = false;
</script>

{#if show && entries.length > 0}
  <div class="mgmt-log mgmt-log-open">
    <div class="mgmt-log-head">
      <span class="mgmt-log-badge">{entries.length}</span>
      <span class="mgmt-log-label">Management log</span>
      <button class="mgmt-log-close"
              title="Hide this panel (also via the hq-bar View menu)"
              on:click={() => (show = false)}>×</button>
    </div>
    <div class="mgmt-log-body">
      {#each entries.slice(0, 10) as entry}
        <div class="mgmt-entry" style="border-left-color:{mgmtKindColor(entry.kind, entry.crossOffice)}">
          <div class="mgmt-entry-head">
            <span class="mgmt-entry-ico">{mgmtKindIcon(entry.kind)}</span>
            <span class="mgmt-entry-from">{entry.from}</span>
            <span class="mgmt-entry-arrow">→</span>
            <span class="mgmt-entry-to">{entry.to}</span>
            {#if entry.crossOffice}<span class="mgmt-entry-tag">cross-office</span>{/if}
            {#if entry.role === 'manager'}<span class="mgmt-entry-tag mgmt-entry-tag-mgr">manager</span>{/if}
          </div>
          <div class="mgmt-entry-detail">{entry.detail}</div>
          {#if entry.preview}<div class="mgmt-entry-preview">{entry.preview.slice(0, 140)}{entry.preview.length > 140 ? '…' : ''}</div>{/if}
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* `.mgmt-log` animates with lm-turn-in, whose @keyframes lives in
     AgentWorld3D and does not cross the component boundary — so it is
     duplicated here. The parent keeps its copy for `.lm-turn` and
     `.lm-toast`. This is the later of the two definitions there, which is
     the one that actually wins the cascade. */
  @keyframes lm-turn-in {
    from { opacity:0; transform:translateY(6px); }
    to   { opacity:1; transform:translateY(0); }
  }

  /* ── Management log panel (bottom-left) ─────────────────── */
  .mgmt-log{
    position:absolute; bottom:18px; left:18px; z-index:11;
    width:min(360px, 40vw);
    background:#0f1018; border:1px solid #2a2f4a; border-radius:8px;
    box-shadow:0 6px 22px rgba(0,0,0,.35);
    animation:lm-turn-in .3s ease-out;
    font:500 11px 'JetBrains Mono',monospace; color:#cbd0e8;
  }
  .mgmt-log-head{
    display:flex; align-items:center; gap:8px;
    padding:8px 12px; color:#e7e9f4;
    font:700 11px 'JetBrains Mono',monospace;
    border-bottom:1px solid #1f2236;
  }
  .mgmt-log-badge{
    background:#c67fe8; color:#0f1018; padding:1px 7px; border-radius:10px;
    font:700 10px 'JetBrains Mono',monospace;
  }
  .mgmt-log-label{ flex:1; text-align:left; }
  .mgmt-log-close{
    background:transparent; border:none; color:#6b7090; cursor:pointer;
    font:700 14px 'JetBrains Mono',monospace; padding:0 4px; line-height:1;
  }
  .mgmt-log-close:hover{ color:#fff; }
  .mgmt-log-body{
    max-height:360px; overflow-y:auto; padding:4px;
  }
  .mgmt-log-body::-webkit-scrollbar{ width:6px; }
  .mgmt-log-body::-webkit-scrollbar-thumb{ background:#2a2f4a; border-radius:3px; }
  .mgmt-entry{
    border-left:3px solid #c67fe8; padding:6px 10px; margin:2px 0;
    background:#13152080;
  }
  .mgmt-entry-head{
    display:flex; align-items:center; gap:6px; flex-wrap:wrap;
    font:600 11px 'JetBrains Mono',monospace;
  }
  .mgmt-entry-from{ color:#e7e9f4; }
  .mgmt-entry-arrow{ color:#5a5f7a; }
  .mgmt-entry-to{ color:#cbe0ff; }
  .mgmt-entry-tag{
    font-size:9px; padding:0 5px; border-radius:3px;
    background:#1a1d2c; color:#8b90af; border:1px solid #2a2f4a;
  }
  .mgmt-entry-tag-mgr{ background:#3a2812; color:#f0b874; border-color:#6a4820; }
  .mgmt-entry-detail{
    margin-top:3px; color:#cbd0e8; font:500 11px 'Manrope',sans-serif;
    word-break:break-word;
  }
  .mgmt-entry-preview{
    margin-top:3px; padding:4px 6px; background:#0a0b14; border-radius:3px;
    color:#8b90af; font:400 10px 'JetBrains Mono',monospace;
    white-space:pre-wrap; word-break:break-word;
  }
</style>
