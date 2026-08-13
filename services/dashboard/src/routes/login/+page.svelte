<script lang="ts">
  // Token-paste login page. Bridges the gap between the legacy
  // KERNEL_AUTH_TOKEN bearer and the upcoming OAuth2 flow — same URL
  // (/login) will host the "Continue with Google" button when stage 1
  // of the auth-oauth roadmap lands.
  import { onMount } from 'svelte';
  import { t, initLocale } from '$lib/i18n';
  import LangToggle from '$lib/components/LangToggle.svelte';
  import { tokenFromHash } from '$lib/boot-token';

  const TOKEN_KEY = 'kernel_auth_token';
  let token = '';
  let busy = false;
  let error = '';
  let next = '/';

  onMount(() => {
    initLocale();
    const url = new URL(window.location.href);
    next = url.searchParams.get('next') || '/';

    // First run from a desktop launcher: the token the kernel generated for
    // this install arrives in the fragment. Take it, wipe it from the URL
    // (fragments stick in history), and sign in without making the user hunt
    // for a secret they were never shown.
    const handed = tokenFromHash(window.location.hash);
    if (handed) {
      token = handed;
      history.replaceState(null, '', url.pathname + url.search);
      void save();
      return;
    }

    // Pre-fill if a stale token is already in localStorage so the user
    // can see what's there and edit instead of re-paste blindly.
    token = localStorage.getItem(TOKEN_KEY) ?? '';
  });

  async function save() {
    if (busy) return;
    error = '';
    const tok = token.trim();
    if (!tok) { error = $t('login.error_empty'); return; }
    busy = true;
    // Verify against the kernel before saving — surfaces "wrong token"
    // before the user navigates away and is greeted by a broken page.
    try {
      const r = await fetch('/api/auth/verify', {
        headers: { Authorization: 'Bearer ' + tok },
      });
      const body = await r.json().catch(() => ({} as any));
      if (!r.ok || body.valid !== true) {
        error = $t('login.error_rejected');
        busy = false;
        return;
      }
      localStorage.setItem(TOKEN_KEY, tok);
      // Hard navigation so every page state resets and the fetch
      // interceptor in +layout.svelte picks the fresh token from
      // localStorage on the next request cycle.
      window.location.href = next;
    } catch {
      error = $t('login.error_unreachable');
      busy = false;
    }
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    error = '';
  }
</script>

<svelte:head><title>Kernl · login</title></svelte:head>

<main class="login-shell">
  <div class="login-card">
    <header>
      <div class="header-row">
        <h1>Kernl</h1>
        <LangToggle variant="minimal" />
      </div>
      <p class="dim">{$t('login.subtitle')}</p>
    </header>

    <label class="field">
      <span class="dim">KERNEL_AUTH_TOKEN</span>
      <input
        type="password"
        bind:value={token}
        placeholder={$t('login.token_placeholder')}
        autocomplete="off"
        spellcheck="false"
        on:keydown={(e) => { if (e.key === 'Enter') save(); }}
        disabled={busy}
      />
    </label>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <div class="row">
      <button class="primary" on:click={save} disabled={busy}>
        {busy ? $t('login.button_verifying') : $t('login.button_save')}
      </button>
      <button class="ghost" on:click={clearToken} disabled={busy}>{$t('login.button_clear')}</button>
    </div>

    <footer class="dim">
      <p>{$t('login.tip_host')}<code>cat data/.kernel-auth-token</code></p>
      <p>{$t('login.tip_docker')}<code>docker compose exec kernel cat /app/data/.kernel-auth-token</code></p>
      <p class="hint">{$t('login.tip_oauth')}</p>
    </footer>
  </div>
</main>

<style>
  .login-shell {
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: var(--bg, #07080C);
    color: var(--green, #B5D4A1);
    font-family: ui-monospace, 'Geist Mono', 'Fira Code', monospace;
    padding: 24px;
  }
  .login-card {
    width: 100%;
    max-width: 440px;
    border: 1px solid var(--line, #2A3038);
    border-radius: 4px;
    padding: 28px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    background: rgba(15, 18, 24, 0.75);
    box-shadow: 0 0 32px rgba(0,0,0,0.4);
  }
  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  header h1 {
    font-size: 18px;
    margin: 0 0 4px;
    letter-spacing: 0.06em;
    color: var(--amber, #FFB74D);
  }
  header p { margin: 0; font-size: 12px; }
  .dim { color: var(--green-dim, #6F8A60); }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; }
  .field input {
    background: #0B0D12;
    border: 1px solid var(--line, #2A3038);
    color: var(--green, #B5D4A1);
    padding: 10px 12px;
    border-radius: 3px;
    font: inherit;
    font-size: 13px;
    letter-spacing: 0.5px;
  }
  .field input:focus {
    outline: none;
    border-color: var(--amber, #FFB74D);
    box-shadow: 0 0 0 1px var(--amber, #FFB74D);
  }
  .error {
    border: 1px solid #ff6464;
    color: #ff8888;
    background: rgba(255,100,100,0.08);
    padding: 8px 12px;
    border-radius: 3px;
    font-size: 12px;
  }
  .row { display: flex; gap: 8px; }
  .row button {
    flex: 1;
    padding: 10px 14px;
    background: none;
    border: 1px solid var(--line, #2A3038);
    color: var(--green, #B5D4A1);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    border-radius: 3px;
  }
  .row button.primary { background: var(--amber, #FFB74D); color: #0B0D12; border-color: var(--amber, #FFB74D); }
  .row button.primary:hover:not(:disabled) { filter: brightness(1.1); }
  .row button.ghost:hover:not(:disabled) { color: var(--amber, #FFB74D); border-color: var(--amber, #FFB74D); }
  .row button:disabled { opacity: 0.5; cursor: not-allowed; }
  footer { font-size: 10px; line-height: 1.6; }
  footer p { margin: 0; }
  footer code { background: #0B0D12; padding: 1px 5px; border-radius: 2px; }
  .hint { margin-top: 6px !important; font-style: italic; }
</style>
