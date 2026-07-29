<script lang="ts">
  // Surface C — a global DevOps quick console. A small floating button (shown
  // only when the paid DevOps page is active) opens a compact "pick a repo →
  // task → run" panel that dispatches the DevOps Lead, from anywhere in the app.
  import { rpcOrCall } from '$lib/ws.js';
  import { extPages } from '$lib/ext-host.js';

  $: hasDevops = $extPages.some((p) => p.view === 'devops');

  let open = false;
  let repos: Array<{ id: string; name: string; path: string }> = [];
  let office: Array<{ id: string; name: string; role: string }> = [];
  let repoId = '';
  let task = '';
  let busy = false;
  let err = '';
  let sent = '';

  async function load() {
    try {
      const b: any = await rpcOrCall('devops.board', {});
      repos = b?.repos ?? [];
      office = b?.office ?? [];
      if (repos.length && !repos.some((r) => r.id === repoId)) repoId = repos[0].id;
    } catch {
      err = 'Could not reach the DevOps backend.';
    }
  }
  function toggle() {
    open = !open;
    err = '';
    sent = '';
    if (open) load();
  }
  async function run() {
    const repo = repos.find((r) => r.id === repoId);
    const lead = office.find((a) => a.role === 'manager') ?? office[0];
    if (!repo || !lead || !task.trim()) return;
    busy = true;
    err = '';
    const goal = `Work on repository "${repo.name}" at ${repo.path}.\n\n${task.trim()}`;
    try {
      await rpcOrCall('agents.run', { agent_id: lead.id, goal });
      sent = `Sent to ${lead.name}`;
      task = '';
      setTimeout(() => { open = false; sent = ''; }, 1400);
    } catch (e: any) {
      err = e?.message ?? 'Run failed';
    }
    busy = false;
  }
</script>

{#if hasDevops}
  <button class="dqc-fab" on:click={toggle} title="DevOps quick console — send a task to the office" aria-label="DevOps quick console">🛠</button>
  {#if open}
    <div class="dqc-backdrop" on:click={() => (open = false)} role="presentation"></div>
    <div class="dqc-modal" role="dialog" aria-label="DevOps quick task">
      <div class="dqc-head">
        <span>DevOps quick task</span>
        <a href="/devops" class="dqc-link" on:click={() => (open = false)}>open panel →</a>
      </div>
      {#if !repos.length}
        <div class="dqc-muted">{err || 'No repos yet — connect one in the DevOps panel.'}</div>
      {:else}
        <select bind:value={repoId} class="dqc-inp">
          {#each repos as r}<option value={r.id}>{r.name}</option>{/each}
        </select>
        <textarea bind:value={task} rows="3" class="dqc-inp" placeholder="e.g. add a health endpoint and tests"></textarea>
        {#if err}<div class="dqc-err">{err}</div>{/if}
        {#if sent}<div class="dqc-ok">{sent}</div>{/if}
        <div class="dqc-actions">
          <button class="dqc-btn" on:click={() => (open = false)}>Cancel</button>
          <button class="dqc-btn primary" disabled={busy || !task.trim()} on:click={run}>{busy ? '…' : '▶ Run'}</button>
        </div>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .dqc-fab {
    position: fixed; right: 18px; bottom: 18px; z-index: 60;
    width: 46px; height: 46px; border-radius: 50%;
    background: var(--accent, #6366f1); color: #fff; border: none; cursor: pointer;
    font-size: 20px; box-shadow: 0 6px 18px rgba(0,0,0,.35);
  }
  .dqc-fab:hover { filter: brightness(1.1); }
  .dqc-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 61; }
  .dqc-modal {
    position: fixed; right: 18px; bottom: 74px; z-index: 62; width: 340px;
    background: var(--surface-1, #14172a); border: 1px solid var(--border, #2a2f45);
    border-radius: 12px; padding: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
    display: flex; flex-direction: column; gap: 8px;
  }
  .dqc-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; color: var(--text-1, #e8eaf6); }
  .dqc-link { font-size: 12px; color: var(--accent, #6366f1); text-decoration: none; }
  .dqc-muted { font-size: 13px; color: var(--text-3, #8a8fb0); }
  .dqc-inp { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border, #2a2f45); background: var(--surface-2, #1b1f36); color: var(--text-1, #e8eaf6); font-size: 13px; box-sizing: border-box; }
  .dqc-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .dqc-btn { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border, #2a2f45); background: var(--surface-2, #1b1f36); color: var(--text-1, #e8eaf6); cursor: pointer; font-size: 13px; }
  .dqc-btn.primary { background: var(--accent, #6366f1); border-color: transparent; color: #fff; }
  .dqc-btn:disabled { opacity: .5; cursor: default; }
  .dqc-err { font-size: 12px; color: #ef4770; }
  .dqc-ok { font-size: 12px; color: #34d399; }
</style>
