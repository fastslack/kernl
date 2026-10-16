<script lang="ts">
  // Settings → Integrations: the one place to link the Google account — its state,
  // the button that signs in (and comes back here), and the redirect URI the
  // Google Cloud OAuth client has to list.
  import { onMount } from 'svelte';
  import { locale } from '$lib/i18n/index.js';
  import { toast } from '$shared/feedback';

  type Status = {
    credentialsConfigured: boolean;
    status: 'connected' | 'needs_reauth' | 'disconnected';
    lastAuthError: string | null;
    redirectUri?: string;
  };
  let st: Status | null = null;
  let email = '';
  let busy = false;
  let copied = false;

  const TX = {
    en: {
      title: 'Google account', connected: 'Connected', needs_reauth: 'Expired', disconnected: 'Not connected',
      what: 'Contacts, Calendar, Tasks and Gmail sync through this account.',
      connect: 'Connect Google', reconnect: 'Reconnect Google', switch: 'Switch account',
      noCreds: 'First create an OAuth client in Google Cloud and paste its ID and secret in “Integration keys” below.',
      redirect: 'Redirect URI to register in Google Cloud', copy: 'Copy', copiedTx: 'Copied',
      linked: 'Google connected', failed: 'Google sign-in did not finish. Try again.', noLink: 'Google did not return a sign-in link',
      guide: 'Step-by-step guide',
    },
    es: {
      title: 'Cuenta de Google', connected: 'Conectado', needs_reauth: 'Vencido', disconnected: 'Sin conectar',
      what: 'Contactos, Calendario, Tareas y Gmail se sincronizan con esta cuenta.',
      connect: 'Conectar Google', reconnect: 'Reconectar Google', switch: 'Cambiar cuenta',
      noCreds: 'Primero creá un cliente OAuth en Google Cloud y pegá su ID y su secreto en «Claves de integración», acá abajo.',
      redirect: 'URI de retorno para registrar en Google Cloud', copy: 'Copiar', copiedTx: 'Copiada',
      linked: 'Google conectado', failed: 'No se completó la entrada a Google. Probá de nuevo.', noLink: 'Google no devolvió el enlace para entrar',
      guide: 'Guía paso a paso',
    },
  } as const;
  $: tx = TX[$locale === 'es' ? 'es' : 'en'];
  $: guideUrl = $locale === 'es' ? 'https://lifekernl.com/es/docs/connect-google' : 'https://lifekernl.com/docs/connect-google';
  $: tone = st?.status === 'connected' ? 'var(--teal)' : st?.status === 'needs_reauth' ? 'var(--red)' : 'var(--gold)';

  async function load() {
    try {
      const r = await fetch('/api/google/status');
      st = r.ok ? await r.json() : null;
      if (st?.status === 'connected') {
        const p = await fetch('/api/email-accounts/google-profile').then((x) => (x.ok ? x.json() : null)).catch(() => null);
        email = p?.email ?? '';
      }
    } catch { st = null; }
  }

  async function connect() {
    busy = true;
    try {
      const r = await fetch('/api/google/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true, return_to: window.location.href }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.error) { toast.error(String(d?.error ?? `HTTP ${r.status}`)); return; }
      if (d?.authUrl) { window.location.href = d.authUrl; return; }
      toast.error(tx.noLink);
    } finally { busy = false; }
  }

  async function copy() {
    if (!st?.redirectUri) return;
    try { await navigator.clipboard.writeText(st.redirectUri); copied = true; setTimeout(() => (copied = false), 1500); } catch { /* clipboard blocked: the URI is selectable */ }
  }

  onMount(() => {
    // Back from Google's consent screen.
    const u = new URL(window.location.href);
    const r = u.searchParams.get('google_auth');
    if (r) {
      u.searchParams.delete('google_auth'); u.searchParams.delete('error');
      history.replaceState(history.state, '', u.toString());
      if (r === 'success') toast.success(tx.linked); else toast.error(tx.failed);
    }
    void load();
  });
</script>

<div class="g-card" style="--tone: {tone}">
  <div class="g-top">
    <span class="g-name">{tx.title}</span>
    <span class="g-pill">{tx[st?.status ?? 'disconnected']}</span>
    {#if email}<span class="g-email">{email}</span>{/if}
    <span class="g-spacer"></span>
    {#if st && st.credentialsConfigured}
      {#if st.status === 'connected'}
        <button class="g-link" disabled={busy} on:click={connect}>{tx.switch}</button>
      {:else}
        <button class="btn-sm g-main" disabled={busy} on:click={connect}>{st.status === 'needs_reauth' ? tx.reconnect : tx.connect}</button>
      {/if}
    {/if}
  </div>
  <p class="g-what">{st && !st.credentialsConfigured ? tx.noCreds : tx.what}
    <a href={guideUrl} target="_blank" rel="noopener noreferrer">{tx.guide}</a></p>
  {#if st?.status === 'needs_reauth' && st.lastAuthError}<p class="g-err">{st.lastAuthError}</p>{/if}
  {#if st?.redirectUri}
    <div class="g-uri">
      <span class="g-uri-label">{tx.redirect}</span>
      <code>{st.redirectUri}</code>
      <button class="g-link" on:click={copy}>{copied ? tx.copiedTx : tx.copy}</button>
    </div>
  {/if}
</div>

<style>
  .g-card { border: 1px solid color-mix(in srgb, var(--tone) 45%, var(--border)); background: color-mix(in srgb, var(--tone) 8%, var(--surface-1));
    border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .g-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .g-name { font-size: 13px; font-weight: 700; color: var(--text-1); }
  .g-pill { font-size: 10px; font-weight: 700; border-radius: 999px; padding: 1px 8px; color: var(--tone);
    border: 1px solid color-mix(in srgb, var(--tone) 50%, transparent); background: color-mix(in srgb, var(--tone) 14%, transparent); }
  .g-email { font: 400 11px var(--font-mono); color: var(--text-2); }
  .g-spacer { flex: 1; }
  .g-main { border-color: var(--tone); }
  .g-link { background: none; border: 0; padding: 0 2px; color: var(--text-2); font-size: 11px; text-decoration: underline; cursor: pointer; }
  .g-link:hover { color: var(--text-1); }
  .g-what { margin: 0; font-size: 11px; color: var(--text-2); }
  .g-what a { color: var(--teal); }
  .g-err { margin: 0; font-size: 11px; color: var(--red); }
  .g-uri { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; }
  .g-uri-label { color: var(--text-3); }
  .g-uri code { font: 400 11px var(--font-mono); color: var(--text-1); background: var(--surface-2); border-radius: 4px; padding: 1px 6px; user-select: all; }
</style>
