<!--
  AgentDrawer — el detalle de un agente, en un solo lugar.

  Vivía dentro de AgentWorld3D.svelte, que tenía 12.458 líneas y contenía el
  mundo 3D y este panel a la vez. Extraído para que /agents monte exactamente
  el mismo drawer en vez de mantener su propia versión más pobre: hoy lo único
  que las dos superficies comparten es el panel de skills.

  El drawer es dueño de su agente (ver stores/agent-detail.ts). Quien lo monta
  pasa un id y, si lo tiene a mano, la fila de lista para pintar sin esperar.

  Este primer paso saca SOLO el shell: cabecera, fila de acciones y barra de
  tabs. El cuerpo de cada tab sigue viviendo en quien monta el drawer y entra
  por un slot con nombre, así conserva el scope del padre y sigue leyendo
  `selData`, `agentDetail`, `selChains`… sin recablear nada. Tasks 9-13 los
  van mudando de a uno.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { createAgentDetailStore } from '$lib/stores/agent-detail.js';
  // Directo a types.js y no a office3d/index.js: el índice arrastra three.js
  // entero, y de acá sólo salen tres helpers puros.
  import { agentType, modelChainFallbacks, CLAUDE_CODE_DEFAULT_MODEL } from '../../../routes/agents-flow/office3d/types.js';

  const dispatch = createEventDispatcher();

  export let agentId: string;
  /** Fila que el mundo ya tiene, para pintar sin esperar el fetch. */
  export let listRow: any = null;
  /** Oficina del agente — pinta el acento del panel y el chip del header. */
  export let flow: { id?: string; name?: string; color?: string } | null = null;
  /** Tabs extra que aporta una extensión (panelTabRegistry). */
  export let extraTabs: Array<{ id: string; label: string }> = [];
  /** Reservado para el montaje embebido de /agents (Task 13). Hoy no cambia nada. */
  export let compact = false;

  // ── Estado que sigue siendo de quien monta el drawer ──────────────
  // Las escrituras (run, pause/resume, rename, revisión) las sigue haciendo el
  // padre, porque además de pegarle a la API tiene que repintar el nodo 3D y
  // refrescar su propia lista. El shell sólo muestra en qué anda cada una y
  // avisa por evento cuando el usuario pide algo.
  export let running = false;
  export let historyCount = 0;
  export let workspaceCount = 0;
  export let starting = false;
  export let startMsg = '';
  export let togglingPause = false;
  export let revisionBusy = false;
  export let savingName = false;
  export let editingName = false;
  export let editNameValue = '';

  // ── Tab activo ────────────────────────────────────────────────────
  // Vive acá; el padre lo espeja con bind: porque todavía decide el tab
  // inicial (live si el agente está corriendo, o el ?tab= del deep-link) y
  // consulta cuál está abierto cuando llega el fin de un run.
  export let panelTab: 'info' | 'live' | 'history' | 'memory' | 'chat' | 'workspace' | (string & {}) = 'info';

  function selectTab(tab: typeof panelTab) {
    panelTab = tab;
    dispatch('tab', { tab });
  }

  // ── El agente ─────────────────────────────────────────────────────
  // El store se recrea cuando cambia el id: la instancia del drawer sobrevive
  // al cambio de selección en el mundo 3D, y un store atado al id anterior
  // escribiría sobre el agente equivocado.
  //
  // Ojo: NO se llama a reload() todavía. El shell no muestra ningún campo que
  // sólo traiga GET /api/agents/:id, y en mergeAgent() la fila de detalle le
  // gana a la de lista — así que un detalle cacheado se quedaría pegado
  // mostrando `active` viejo después de un Pause/Resume, que hoy se ve al
  // instante. Tasks 9-13 lo encienden cuando muden los cuerpos que sí
  // necesitan el detalle (prompt, triggers, schedules).
  //
  // `onPatched` is how a write inside the drawer reaches the surface that
  // mounted it. The 3D world paints each agent's node from its own list; a
  // provider changed in RuntimeSection would otherwise stay invisible out
  // there until the next full refetch. Raised only when the write landed.
  const newStore = (id: string) =>
    createAgentDetailStore(id, { onPatched: (agent) => dispatch('changed', { agent }) });

  let detail = newStore(agentId);
  let storeFor = agentId;
  $: if (agentId !== storeFor) {
    storeFor = agentId;
    detail = newStore(agentId);
  }
  $: if (listRow) detail.seed(listRow);
  $: agent = $detail.agent ?? listRow;

  // El circuit breaker de AgentService.recordRunOutcome() estampa estos tres
  // cuando es el kernel el que frena al agente. `active === 0` solo no
  // distingue eso de una pausa pedida por el operador: la marca sí.
  $: autoPaused = !!agent && agent.active !== 1 && !!(agent.auto_paused_at || '');
  $: autoPausedAgo = autoPaused ? sinceLabel(agent?.auto_paused_at ?? '') : '';
  // Phase 4 (B): DevOps affordance — is the selected agent part of a DevOps/Repos
  // office? If so, offer a deep-link to the paid DevOps control panel (/devops).
  $: devopsOffice = /^(devops|repos)/i.test(flow?.name || '');

  /** "3h ago" / "2d ago" — coarse on purpose; the exact stamp is in the title. */
  function sinceLabel(iso: string): string {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  // Clipboard — shows a brief "copied" flash on the triggering button
  let copiedKey: string | null = null;
  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedKey = key;
      setTimeout(() => { if (copiedKey === key) copiedKey = null; }, 1200);
    } catch {
      copiedKey = key + ':err';
      setTimeout(() => { copiedKey = null; }, 1200);
    }
  }

  /** ¿El tab abierto lo aporta una extensión? Decide si se pinta el slot extra. */
  $: extraTabOpen = extraTabs.some((t) => t.id === panelTab);
</script>

  {#if agent}
    <div class="info-panel" class:ip-compact={compact} style={flow?.color ? `--flow-color:${flow.color}` : ''}>
      <!-- Header: type glyph + name + role + close -->
      <div class="ip-head">
        <div class="ip-head-left">
          <div class="ip-glyph">{agentType(agent) === 'llm' ? '◆' : agentType(agent) === 'claude_code' ? '◇' : agentType(agent) === 'function' ? '▣' : '▲'}</div>
          <div class="ip-head-txt">
            {#if editingName}
              <div class="ip-name-edit">
                <!-- svelte-ignore a11y-autofocus -->
                <input
                  type="text"
                  class="ip-name-input"
                  bind:value={editNameValue}
                  autofocus
                  disabled={savingName}
                  on:keydown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); dispatch('rename-save'); }
                    else if (e.key === 'Escape') { e.preventDefault(); dispatch('rename-cancel'); }
                  }}
                />
                <button class="ip-name-btn ip-name-btn-ok" title="Save (Enter)"
                  on:click={() => dispatch('rename-save')} disabled={savingName}>✓</button>
                <button class="ip-name-btn ip-name-btn-cancel" title="Cancel (Esc)"
                  on:click={() => dispatch('rename-cancel')} disabled={savingName}>×</button>
              </div>
            {:else}
              <div class="ip-name">
                {agent.name}
                <button class="ip-name-edit-btn" title="Rename agent" on:click={() => dispatch('rename-begin')}>✎</button>
              </div>
            {/if}
            <div class="ip-sub">
              {#if flow}<span class="ip-flow" style="--f:{flow.color}">{flow.name}</span>{/if}
              <span class="ip-dot"></span>
              <span class="ip-id" title="agent id">
                {agent.id.slice(0, 8)}
                <button class="ip-copy-inline" on:click|stopPropagation={() => copy(agent.id, 'agent-id')} title="copy full agent id">{copiedKey === 'agent-id' ? '✓' : '⧉'}</button>
              </span>
            </div>
            <div class="ip-tags">
              {#if agentType(agent) === 'llm'}
                {@const fb = modelChainFallbacks(agent.model_chain)}
                <span class="ip-tag ip-tag-llm" title="LLM-powered agent (native runToolLoop)">LLM</span>
                {#if agent.model}
                  <span class="ip-tag ip-tag-model" title={agent.provider ? `${agent.provider} / ${agent.model}` : agent.model}>{agent.model}</span>
                {/if}
                {#if fb > 0}
                  <span class="ip-tag ip-tag-fallback" title="model_chain fallbacks configured">+{fb} fallback{fb > 1 ? 's' : ''}</span>
                {/if}
              {:else if agentType(agent) === 'claude_code'}
                <span class="ip-tag ip-tag-sdk" title="Runs through the Claude Agent SDK (claude_code executor)">Claude Code SDK</span>
                <span class="ip-tag ip-tag-model" title={agent.model ? `SDK model: ${agent.model}` : `SDK default model: ${CLAUDE_CODE_DEFAULT_MODEL}`}>
                  {agent.model || CLAUDE_CODE_DEFAULT_MODEL}{!agent.model ? ' (default)' : ''}
                </span>
              {:else}
                <span class="ip-tag ip-tag-script" title="Native script / builtin handler — no LLM">SCRIPT</span>
                {#if agent.builtin_handler}
                  <span class="ip-tag ip-tag-handler" title="builtin handler id">{agent.builtin_handler}</span>
                {/if}
              {/if}
            </div>
          </div>
        </div>
        <button class="ip-close" on:click={() => dispatch('close')} aria-label="close">×</button>
      </div>

      <!-- Primary actions. The run state leads the row: it is what Pause and
           Resume change, so it belongs with them and not floating in the body.

           Pause y Resume emiten el MISMO evento `resume`: son un único toggle y
           quien escucha decide el sentido leyendo `active`. Dos nombres para el
           mismo handler no agregarían nada. -->
      <div class="ip-actions">
        <span class="ip-state" class:ip-state-on={agent.active === 1} class:ip-state-off={agent.active !== 1}
              class:ip-state-tripped={autoPaused}
              title={agent.active === 1
                ? 'Schedule and event triggers are live'
                : autoPaused
                  ? `Auto-paused after ${agent.consecutive_failures} consecutive failures. Resume clears the counter.`
                  : 'Paused — schedule and triggers are off. Manual runs still work.'}>
          <span class="led" class:on={agent.active === 1}></span>{agent.active
            ? 'active'
            : autoPaused
              ? 'auto-paused'
              : 'paused'}
        </span>
        <button class="ip-btn ip-btn-primary" on:click={() => dispatch('run')} disabled={starting} title={agent.active !== 1 ? 'Manual run — overrides pause' : 'Run this agent now'}>
          <span class="ip-btn-ico">{starting ? '●' : '▶'}</span>
          <span>{starting ? 'starting…' : 'Run now'}</span>
        </button>
        {#if agent.active === 1}
          <button class="ip-btn ip-btn-warn" on:click={() => dispatch('resume')} disabled={togglingPause} title="Pause: stop schedule + event triggers. Manual Run still works.">
            <span class="ip-btn-ico">⏸</span>
            <span>{togglingPause ? '…' : 'Pause'}</span>
          </button>
        {:else}
          <button class="ip-btn ip-btn-resume" on:click={() => dispatch('resume')} disabled={togglingPause} title="Resume: re-enable schedule + event triggers.">
            <span class="ip-btn-ico">▶</span>
            <span>{togglingPause ? '…' : 'Resume'}</span>
          </button>
        {/if}
        <button class="ip-btn ip-btn-ghost" on:click={() => selectTab('chat')}>
          <span class="ip-btn-ico">✎</span><span>Message</span>
        </button>
        {#if devopsOffice}
          <a class="ip-btn ip-btn-ghost" href="/devops" style="text-decoration:none" title="Open the DevOps control panel — repos, backlog, dev stacks">
            <span class="ip-btn-ico">🛠</span><span>DevOps panel</span>
          </a>
        {/if}
        {#if agent.under_revision}
          <button class="ip-btn ip-btn-accept" on:click={() => dispatch('revision', { mode: 'accept' })} disabled={revisionBusy}
                  title="Accept — clear REVISION flag, keep agent as-is">
            <span class="ip-btn-ico">✓</span><span>{revisionBusy ? '…' : 'Accept'}</span>
          </button>
          <button class="ip-btn ip-btn-reject" on:click={() => dispatch('revision', { mode: 'reject' })} disabled={revisionBusy}
                  title="Reject — deactivate (active=0). Row stays in DB, easy rollback.">
            <span class="ip-btn-ico">✗</span><span>{revisionBusy ? '…' : 'Reject'}</span>
          </button>
        {/if}
        {#if startMsg}
          <span class="ip-start-msg" class:ok={startMsg.startsWith('✓')} class:err={startMsg.startsWith('✗')} class:pause={startMsg.startsWith('⏸')}>{startMsg}</span>
        {/if}
      </div>

      <!-- Why the breaker tripped. The state chip above can only say "paused",
           which reads identically to a pause the operator asked for — so an
           agent the kernel stopped on its own looked like one someone stopped
           on purpose, and the reason it stopped was never on screen at all. -->
      {#if autoPaused}
        <div class="ip-tripped" role="status">
          <span class="ip-tripped-ico" aria-hidden="true">⛔</span>
          <div class="ip-tripped-body">
            <span class="ip-tripped-head">
              Auto-paused after {agent.consecutive_failures} consecutive failures
              {#if autoPausedAgo}<span class="ip-tripped-when">· {autoPausedAgo}</span>{/if}
            </span>
            {#if agent.auto_pause_reason}
              <pre class="ip-tripped-why">{agent.auto_pause_reason}</pre>
            {/if}
            <span class="ip-tripped-hint">Resume re-enables the schedule and clears the counter.</span>
          </div>
        </div>
      {/if}

      <!-- Tabs -->
      <div class="ip-tabs">
        <button class="ip-tab" class:active={panelTab === 'info'} on:click={() => selectTab('info')}>Overview</button>
        {#if running}
          <button class="ip-tab ip-tab-live" class:active={panelTab === 'live'} on:click={() => selectTab('live')}>
            <span class="live-dot"></span>LIVE
          </button>
        {/if}
        <button class="ip-tab" class:active={panelTab === 'history'} on:click={() => selectTab('history')}>
          History{#if historyCount}<span class="ip-tab-count">{historyCount}</span>{/if}
        </button>
        {#each extraTabs as tab (tab.id)}
          <button class="ip-tab ip-tab-ext" class:active={panelTab === tab.id} on:click={() => selectTab(tab.id)}>{tab.label}</button>
        {/each}
        <button class="ip-tab" class:active={panelTab === 'chat'} on:click={() => selectTab('chat')}>Message</button>
        <button class="ip-tab" class:active={panelTab === 'workspace'} on:click={() => selectTab('workspace')}>Workspace{#if workspaceCount}<span class="ip-tab-count">{workspaceCount}</span>{/if}</button>
      </div>

      <!-- El cuerpo de cada tab sigue en quien monta el drawer. El slot se
           renderiza sólo con su tab abierto, así que el contenido se crea y se
           destruye igual que con el {#if panelTab === …} que había acá.

           `overview` además publica `store` (let:store): las secciones que
           Tasks 9/12 montan ahí adentro (RuntimeSection y las demás) leen y
           escriben el agente a través de este store, que el drawer sigue
           siendo dueño de crear y recrear. Ningún otro slot lo necesita
           todavía — SkillsTab (Task 11) trabaja con agentId/agent y avisa por
           evento `change`, no con el store directo. -->
      {#if panelTab === 'info'}
        <slot name="overview" store={detail} />
      {/if}

      {#if panelTab === 'live'}
        <slot name="live" />
      {/if}

      {#if panelTab === 'history'}
        <slot name="history" />
      {/if}

      {#if extraTabOpen}
        <slot name="extra" tabId={panelTab} />
      {/if}

      {#if panelTab === 'chat'}
        <slot name="chat" />
      {/if}

      {#if panelTab === 'workspace'}
        <slot name="workspace" />
      {/if}
    </div>
  {/if}

<style>
  /* ═══════════════════════════════════════════════════════════════
     INFO PANEL — editorial/technical console, refined & data-dense

     Las reglas que además usa otro panel del mundo 3D (el de My Office, que
     reusa .info-panel/.ip-head/.ip-tabs) siguen TAMBIÉN allá: el CSS de
     Svelte es por componente, así que una regla compartida tiene que existir
     en los dos lados.
     ═══════════════════════════════════════════════════════════════ */
  .info-panel{
    position:absolute;top:12px;right:12px;bottom:12px;
    width:min(720px, 55vw); min-width:560px;
    overflow:hidden;
    background:linear-gradient(180deg, rgba(16,18,28,.96) 0%, rgba(11,13,20,.97) 100%);
    backdrop-filter:blur(16px) saturate(1.1);
    border:1px solid rgba(120,130,160,.15);
    border-radius:14px;
    box-shadow:0 20px 60px -20px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.02) inset;
    z-index:10;
    animation:slide .25s cubic-bezier(.2,.9,.25,1);
    display:flex;flex-direction:column;
    color:#d8dae3;
    --flow-color:#3dd6c8;
  }
  .info-panel::before{
    content:'';position:absolute;top:0;left:0;bottom:0;width:2px;
    background:linear-gradient(180deg, var(--flow-color) 0%, transparent 70%);
    opacity:.75;pointer-events:none;
  }
  @keyframes slide{from{transform:translateX(20px);opacity:0}}

  /* ── Header ───────────────────── */
  .ip-head{
    display:flex;justify-content:space-between;align-items:flex-start;gap:12px;
    padding:18px 18px 12px;
    border-bottom:1px solid rgba(120,130,160,.08);
    flex-shrink:0;
  }
  .ip-head-left{display:flex;gap:12px;align-items:flex-start;min-width:0;flex:1}
  .ip-glyph{
    width:32px;height:32px;border-radius:8px;
    display:grid;place-items:center;
    font:500 15px 'JetBrains Mono',monospace;
    color:var(--flow-color);
    background:color-mix(in srgb, var(--flow-color) 8%, transparent);
    border:1px solid color-mix(in srgb, var(--flow-color) 30%, transparent);
    flex-shrink:0;
  }
  /* One rhythm for the whole header. The name, the identity row and the tag
     row used ad-hoc 4px/5px margins, so nothing lined up with anything. */
  .ip-head-txt{min-width:0;flex:1;display:flex;flex-direction:column;gap:7px}
  .ip-name{
    font:600 17px/1.1 'Syne',sans-serif;
    color:#f0f2f7;
    letter-spacing:-.01em;
    word-break:break-word;
    display:inline-flex;align-items:center;gap:8px;
  }
  .ip-name-edit-btn{
    border:none;background:transparent;color:#7a7f92;cursor:pointer;
    font-size:13px;padding:2px 4px;border-radius:3px;opacity:0;
    transition:opacity .12s, color .12s, background .12s;
  }
  .ip-name:hover .ip-name-edit-btn{opacity:1}
  .ip-name-edit-btn:hover{color:#ecc968;background:rgba(201,168,76,0.12)}
  .ip-name-edit{display:flex;align-items:center;gap:6px}
  .ip-name-input{
    font:600 17px/1.1 'Syne',sans-serif;color:#f0f2f7;
    background:rgba(10,12,22,0.7);
    border:1px solid rgba(201,168,76,0.4);
    border-radius:3px;padding:3px 8px;min-width:180px;flex:1;outline:none;
  }
  .ip-name-input:focus{border-color:#c9a84c;box-shadow:0 0 0 2px rgba(201,168,76,0.2)}
  .ip-name-btn{
    border:1px solid rgba(255,255,255,0.15);background:rgba(20,24,38,0.8);
    color:#c9d0e0;cursor:pointer;font-size:13px;
    padding:3px 8px;border-radius:3px;line-height:1;
  }
  .ip-name-btn-ok:hover{border-color:#3dd68c;color:#3dd68c;background:rgba(61,214,140,0.1)}
  .ip-name-btn-cancel:hover{border-color:#f04770;color:#f04770;background:rgba(240,71,112,0.1)}
  .ip-name-btn:disabled{opacity:0.5;cursor:wait}
  /* Wraps instead of overflowing: a long flow name plus an id used to push the
     row past the panel edge. */
  .ip-sub{
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;row-gap:7px;
    font:500 10px 'JetBrains Mono',monospace;
    color:#7a7f92;
  }
  .ip-flow{
    color:var(--f, var(--flow-color));
    font-weight:600;text-transform:uppercase;letter-spacing:.6px;
    font-size:10px;line-height:1.5;padding:3px 8px;border-radius:5px;
    background:color-mix(in srgb, var(--f, var(--flow-color)) 10%, transparent);
    border:1px solid color-mix(in srgb, var(--f, var(--flow-color)) 25%, transparent);
  }
  .ip-dot{width:3px;height:3px;border-radius:50%;background:#4a4f66}
  .ip-tags{
    display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  }
  /* Same metrics as .ip-flow so every chip in the header sits on one baseline
     and reads as one family. */
  .ip-tag{
    font:700 10px/1.5 'JetBrains Mono',monospace;letter-spacing:.6px;
    padding:3px 8px;border-radius:5px;text-transform:uppercase;
    border:1px solid transparent;white-space:nowrap;
  }
  .ip-tag-llm{
    color:#6fe4b8;background:rgba(111,228,184,0.1);border-color:rgba(111,228,184,0.35);
  }
  .ip-tag-model{
    color:#c9d0e0;background:rgba(70,90,130,0.18);border-color:rgba(120,140,180,0.25);
    font-weight:500;letter-spacing:0;text-transform:none;
  }
  .ip-tag-script{
    color:#f0a040;background:rgba(240,160,64,0.1);border-color:rgba(240,160,64,0.4);
  }
  .ip-tag-handler{
    color:#b8a060;background:rgba(184,160,96,0.08);border-color:rgba(184,160,96,0.22);
    font-weight:500;letter-spacing:0;text-transform:none;
  }
  .ip-tag-sdk{
    color:#c8a8ff;background:rgba(160,120,240,0.12);border-color:rgba(160,120,240,0.4);
  }
  .ip-tag-fallback{
    color:#8a8fa8;background:rgba(80,90,120,0.12);border-color:rgba(120,130,160,0.22);
    font-weight:500;letter-spacing:0;text-transform:none;
  }
  .ip-id{display:inline-flex;align-items:center;gap:4px;color:#8a8fa8}
  .ip-close{
    background:rgba(255,255,255,.03);border:1px solid rgba(120,130,160,.12);
    color:#8a8fa8;
    width:28px;height:28px;
    border-radius:8px;
    font:400 18px/1 'Syne',sans-serif;
    cursor:pointer;transition:all .15s;
    display:grid;place-items:center;
    flex-shrink:0;
  }
  .ip-close:hover{background:rgba(239,93,110,.12);border-color:rgba(239,93,110,.3);color:#ef5d6e}

  /* ── Primary actions ─────────── */
  .ip-actions{
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;
    padding:12px 18px;
    border-bottom:1px solid rgba(120,130,160,.08);
    flex-shrink:0;
  }
  .ip-btn{
    display:inline-flex;align-items:center;gap:6px;
    padding:8px 14px;border-radius:8px;
    font:600 11px 'Syne',sans-serif;letter-spacing:.4px;
    cursor:pointer;transition:all .15s;
    border:1px solid transparent;
  }
  .ip-btn-ico{font:500 11px 'JetBrains Mono',monospace}
  .ip-btn-primary{
    background:#78dc8c;color:#0a0e14;border-color:#78dc8c;
    box-shadow:0 6px 16px -8px rgba(120,220,140,.5);
  }
  .ip-btn-primary:hover:not(:disabled){background:#8ee4a0;border-color:#8ee4a0}
  .ip-btn-primary:disabled{opacity:.5;cursor:wait;background:rgba(120,220,140,.3);border-color:rgba(120,220,140,.2)}
  .ip-btn-ghost{
    background:rgba(255,255,255,.03);
    border-color:rgba(120,130,160,.2);
    color:#d8dae3;
  }
  .ip-btn-ghost:hover{background:rgba(255,255,255,.06);border-color:rgba(120,130,160,.35)}
  .ip-btn-warn{
    background:rgba(251,191,36,.08);
    border-color:rgba(251,191,36,.35);
    color:#fbbf24;
  }
  .ip-btn-warn:hover:not(:disabled){background:rgba(251,191,36,.18);border-color:rgba(251,191,36,.55)}
  .ip-btn-warn:disabled{opacity:.5;cursor:wait}
  .ip-btn-resume{
    background:rgba(120,220,140,.08);
    border-color:rgba(120,220,140,.35);
    color:#78dc8c;
  }
  .ip-btn-resume:hover:not(:disabled){background:rgba(120,220,140,.18);border-color:rgba(120,220,140,.55)}
  .ip-btn-resume:disabled{opacity:.5;cursor:wait}
  /* REVISION resolution buttons — only shown when agent.under_revision = 1.
   * Green accept (mirror of ip-btn-resume), orange reject (matches the REVISION
   * pill that lives over the agent's head in the 3D office). */
  .ip-btn-accept{
    background:rgba(120,220,140,.08);
    border-color:rgba(120,220,140,.35);
    color:#78dc8c;
  }
  .ip-btn-accept:hover:not(:disabled){background:rgba(120,220,140,.18);border-color:rgba(120,220,140,.55)}
  .ip-btn-accept:disabled{opacity:.5;cursor:wait}
  .ip-btn-reject{
    background:rgba(251,146,60,.08);
    border-color:rgba(251,146,60,.4);
    color:#fb923c;
  }
  .ip-btn-reject:hover:not(:disabled){background:rgba(251,146,60,.2);border-color:rgba(251,146,60,.6)}
  .ip-btn-reject:disabled{opacity:.5;cursor:wait}
  .ip-start-msg{
    font:500 10px 'JetBrains Mono',monospace;
    color:#8a8fa8;margin-left:4px;
  }
  .ip-start-msg.ok{color:#78dc8c}
  .ip-start-msg.err{color:#ef5d6e}
  .ip-start-msg.pause{color:#fbbf24}

  /* ── Tabs ─────────────────────── */
  .ip-tabs{
    display:flex;gap:2px;
    padding:0 18px;
    border-bottom:1px solid rgba(120,130,160,.08);
    flex-shrink:0;
  }
  .ip-tab{
    position:relative;
    padding:12px 16px;
    font:600 10px 'Syne',sans-serif;letter-spacing:1px;text-transform:uppercase;
    background:none;border:none;
    color:#6a6f82;cursor:pointer;transition:color .15s;
    display:inline-flex;align-items:center;gap:6px;
  }
  .ip-tab:hover{color:#b0b5c8}
  .ip-tab.active{color:#f0f2f7}
  .ip-tab.active::after{
    content:'';position:absolute;bottom:-1px;left:12px;right:12px;height:2px;
    background:var(--flow-color);border-radius:2px 2px 0 0;
  }
  .ip-tab-count{
    font:600 9px 'JetBrains Mono',monospace;
    padding:1px 5px;border-radius:6px;
    background:rgba(120,130,160,.15);color:#a0a5b8;
  }
  /* ── Run state ─────────────────
     Leads the action row and is separated from the buttons by a rule, so it
     reads as the state those buttons act on rather than a fourth control.
     Same 8px/14px box as .ip-btn so both sit on one baseline. */
  .ip-state{
    display:inline-flex;align-items:center;gap:6px;
    padding:8px 12px 8px 0;margin-right:4px;
    border-right:1px solid rgba(120,130,160,.15);
    font:600 10px 'JetBrains Mono',monospace;
    text-transform:lowercase;letter-spacing:.4px;
  }
  .ip-state-on{color:#78dc8c}
  .ip-state-off{color:#fbbf24}
  /* An agent the kernel stopped reads as a fault, not as a warning: the
     operator did not choose this state and something upstream is broken. */
  .ip-state-tripped{color:#f87171}

  .ip-tripped{
    display:flex; gap:9px; align-items:flex-start;
    margin:8px 0 0; padding:9px 11px;
    background:rgba(248,113,113,.08);
    border:1px solid rgba(248,113,113,.28);
    border-radius:8px;
  }
  .ip-tripped-ico{font-size:13px; line-height:1.3; flex:none}
  .ip-tripped-body{display:flex; flex-direction:column; gap:4px; min-width:0}
  .ip-tripped-head{font-size:11.5px; font-weight:600; color:#f87171}
  .ip-tripped-when{font-weight:400; opacity:.75}
  .ip-tripped-why{
    margin:0; padding:6px 8px; max-height:88px; overflow:auto;
    font-family:var(--font-mono); font-size:10.5px; line-height:1.45;
    white-space:pre-wrap; word-break:break-word;
    color:var(--text-2); background:rgba(0,0,0,.28); border-radius:5px;
  }
  .ip-tripped-hint{font-size:10.5px; color:var(--text-3)}
  .ip-state .led{
    width:6px;height:6px;border-radius:50%;
    background:#fbbf24;
  }
  .ip-state .led.on{
    background:#78dc8c;box-shadow:0 0 6px #78dc8c;
    animation:led-pulse 2s ease-in-out infinite;
  }
  @keyframes led-pulse{50%{opacity:.55}}

  /* ── Copy inline (id del agente) ── */
  .ip-copy-inline{
    background:transparent;border:none;
    color:#6a6f82;cursor:pointer;
    font:400 11px monospace;line-height:1;padding:1px 4px;border-radius:3px;
    transition:color .12s;margin-left:4px;
  }
  .ip-copy-inline:hover{color:#d8dae3;background:rgba(120,130,160,.1)}

  /* ── LIVE tab ── */
  .ip-tab-live{
    position:relative;display:flex;align-items:center;gap:6px;
    color:#ef5d6e !important;
    background:linear-gradient(180deg, rgba(239,93,110,.12), rgba(239,93,110,.04)) !important;
    border-color:rgba(239,93,110,.35) !important;
    font-weight:700;letter-spacing:.5px;
  }
  .ip-tab-live.active{
    background:rgba(239,93,110,.22) !important;
    border-color:#ef5d6e !important;
    color:#fff !important;
    box-shadow:0 0 12px rgba(239,93,110,.35);
  }
  .live-dot{
    width:7px;height:7px;border-radius:50%;background:#ef5d6e;
    box-shadow:0 0 8px #ef5d6e;
    animation:live-pulse 1s ease-in-out infinite;
  }
  @keyframes live-pulse{
    0%,100%{opacity:1;transform:scale(1)}
    50%{opacity:.45;transform:scale(.82)}
  }
</style>
