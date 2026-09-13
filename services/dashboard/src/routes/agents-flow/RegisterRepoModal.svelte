<script lang="ts">
  /**
   * Register-repo modal — track an existing local checkout.
   *
   * Lifted out of AgentWorld3D verbatim. It owns its whole vertical slice: the
   * form state, the candidate scan, the focus trap and its styles. Nothing in
   * here touches the 3D scene, which is why it could leave at all.
   *
   * Two entry points call `open()` on this component: the floating "Register
   * Repo" button in the HQ overlay, and a click on a FREE server rack in the
   * Repos Office. Both go through the opener rather than flipping a flag, so
   * neither skips the candidate load or the focus handoff.
   *
   * `onRegistered` is awaited before the modal closes, which is what keeps the
   * old ordering: the rack flips from FREE to OCCUPIED *then* the form goes
   * away, never the other way round.
   */
  import { tick } from 'svelte';
  import { rpcPost } from '$lib/api.js';
  import { isAbsoluteHostPath, joinHostPath } from '$lib/host-path.js';

  /**
   * Run after `repos.register` succeeds and before the modal closes — the
   * parent refetches its bookmarks and rebuilds the scene here. Awaited, so a
   * slow rebuild holds the form open instead of closing over a stale floor.
   */
  export let onRegistered: (name: string) => void | Promise<void> = () => {};

  let showRegisterRepoModal = false;
  let registerRepoName = '';
  let registerRepoPath = '';
  let registerRepoDesc = '';
  let registerRepoTags = '';
  let registerRepoBusy = false;
  let registerRepoError = '';
  /** Which field the error belongs to, so it can sit under that field. */
  let registerRepoErrorField: 'name' | 'path' | '' = '';
  let registerRepoShared = true;
  let registerRepoAgents: string[] = [];
  // Checkouts the kernel can actually reach. The path used to be a free-text
  // box validated inside the container, so a real path on the operator's
  // machine failed with "does not exist" — true of the container, false of
  // them. Offering what it can see removes the guess.
  let repoCandidates: Array<{ path: string; name: string; registered: boolean }> = [];
  let repoRoots: string[] = [];
  let repoCandidatesLoading = false;
  let repoManualPath = false;
  let registerRepoDialog: HTMLDivElement | null = null;
  let registerRepoTrigger: HTMLElement | null = null;

  /** POST to repos.register via the RPC bus (mtw-request) with a REST
   *  fallback to /api/mtw. On success we hand back to the parent so it can
   *  refetch repos + force a scene rebuild before the form closes. */
  async function submitRegisterRepo(): Promise<void> {
    const name = registerRepoName.trim();
    const path = registerRepoPath.trim();
    if (!name) { registerRepoError = 'Name is required'; return; }
    if (!isAbsoluteHostPath(path)) { registerRepoError = 'Absolute path is required (e.g. /home/you/repo or C:\\code\\repo)'; return; }
    registerRepoBusy = true;
    registerRepoError = '';
    try {
      // Auto-registered RpcActions are reachable over the WS bus *and* at
      // POST /api/rpc/<action>; `rpcPost` takes whichever is up. The comment
      // that used to sit here claimed no HTTP route existed, which is how this
      // form ended up unusable whenever the bridge was down.
      const args: Record<string, unknown> = { name, path, shared: registerRepoShared };
      const desc = registerRepoDesc.trim(); if (desc) args.description = desc;
      const tags = registerRepoTags.trim(); if (tags) args.tags = tags;
      if (!registerRepoShared) args.agents = registerRepoAgents;
      await rpcPost('repos.register', args);
      // Success → refresh + rebuild so the rack flips from FREE to OCCUPIED.
      await onRegistered(name);
      closeRegisterRepoModal();
      registerRepoDone = `Registered ${name}.`;
      setTimeout(() => (registerRepoDone = ''), 4000);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      registerRepoError = msg;
      // Park the message under the field it is about. The server answers with
      // prose, so match on what it actually says rather than inventing codes.
      registerRepoErrorField = /name/i.test(msg) && !/path/i.test(msg) ? 'name' : 'path';
    } finally {
      registerRepoBusy = false;
    }
  }

  /** Success toast for the register flow — the modal used to just vanish. */
  let registerRepoDone = '';

  async function loadRepoCandidates(): Promise<void> {
    repoCandidatesLoading = true;
    try {
      const res: any = await rpcPost('repos.candidates', {});
      repoCandidates = res?.candidates ?? [];
      repoRoots = res?.roots ?? [];
      // Nothing to offer means the picker would be an empty box pretending to
      // be a choice; fall back to typing, with the roots named in the hint.
      if (repoCandidates.filter((c) => !c.registered).length === 0) repoManualPath = true;
    } catch {
      repoManualPath = true;
    } finally {
      repoCandidatesLoading = false;
    }
  }

  function onRepoAgentsInput(e: Event): void {
    const el = e.currentTarget as HTMLInputElement;
    registerRepoAgents = el.value.split(',').map((v) => v.trim()).filter(Boolean);
  }

  function pickCandidate(c: { path: string; name: string }): void {
    registerRepoPath = c.path;
    // Only prefill the name while it is untouched or still matches the last
    // pick — never clobber something the operator typed.
    if (!registerRepoName.trim() || repoCandidates.some((x) => x.name === registerRepoName)) {
      registerRepoName = c.name;
    }
    registerRepoError = '';
    registerRepoErrorField = '';
  }

  function closeRegisterRepoModal(): void {
    showRegisterRepoModal = false;
    // Focus goes back where it came from, or it lands on <body> and the next
    // Tab restarts from the top of the document.
    registerRepoTrigger?.focus?.();
    registerRepoTrigger = null;
  }

  /** Tab must not escape an open dialog. */
  function trapRepoModalKeys(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.stopPropagation(); closeRegisterRepoModal(); return; }
    if (e.key !== 'Tab' || !registerRepoDialog) return;
    const focusable = registerRepoDialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select, textarea, [href], [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /** The only way in. Both call sites in the world use it. */
  export function open(): void {
    registerRepoTrigger = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
    registerRepoError = '';
    registerRepoErrorField = '';
    registerRepoName = '';
    registerRepoPath = '';
    registerRepoDesc = '';
    registerRepoTags = '';
    registerRepoShared = true;
    registerRepoAgents = [];
    repoManualPath = false;
    repoCandidates = [];
    showRegisterRepoModal = true;
    void loadRepoCandidates();
    // Focus the dialog so Escape works before the first click. The handler
    // lives on the dialog, and keydown only reaches it from inside.
    void tick().then(() => registerRepoDialog?.focus());
  }
</script>

<!-- Escape and the focus trap live at the window, not on the dialog: the old
     modal put Escape on the overlay, which never received the event because
     nothing inside was focused when it opened. -->
<svelte:window on:keydown={(e) => showRegisterRepoModal && trapRepoModalKeys(e)} />

{#if showRegisterRepoModal}
  <div class="modal-overlay">
    <!-- Click-outside-to-close as a real button behind the dialog, rather
         than a listener on a presentational div. The old markup silenced the
         warning with role="button" on the overlay, which announces the whole
         backdrop as a button and wraps the dialog inside it. -->
    <button
      type="button"
      class="modal-backdrop-close"
      aria-label="Close"
      tabindex="-1"
      on:click={closeRegisterRepoModal}
    ></button>
    <div
      class="modal repo-modal"
      bind:this={registerRepoDialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="repo-modal-title"
      tabindex="-1"
    >
      <div class="modal-title" id="repo-modal-title">REGISTER REPO</div>
      <div class="modal-sub">Track an existing local checkout — files stay where they are.</div>

      <label class="modal-label" for="repo-name">
        Name <span class="modal-req" aria-hidden="true">*</span>
      </label>
      <input
        id="repo-name"
        type="text"
        class="modal-input"
        class:modal-input-bad={registerRepoErrorField === 'name'}
        placeholder="kernl"
        required
        aria-required="true"
        aria-invalid={registerRepoErrorField === 'name'}
        aria-describedby={registerRepoErrorField === 'name' ? 'repo-err' : undefined}
        bind:value={registerRepoName}
        disabled={registerRepoBusy}
      />
      {#if registerRepoErrorField === 'name'}
        <div class="modal-error" id="repo-err" role="alert">{registerRepoError}</div>
      {/if}

      <div class="modal-label" id="repo-path-label">
        Path <span class="modal-req" aria-hidden="true">*</span>
        <button
          type="button"
          class="repo-path-toggle"
          on:click={() => { repoManualPath = !repoManualPath; registerRepoError = ''; registerRepoErrorField = ''; }}
        >{repoManualPath ? 'pick from disk' : 'type it instead'}</button>
      </div>

      {#if repoManualPath}
        <input
          id="repo-path"
          type="text"
          class="modal-input"
          class:modal-input-bad={registerRepoErrorField === 'path'}
          placeholder={repoRoots.length ? joinHostPath(repoRoots[0], 'my-repo') : '/absolute/path/to/repo or C:\\code\\repo'}
          required
          aria-required="true"
          aria-labelledby="repo-path-label"
          aria-invalid={registerRepoErrorField === 'path'}
          bind:value={registerRepoPath}
          disabled={registerRepoBusy}
        />
        <p class="modal-hint modal-hint-block">
          {#if repoRoots.length}
            The kernel runs in a container and can only reach
            {#each repoRoots as r, i}<code>{r}</code>{i < repoRoots.length - 1 ? ', ' : ''}{/each}.
            A path outside that is invisible to it even though it exists on your machine.
          {:else}
            Absolute path, as the kernel sees it.
          {/if}
        </p>
      {:else if repoCandidatesLoading}
        <p class="modal-hint modal-hint-block">Scanning what the kernel can reach…</p>
      {:else if repoCandidates.length === 0}
        <!-- Never an empty box. An `{#each}` over nothing collapses a flex
             column to zero height, so a failed or empty scan rendered as a
             void between two labels — no list, no input, no explanation. -->
        <input
          id="repo-path"
          type="text"
          class="modal-input"
          placeholder={repoRoots.length ? joinHostPath(repoRoots[0], 'my-repo') : '/absolute/path/to/repo or C:\\code\\repo'}
          aria-labelledby="repo-path-label"
          bind:value={registerRepoPath}
          disabled={registerRepoBusy}
        />
        <p class="modal-hint modal-hint-block">
          No checkouts came back from the scan. Type the path as the kernel sees it{#if repoRoots.length} — it can only reach {#each repoRoots as r, i}<code>{r}</code>{i < repoRoots.length - 1 ? ', ' : ''}{/each}{/if}.
        </p>
      {:else}
        <div class="repo-cand-list" role="radiogroup" aria-labelledby="repo-path-label">
          {#each repoCandidates as c (c.path)}
            <button
              type="button"
              class="repo-cand"
              class:repo-cand-on={registerRepoPath === c.path}
              role="radio"
              aria-checked={registerRepoPath === c.path}
              disabled={c.registered || registerRepoBusy}
              title={c.registered ? 'Already registered' : c.path}
              on:click={() => pickCandidate(c)}
            >
              <span class="repo-cand-name">{c.name}</span>
              <span class="repo-cand-path">{c.path}</span>
              {#if c.registered}<span class="repo-cand-tag">registered</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
      {#if registerRepoErrorField === 'path'}
        <div class="modal-error" id="repo-err" role="alert">{registerRepoError}</div>
      {/if}

      <div class="modal-label" id="repo-scope-label">Who can use it</div>
      <div class="repo-scope" role="radiogroup" aria-labelledby="repo-scope-label">
        <button
          type="button" class="repo-scope-opt" class:repo-scope-on={registerRepoShared}
          role="radio" aria-checked={registerRepoShared} disabled={registerRepoBusy}
          on:click={() => (registerRepoShared = true)}
        >
          <span class="repo-scope-t">Any agent</span>
          <span class="repo-scope-s">Every office reaches it through the repo tools.</span>
        </button>
        <button
          type="button" class="repo-scope-opt" class:repo-scope-on={!registerRepoShared}
          role="radio" aria-checked={!registerRepoShared} disabled={registerRepoBusy}
          on:click={() => (registerRepoShared = false)}
        >
          <span class="repo-scope-t">Only chosen agents</span>
          <span class="repo-scope-s">Nobody else sees it, not even in a listing.</span>
        </button>
      </div>

      {#if !registerRepoShared}
        <label class="modal-label" for="repo-agents">
          Agents <span class="modal-hint">(comma-separated ids)</span>
        </label>
        <input
          id="repo-agents"
          type="text"
          class="modal-input"
          placeholder="agent-id-1, agent-id-2"
          value={registerRepoAgents.join(', ')}
          on:input={onRepoAgentsInput}
          disabled={registerRepoBusy}
        />
        {#if registerRepoAgents.length === 0}
          <p class="modal-hint modal-hint-block modal-hint-warn">
            With nobody named, this repo is reachable by no agent at all.
          </p>
        {/if}
      {/if}

      <label class="modal-label" for="repo-desc">Description <span class="modal-hint">(optional)</span></label>
      <input id="repo-desc" type="text" class="modal-input" bind:value={registerRepoDesc} disabled={registerRepoBusy} />

      <label class="modal-label" for="repo-tags">Tags <span class="modal-hint">(optional, comma-separated)</span></label>
      <input id="repo-tags" type="text" class="modal-input" placeholder="ts, monorepo, infra" bind:value={registerRepoTags} disabled={registerRepoBusy} />

      {#if registerRepoError && !registerRepoErrorField}
        <div class="modal-error" role="alert">{registerRepoError}</div>
      {/if}

      <div class="modal-actions">
        <button class="modal-cancel" on:click={closeRegisterRepoModal} disabled={registerRepoBusy}>Cancel</button>
        <button
          class="modal-confirm repo-modal-confirm"
          on:click={submitRegisterRepo}
          disabled={registerRepoBusy || !registerRepoName.trim() || !registerRepoPath.trim()}
        >
          {registerRepoBusy ? 'Registering…' : 'Register'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if registerRepoDone}
  <div class="repo-toast" role="status" aria-live="polite">{registerRepoDone}</div>
{/if}

<style>
  /* ── Modal ────────────────────
     The generic `.modal-*` rules are duplicated from AgentWorld3D rather than
     shared: Svelte scopes styles per component, so a rule left behind in the
     parent simply stops applying here. The parent keeps its own copy because
     four other modals still use them. */
  .modal-overlay{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center}
  .modal{background:#0e1018;border:1px solid rgba(74,79,106,.4);border-radius:16px;padding:24px;width:420px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.6);animation:mslide .2s ease-out}
  @keyframes mslide{from{transform:translateY(12px);opacity:0}}
  .modal-title{font:700 16px 'Syne',sans-serif;color:var(--text-1,#e0e2ea);margin-bottom:4px}
  .modal-sub{font:400 11px 'Manrope',sans-serif;color:var(--text-3,#4a4f6a);margin-bottom:16px;line-height:1.4}
  .modal-label{display:block;font:600 9px 'Manrope',sans-serif;color:var(--text-3,#4a4f6a);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
  .modal-input{display:block;width:100%;margin-top:5px;padding:8px 12px;border-radius:8px;background:#141620;border:1px solid rgba(74,79,106,.3);color:var(--text-1,#e0e2ea);font:400 13px 'Manrope',sans-serif;outline:none;box-sizing:border-box}
  .modal-input:focus{border-color:#6366f1}
  .modal-error{font:500 11px 'Manrope',sans-serif;color:#ef4444;background:rgba(239,68,68,.1);padding:6px 10px;border-radius:6px;margin-bottom:8px}
  .modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  .modal-cancel{padding:8px 18px;border-radius:8px;font:600 11px 'Manrope',sans-serif;background:#1a1d2a;border:1px solid rgba(74,79,106,.3);color:var(--text-2,#8a8fa8);cursor:pointer;transition:all .15s}
  .modal-cancel:hover{background:#22253a}
  .modal-confirm{padding:8px 18px;border-radius:8px;font:600 11px 'Syne',sans-serif;letter-spacing:.5px;background:#10b981;border:none;color:#fff;cursor:pointer;transition:all .15s}
  .modal-confirm:hover{filter:brightness(1.1)}
  .modal-confirm:disabled{opacity:.4;cursor:not-allowed}

  /* ── Register-Repo modal (data-center amber accent) ── */
  .repo-modal{border:1px solid #ffb84a40;box-shadow:0 20px 60px rgba(0,0,0,.6),0 0 24px rgba(255,184,74,.08)}
  .repo-modal .modal-title{color:#ffb84a;letter-spacing:3px;text-shadow:0 0 8px #ffb84a30}
  /* Backdrop as a real element behind the dialog, not a role on the wrapper. */
  /* The backdrop is absolutely positioned, and `.modal` is static — so without
     a stacking context of its own the backdrop paints OVER the dialog and
     swallows every click inside it. That is not a style nicety: it made the
     form close on any click at all. */
  .modal-backdrop-close{position:absolute;inset:0;border:0;background:transparent;cursor:default;padding:0;z-index:0}
  .repo-modal{position:relative;z-index:1}
  .modal-req{color:#e8734a;margin-left:2px}
  .modal-input-bad{border-color:#e8734a !important}
  .modal-hint-block{display:block;margin:4px 0 0;font:400 11px/1.5 'Manrope',sans-serif;color:#8a8fa8}
  .modal-hint-block code{font-family:'Geist Mono',monospace;color:#cbd0e8}
  .modal-hint-warn{color:#e8b04a}
  .repo-path-toggle{margin-left:8px;border:0;background:transparent;color:#7fb2ff;font:400 11px/1 'Manrope',sans-serif;cursor:pointer;text-decoration:underline}
  /* The candidate list is the primary control now, so it gets room to be read
     and a scroll of its own rather than pushing the actions off-screen. */
  .repo-cand-list{display:flex;flex-direction:column;gap:4px;max-height:180px;overflow-y:auto;margin-top:4px}
  .repo-cand{display:flex;align-items:baseline;gap:8px;width:100%;text-align:left;padding:7px 9px;border:1px solid rgba(255,255,255,.08);border-radius:6px;background:rgba(255,255,255,.02);cursor:pointer;transition:border-color .12s,background .12s}
  .repo-cand:hover:not(:disabled){border-color:rgba(127,178,255,.5);background:rgba(127,178,255,.07)}
  .repo-cand-on{border-color:#7fb2ff;background:rgba(127,178,255,.12)}
  .repo-cand:disabled{opacity:.45;cursor:not-allowed}
  .repo-cand-name{font:600 12px/1 'Manrope',sans-serif;color:#e6e9f5;flex-shrink:0}
  .repo-cand-path{font:400 10px/1.3 'Geist Mono',monospace;color:#8a8fa8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  .repo-cand-tag{font:600 9px/1 'Manrope',sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#8a8fa8;flex-shrink:0}
  .repo-scope{display:flex;gap:6px;margin-top:4px}
  .repo-scope-opt{flex:1;display:flex;flex-direction:column;gap:2px;text-align:left;padding:8px 10px;border:1px solid rgba(255,255,255,.08);border-radius:6px;background:rgba(255,255,255,.02);cursor:pointer;transition:border-color .12s,background .12s}
  .repo-scope-opt:hover:not(:disabled){border-color:rgba(127,178,255,.5)}
  .repo-scope-on{border-color:#7fb2ff;background:rgba(127,178,255,.12)}
  .repo-scope-t{font:600 12px/1.2 'Manrope',sans-serif;color:#e6e9f5}
  .repo-scope-s{font:400 10px/1.4 'Manrope',sans-serif;color:#8a8fa8}
  /* Success used to be "the modal disappears", which reads the same as a
     silent failure. */
  .repo-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:1400;padding:9px 16px;border-radius:8px;background:rgba(20,24,31,.96);border:1px solid rgba(127,255,178,.3);color:#9ff5c4;font:500 12px/1 'Manrope',sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45)}
  .repo-modal-confirm{background:#ffb84a;color:#1a1410}
  .repo-modal-confirm:hover{filter:brightness(1.08)}
  .modal-hint{color:#7a7a7a;font-weight:400;text-transform:none;letter-spacing:0}
</style>
