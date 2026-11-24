<script lang="ts">
  import { onMount } from 'svelte';
  import { readApiError } from '$lib/api.js';
  import { fmtRelTime } from '$lib/display-format.js';

  /** Per-account spam filter: what triage does with the mail it calls spam. */
  export let accountId: string;

  type Mode = 'off' | 'dry_run' | 'move';
  type Action = 'moved' | 'would_move' | 'move_failed' | 'restored' | 'dismissed';
  interface Settings { mode: Mode; min_confidence: number; folder: string }
  interface Entry {
    id: string; subject: string; from: string; date: string;
    spam: { action: Action; confidence: number; reason: string; at: string; folder?: string; error?: string };
  }

  const ACTION_LABEL: Record<Action, string> = {
    moved: 'Moved to spam', would_move: 'Would move', move_failed: 'Move failed', restored: 'Back in inbox', dismissed: 'Not spam',
  };

  let settings: Settings = { mode: 'off', min_confidence: 0.85, folder: '' };
  let entries: Entry[] = [];
  let loading = true;
  let saving = false;
  let busyId = '';
  let error = '';

  async function load() {
    loading = true;
    error = '';
    try {
      const q = encodeURIComponent(accountId);
      const [s, l] = await Promise.all([
        fetch(`/api/email-accounts/spam-settings?account_id=${q}`),
        fetch(`/api/emails/spam-log?account_id=${q}&limit=20`),
      ]);
      if (s.ok) settings = await s.json();
      else error = (await readApiError(s)) || ('Could not read the spam filter settings');
      if (l.ok) entries = await l.json();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function save() {
    saving = true;
    error = '';
    try {
      const r = await fetch('/api/email-accounts/spam-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, ...settings }),
      });
      if (r.ok) settings = await r.json();
      else error = (await readApiError(r)) || ('Could not save the spam filter settings');
    } finally {
      saving = false;
    }
  }

  async function act(e: Entry, what: 'restore' | 'move') {
    busyId = e.id;
    error = '';
    try {
      const r = await fetch(`/api/emails/spam/${what}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: e.id }),
      });
      if (!r.ok) error = (await readApiError(r)) || (what === 'restore' ? 'Could not move it back' : 'Could not move it');
      else {
        const rec = await r.json();
        entries = entries.map((x) => (x.id === e.id ? { ...x, spam: { ...x.spam, ...rec } } : x));
      }
    } finally {
      busyId = '';
    }
  }

  onMount(load);
</script>

<section class="spam" aria-label="Spam filter">
  <header>
    <h4>Spam filter</h4>
    <p>Triage looks at every new email and says whether it is spam. Choose what happens then.</p>
  </header>

  {#if loading}
    <p class="muted">Loading…</p>
  {:else}
    <div class="controls">
      <label>
        <span>When triage finds spam</span>
        <select bind:value={settings.mode} on:change={save} disabled={saving}>
          <option value="off">Do nothing</option>
          <option value="dry_run">Only show it here (dry run)</option>
          <option value="move">Move it to the spam folder</option>
        </select>
      </label>
      <label>
        <span>Only when it is at least</span>
        <select bind:value={settings.min_confidence} on:change={save} disabled={saving || settings.mode === 'off'}>
          <option value={0.95}>95% sure</option>
          <option value={0.9}>90% sure</option>
          <option value={0.85}>85% sure</option>
          <option value={0.75}>75% sure</option>
        </select>
      </label>
      <label class="grow">
        <span>Folder</span>
        <input type="text" bind:value={settings.folder} on:change={save} disabled={saving || settings.mode === 'off'}
               placeholder="The server's spam folder" />
      </label>
    </div>
    {#if settings.mode === 'move'}
      <p class="note">Moved mail leaves the inbox on the server too. “Not spam” puts it back.</p>
    {/if}

    {#if error}<p class="err">{error}</p>{/if}

    {#if entries.length}
      <ul class="log">
        {#each entries as e (e.id)}
          <li class="a-{e.spam.action}">
            <span class="badge">{ACTION_LABEL[e.spam.action] ?? e.spam.action}</span>
            <span class="what">
              <b>{e.subject || '(no subject)'}</b>
              <small>{e.from} · {Math.round((e.spam.confidence ?? 0) * 100)}%{e.spam.reason ? ` · ${e.spam.reason}` : ''}{e.spam.error ? ` · ${e.spam.error}` : ''}</small>
            </span>
            <span class="when">{e.spam.at ? fmtRelTime(e.spam.at) : ''}</span>
            <span class="btns">
              {#if e.spam.action === 'would_move' || e.spam.action === 'move_failed'}
                <button class="tertiary" disabled={busyId === e.id} on:click|stopPropagation={() => act(e, 'move')}>Move to spam</button>
              {/if}
              {#if e.spam.action === 'moved' || e.spam.action === 'would_move' || e.spam.action === 'move_failed'}
                <button class="tertiary" disabled={busyId === e.id} on:click|stopPropagation={() => act(e, 'restore')}>Not spam</button>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    {:else if settings.mode !== 'off'}
      <p class="muted">No spam found yet.</p>
    {/if}
  {/if}
</section>

<style>
  .spam { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
  header h4 { margin: 0; font-size: 13px; color: var(--text-1); }
  header p { margin: 2px 0 10px; font-size: 12px; color: var(--text-3); }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
  .controls label { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--text-2); }
  .controls label.grow { flex: 1 1 180px; }
  .controls select, .controls input {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 5px 8px; color: var(--text-1); font-size: 12.5px; font-family: inherit;
  }
  .controls select:focus, .controls input:focus { border-color: var(--gold); outline: none; }
  .controls select:disabled, .controls input:disabled { opacity: .55; }
  .note { margin: 8px 0 0; font-size: 11.5px; color: var(--text-3); }
  .muted { font-size: 12px; color: var(--text-3); margin: 10px 0 0; }
  .err { font-size: 12px; color: #f87171; margin: 8px 0 0; }
  .log { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .log li {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 10px; align-items: center;
    padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg);
  }
  .badge { font-size: 10.5px; font-weight: 600; padding: 2px 7px; border-radius: 999px; white-space: nowrap; background: var(--surface-1); color: var(--text-2); border: 1px solid var(--border); }
  .a-moved .badge { color: #f59e0b; border-color: rgba(245,158,11,.45); }
  .a-would_move .badge { color: #60a5fa; border-color: rgba(96,165,250,.45); }
  .a-move_failed .badge { color: #f87171; border-color: rgba(239,68,68,.45); }
  .a-restored .badge, .a-dismissed .badge { color: #4ade80; border-color: rgba(74,222,128,.4); }
  .what { display: flex; flex-direction: column; min-width: 0; }
  .what b { font-size: 12.5px; color: var(--text-1); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .what small { font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .when { font-size: 11px; color: var(--text-3); white-space: nowrap; }
  .btns { display: flex; gap: 6px; }
  button.tertiary { background: none; color: var(--text-2); border: 1px solid var(--border); border-radius: 6px; padding: 4px 9px; cursor: pointer; font-size: 11.5px; white-space: nowrap; }
  button.tertiary:hover:not(:disabled) { background: var(--surface-1); color: var(--text-1); }
  button.tertiary:disabled { opacity: .5; cursor: default; }
  @media (max-width: 640px) {
    .log li { grid-template-columns: minmax(0, 1fr); }
  }
</style>
