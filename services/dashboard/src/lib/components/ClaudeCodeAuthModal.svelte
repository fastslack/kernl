<script lang="ts">
  /**
   * Sign in to Claude Code from inside Kernl.
   *
   * The CLI's own flow is a terminal TUI, which is unreachable when the kernel
   * runs in a container. The kernel lends it a PTY and scrapes the OAuth URL;
   * this dialog is the two halves the operator sees — open the link, paste the
   * code back.
   *
   * The pasted-token route below is not a lesser fallback: on hosts that cannot
   * allocate a PTY at all it is the only way in, so it is always offered rather
   * than hidden behind a failure.
   */
  import { createEventDispatcher } from 'svelte';

  export let open = false;

  const dispatch = createEventDispatcher<{ close: void; changed: void }>();

  interface AuthStatus {
    loggedIn: boolean;
    authMethod: string;
    cliFound: boolean;
    interactiveLogin: boolean;
    configDir: string;
  }

  let status: AuthStatus | null = null;
  let loading = false;
  /** Dialog-level only: reading the status, or starting the sign-in flow.
   *  A rejected paste is NOT one of these — see codeError / tokenError. */
  let error = '';
  /** Errors belong beside the field that produced them. Sharing one slot put a
   *  rejected paste directly under the green "Signed in" line, which reads as
   *  "your session is broken" when the session was never touched: the shape
   *  check in saveToken returns before it writes anything. */
  let codeError = '';
  let tokenError = '';
  let notice = '';
  let sessionId = '';
  let loginUrl = '';
  let code = '';
  let token = '';
  let busy = false;

  const H = { 'Content-Type': 'application/json' };

  /** Read the body even on failure — the kernel puts the reason in `error`. */
  async function call(url: string, body?: unknown): Promise<any> {
    const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: H, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
  }

  export async function refresh(): Promise<void> {
    loading = true;
    error = '';
    try {
      status = await call('/api/llm/claude-code/auth');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $: if (open && !status && !loading) refresh();

  async function startLogin(): Promise<void> {
    busy = true; error = ''; codeError = ''; tokenError = ''; notice = ''; loginUrl = ''; code = '';
    try {
      const s = await call('/api/llm/claude-code/auth/login', {});
      sessionId = s.id;
      loginUrl = s.url;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function sendCode(): Promise<void> {
    if (!code.trim()) return;
    busy = true; codeError = '';
    try {
      const r = await call('/api/llm/claude-code/auth/code', { session: sessionId, code });
      status = r.status;
      loginUrl = ''; sessionId = ''; code = '';
      notice = 'Signed in. Claude Code is ready to use.';
      dispatch('changed');
    } catch (e) {
      codeError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function saveToken(): Promise<void> {
    if (!token.trim()) return;
    busy = true; tokenError = '';
    try {
      const r = await call('/api/llm/claude-code/auth/token', { token });
      status = r.status;
      token = '';
      notice = 'Token accepted. Claude Code is ready to use.';
      dispatch('changed');
    } catch (e) {
      tokenError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function close(): void {
    // Abandon a half-finished flow so no CLI process is left waiting.
    if (sessionId) void call('/api/llm/claude-code/auth/cancel', { session: sessionId }).catch(() => {});
    sessionId = ''; loginUrl = ''; code = ''; error = ''; notice = '';
    dispatch('close');
  }
</script>

{#if open}
  <div class="backdrop" role="presentation" on:click={close}>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Claude Code sign-in" on:click|stopPropagation>
      <header>
        <h2>Claude Code</h2>
        <button class="x" on:click={close} aria-label="Close">×</button>
      </header>

      {#if loading}
        <p class="dim">Checking…</p>
      {:else if status}
        <div class="state" class:ok={status.loggedIn}>
          <span class="dot"></span>
          {#if status.loggedIn}
            Signed in <span class="dim">({status.authMethod})</span>
          {:else if !status.cliFound}
            The Claude Code CLI was not found on this host
          {:else}
            Not signed in
          {/if}
        </div>

        <p class="dim path">Credentials are stored in <code>{status.configDir}</code>, which survives a rebuild.</p>

        {#if notice}<p class="ok-msg">{notice}</p>{/if}
        {#if error}<p class="err">{error}</p>{/if}

        {#if status.cliFound}
          {#if status.interactiveLogin}
            <section>
              <h3>Sign in here</h3>
              {#if !loginUrl}
                <button class="primary" on:click={startLogin} disabled={busy}>
                  {busy ? 'Starting…' : status.loggedIn ? 'Sign in again' : 'Sign in'}
                </button>
              {:else}
                <ol class="steps">
                  <li>
                    Open this link and authorise:
                    <a href={loginUrl} target="_blank" rel="noopener noreferrer">{loginUrl}</a>
                  </li>
                  <li>
                    Paste the code it gives you:
                    <div class="row">
                      <input bind:value={code} placeholder="verification code" spellcheck="false" />
                      <button class="primary" on:click={sendCode} disabled={busy || !code.trim()}>
                        {busy ? 'Verifying…' : 'Finish'}
                      </button>
                    </div>
                    {#if codeError}<p class="err field-err">{codeError}</p>{/if}
                  </li>
                </ol>
              {/if}
            </section>
          {:else}
            <p class="dim">
              This host cannot open a terminal for the sign-in flow, so use a token below.
            </p>
          {/if}

          <section>
            <h3>Or paste a token</h3>
            <p class="dim">
              Run <code>claude setup-token</code> on any machine where you are signed in, then paste the
              result. This is not the verification code from the sign-in link above — a token starts
              with <code>sk-ant-</code>.
            </p>
            <div class="row">
              <input bind:value={token} placeholder="sk-ant-oat01-…" spellcheck="false" type="password" />
              <button on:click={saveToken} disabled={busy || !token.trim()}>Save</button>
            </div>
            {#if tokenError}
              <p class="err field-err">{tokenError}</p>
              {#if status.loggedIn}
                <!-- The shape check runs before anything is written, so a
                     rejected paste cannot have logged you out. Say so, because
                     a red message under a green status reads otherwise. -->
                <p class="dim field-err">Nothing changed — you are still signed in.</p>
              {/if}
            {/if}
          </section>
        {/if}
      {:else if error}
        <p class="err">{error}</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
    display: flex; align-items: center; justify-content: center; z-index: 900; padding: 20px;
  }
  .modal {
    background: var(--surface-1, #16181d); border: 1px solid var(--border, #2a2e37);
    border-radius: 12px; width: min(560px, 100%); max-height: 90vh; overflow-y: auto;
    padding: 20px 22px; color: var(--text-1, #e6e8ec); font-size: 13px;
  }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  h2 { margin: 0; font-size: 15px; font-weight: 650; }
  h3 { margin: 0 0 6px; font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-2, #9aa1ad); }
  .x { background: none; border: 0; color: var(--text-2, #9aa1ad); font-size: 20px; line-height: 1; cursor: pointer; }
  .state { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--amber, #d99a2b); flex: none; }
  .state.ok .dot { background: var(--green, #3fb950); }
  .dim { color: var(--text-2, #9aa1ad); }
  .path { margin: 0 0 14px; font-size: 12px; }
  code { background: var(--surface-2, #1f2229); padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
  section { border-top: 1px solid var(--border, #2a2e37); padding-top: 14px; margin-top: 14px; }
  .steps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 10px; }
  .steps a { color: var(--teal, #2dd4bf); word-break: break-all; }
  .row { display: flex; gap: 8px; margin-top: 6px; }
  input {
    flex: 1; min-width: 0; background: var(--surface-2, #1f2229); color: var(--text-1, #e6e8ec);
    border: 1px solid var(--border, #2a2e37); border-radius: 6px; padding: 7px 9px; font-size: 12.5px;
  }
  button {
    background: var(--surface-2, #1f2229); color: var(--text-1, #e6e8ec);
    border: 1px solid var(--border, #2a2e37); border-radius: 6px;
    padding: 7px 13px; font-size: 12.5px; font-weight: 600; cursor: pointer;
  }
  button.primary { background: var(--teal, #2dd4bf); border-color: transparent; color: #04211d; }
  button:disabled { opacity: 0.5; cursor: default; }
  .err { color: var(--red, #f85149); margin: 8px 0 0; }
  /* Sits with the input that produced it, not up beside the session status. */
  .field-err { margin: 6px 0 0; font-size: 12px; line-height: 1.45; }
  .ok-msg { color: var(--green, #3fb950); margin: 8px 0 0; }
</style>
