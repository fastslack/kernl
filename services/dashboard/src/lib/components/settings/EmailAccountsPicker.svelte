<!--
  EmailAccountsPicker — the value of a settings field with
  `source: "email_accounts"`: a comma-separated list of addresses.

  The mail accounts configured in Kernl are offered as toggles, so the usual
  choice is a click instead of typing an address. Addresses outside Kernl
  (a teammate, a phone's mail app) still fit: they are added by hand and show
  as removable chips. The stored value keeps the plain "a@x, b@y" shape the
  extension reads, so nothing downstream changes.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n/index.js';

  export let value = '';
  export let disabled = false;
  export let id = '';

  interface Account { id: string; label: string; email: string; provider: string }

  let accounts: Account[] = [];
  let loading = true;
  let failed = false;
  let draft = '';
  let draftError = false;

  const norm = (s: string) => {
    const m = /<([^>]+)>/.exec(s);
    return (m ? m[1] : s).trim().toLowerCase();
  };
  const parse = (v: string) => [...new Set(v.split(/[,;\s]+/).map(norm).filter((a) => a.includes('@')))];

  $: selected = parse(value);
  $: known = new Set(accounts.map((a) => norm(a.email)));
  $: extras = selected.filter((a) => !known.has(a));

  function write(list: string[]) {
    value = list.join(', ');
  }

  function toggle(email: string) {
    const e = norm(email);
    write(selected.includes(e) ? selected.filter((a) => a !== e) : [...selected, e]);
  }

  function remove(email: string) {
    write(selected.filter((a) => a !== email));
  }

  function addDraft() {
    const e = norm(draft);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      draftError = true;
      return;
    }
    if (!selected.includes(e)) write([...selected, e]);
    draft = '';
    draftError = false;
  }

  onMount(async () => {
    try {
      const r = await fetch('/api/email-accounts', { headers: { 'Content-Type': 'application/json' } });
      if (!r.ok) throw new Error(String(r.status));
      const rows = (await r.json()) as Account[];
      accounts = Array.isArray(rows) ? rows.filter((a) => a?.email) : [];
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  });
</script>

<div class="eap" {id}>
  {#if loading}
    <span class="eap-note">{$t('settings.emailPicker.loading')}</span>
  {:else if failed}
    <span class="eap-note">{$t('settings.emailPicker.failed')}</span>
  {:else if accounts.length === 0}
    <span class="eap-note">
      {$t('settings.emailPicker.none')}
      <a href="/settings?section=mail">{$t('settings.emailPicker.connect')}</a>
    </span>
  {:else}
    <div class="eap-accounts" role="group" aria-label={$t('settings.emailPicker.accounts')}>
      {#each accounts as a (a.id)}
        {@const on = selected.includes(norm(a.email))}
        <button
          type="button"
          class="eap-acc"
          class:on
          aria-pressed={on}
          {disabled}
          title={a.label && a.label !== a.email ? `${a.label} — ${a.email}` : a.email}
          on:click={() => toggle(a.email)}
        >
          <span class="eap-check" aria-hidden="true">{on ? '✓' : ''}</span>
          {a.email}
        </button>
      {/each}
    </div>
  {/if}

  {#if extras.length}
    <div class="eap-extras">
      {#each extras as e (e)}
        <span class="eap-chip">
          {e}
          <button type="button" {disabled} aria-label={$t('settings.emailPicker.remove', { email: e })} on:click={() => remove(e)}>×</button>
        </span>
      {/each}
    </div>
  {/if}

  <form class="eap-add" on:submit|preventDefault={addDraft}>
    <input
      type="email"
      placeholder={$t('settings.emailPicker.other')}
      bind:value={draft}
      on:input={() => (draftError = false)}
      class:err={draftError}
      {disabled}
    />
    <button type="submit" disabled={disabled || !draft.trim()}>{$t('settings.emailPicker.add')}</button>
  </form>
</div>

<style>
  .eap { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .eap-note { font-size: 11px; color: var(--text-3); }
  .eap-note a { color: var(--teal); }
  /* Chips that wrap: an install with a dozen accounts still fits in a few lines. */
  .eap-accounts { display: flex; flex-wrap: wrap; gap: 4px; }
  .eap-acc {
    display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px 3px 5px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2);
    font: 400 10.5px var(--font-mono); cursor: pointer; max-width: 100%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .eap-acc:hover:not(:disabled) { border-color: var(--teal); color: var(--text-1); }
  .eap-acc.on { border-color: var(--teal); color: var(--text-1); background: color-mix(in srgb, var(--teal) 14%, var(--surface-2)); }
  .eap-acc:disabled { opacity: 0.5; cursor: default; }
  .eap-check {
    flex-shrink: 0; width: 11px; height: 11px; border-radius: 50%; border: 1px solid var(--border);
    display: grid; place-items: center; font-size: 8px; color: var(--teal);
  }
  .eap-acc.on .eap-check { border-color: var(--teal); }
  .eap-extras { display: flex; flex-wrap: wrap; gap: 4px; }
  .eap-chip {
    display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; border-radius: 10px;
    font: 400 10px var(--font-mono); background: var(--surface-2); border: 1px solid var(--border); color: var(--text-1);
  }
  .eap-chip button {
    border: none; background: none; color: var(--text-3); cursor: pointer; font-size: 12px; line-height: 1; padding: 0 2px;
  }
  .eap-chip button:hover:not(:disabled) { color: #ef4444; }
  .eap-add { display: flex; gap: 4px; }
  .eap-add input {
    flex: 1; min-width: 0; padding: 5px 8px; border-radius: 6px; font-size: 11px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    font-family: var(--font-body); outline: none;
  }
  .eap-add input:focus { border-color: var(--teal); }
  .eap-add input.err { border-color: #ef4444; }
  .eap-add button {
    padding: 5px 10px; border-radius: 6px; font-size: 11px; cursor: pointer;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1); font-family: var(--font-body);
  }
  .eap-add button:disabled { opacity: 0.5; cursor: default; }
</style>
