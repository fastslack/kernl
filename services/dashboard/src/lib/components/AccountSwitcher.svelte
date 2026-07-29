<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  export let value: string = '';
  export let onChange: (accountId: string) => void = () => {};
  export let showAll = true;
  export let storageKey = 'mail.selected_account';

  interface EmailAccount {
    id: string;
    label: string;
    email: string;
    provider: 'gmail' | 'resend' | 'imap_smtp';
    type: string;
    is_default: number;
  }

  let accounts: EmailAccount[] = [];
  let loading = true;
  let open = false;

  async function load() {
    loading = true;
    try {
      const r = await fetch('/api/email-accounts', { headers: { 'Content-Type': 'application/json' } });
      accounts = r.ok ? await r.json() : [];
    } finally {
      loading = false;
    }
  }

  function choose(id: string) {
    value = id;
    open = false;
    try { localStorage.setItem(storageKey, id); } catch {}
    onChange(id);
  }

  function providerIcon(p: string): string {
    switch (p) {
      case 'gmail': return 'G';
      case 'resend': return 'R';
      case 'imap_smtp': return '@';
      default: return '?';
    }
  }

  function providerColor(p: string): string {
    switch (p) {
      case 'gmail': return '#ea4335';
      case 'resend': return '#000000';
      case 'imap_smtp': return '#3b82f6';
      default: return '#6b7280';
    }
  }

  onMount(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) value = stored;
    } catch {}
    load();
  });

  $: current = accounts.find((a) => a.id === value);
  $: currentLabel = current ? current.label : (value === '' ? 'All accounts' : 'Select account');
  $: currentEmail = current ? current.email : '';
</script>

<div class="switcher">
  <button class="switcher-btn" on:click={() => (open = !open)} disabled={loading}>
    {#if current}
      <span class="provider-chip" style="background:{providerColor(current.provider)}">{providerIcon(current.provider)}</span>
    {:else}
      <span class="provider-chip all">✱</span>
    {/if}
    <span class="switcher-main">
      <span class="switcher-label">{currentLabel}</span>
      {#if currentEmail}<span class="switcher-email">{currentEmail}</span>{/if}
    </span>
    <span class="switcher-arrow">▾</span>
  </button>

  {#if open}
    <div class="switcher-menu" on:mouseleave={() => (open = false)} role="menu" tabindex="-1">
      {#if showAll}
        <button class="switcher-item" class:selected={value === ''} on:click={() => choose('')}>
          <span class="provider-chip all">✱</span>
          <div class="switcher-item-main">
            <div class="switcher-item-label">All accounts</div>
            <div class="switcher-item-email">Show everything</div>
          </div>
        </button>
      {/if}

      {#if accounts.length === 0 && !loading}
        <div class="switcher-empty">No accounts yet — add one in Settings</div>
      {/if}

      {#each accounts as acc (acc.id)}
        <button class="switcher-item" class:selected={value === acc.id} on:click={() => choose(acc.id)}>
          <span class="provider-chip" style="background:{providerColor(acc.provider)}">{providerIcon(acc.provider)}</span>
          <div class="switcher-item-main">
            <div class="switcher-item-label">
              {acc.label}
              {#if acc.is_default}<span class="default-tag">default</span>{/if}
            </div>
            <div class="switcher-item-email">{acc.email}</div>
          </div>
        </button>
      {/each}

      <div class="switcher-sep"></div>
      <button class="switcher-item manage" on:click={() => { open = false; goto('/mail/accounts'); }}>
        <span class="provider-chip manage-chip">⚙</span>
        <div class="switcher-item-main">
          <div class="switcher-item-label">Manage accounts</div>
          <div class="switcher-item-email">Add, edit, test connections</div>
        </div>
      </button>
    </div>
  {/if}
</div>

<style>
  .switcher { position: relative; display: inline-block; }
  .switcher-btn {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text);
    cursor: pointer;
    font-size: 12px;
    min-width: 200px;
    text-align: left;
  }
  .switcher-btn:hover { border-color: var(--primary); }
  .switcher-main { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
  .switcher-label { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .switcher-email { font-size: 10px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .switcher-arrow { color: var(--text-3); font-size: 10px; }

  .provider-chip {
    width: 22px; height: 22px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: var(--primary); color: #fff;
    font-weight: 700; font-size: 11px; flex-shrink: 0;
  }
  .provider-chip.all { background: linear-gradient(135deg, #6366f1, #a855f7); }
  .manage-chip { background: var(--surface-hover, var(--surface)); color: var(--text-2); border: 1px solid var(--border); }

  .switcher-menu {
    position: absolute; top: calc(100% + 4px); left: 0;
    min-width: 260px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 6px 20px rgba(0,0,0,.25);
    z-index: 150;
    padding: 4px 0;
    overflow: hidden;
  }
  .switcher-item {
    display: flex; gap: 8px; align-items: center;
    width: 100%;
    padding: 6px 10px;
    background: none; border: none;
    color: var(--text);
    cursor: pointer;
    text-align: left;
    font-size: 12px;
  }
  .switcher-item:hover { background: var(--surface); }
  .switcher-item.selected { background: var(--surface-hover, var(--surface)); }
  .switcher-item-main { flex: 1; min-width: 0; }
  .switcher-item-label { font-weight: 600; display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .switcher-item-email { font-size: 10px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .default-tag {
    font-size: 9px; text-transform: uppercase;
    background: rgba(34,197,94,.12); color: #22c55e;
    border: 1px solid rgba(34,197,94,.3); border-radius: 6px;
    padding: 1px 5px; letter-spacing: 0.3px;
  }
  .switcher-sep { border-top: 1px solid var(--border); margin: 4px 0; }
  .switcher-empty { padding: 10px; text-align: center; font-size: 11px; color: var(--text-3); }
  .switcher-item.manage { color: var(--text-2); }
</style>
