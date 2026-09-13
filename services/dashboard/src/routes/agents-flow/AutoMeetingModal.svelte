<script lang="ts">
  /**
   * Auto-Meeting modal — an autonomous agent-to-agent meeting.
   *
   * Distinct from "Call Meeting", which stays in AgentWorld3D: that one makes
   * the operator the moderator and walks the attendees into a room, so it is
   * bound to the 3D floor. This one only picks a moderator + attendees and
   * fires a run on the moderator whose goal calls kernel_agents_call_meeting.
   * Nothing here touches the scene, which is why it could leave.
   *
   * Opened from the HQ dropdown via `open()`. It closes itself on success —
   * the live transcript panel in the world opens on its own when the
   * `meeting_requested` event arrives, so there is nothing to hand back.
   */
  import { initials, parseMeetingTopics } from '$lib/agent-helpers.js';

  /** Only the fields the picker reads — the world passes its fuller rows. */
  export let agents: Array<{
    id: string; name: string; active: number;
    builtin_handler: string; flow_id: string; rank_id?: string;
  }> = [];
  export let flows: Array<{ id: string; name: string; color: string }> = [];
  export let ranks: Array<{ id: string; insignia: string; color: string }> = [];

  let showAutoMeetingModal = false;
  let autoMeetingTopic = '';
  let autoMeetingContext = '';
  let autoMeetingTopicsText = '';
  let autoMeetingModeratorId = '';
  let autoMeetingAttendeeIds: Set<string> = new Set();
  let autoMeetingRounds = 2;
  let autoMeetingUrgency: 'normal' | 'urgent' = 'normal';
  let autoMeetingFiring = false;
  let autoMeetingError = '';
  let autoMeetingSearch = '';

  $: autoMeetingAgentOptions = agents.filter(a => a.active && !a.builtin_handler)
    .filter(a => !autoMeetingSearch || a.name.toLowerCase().includes(autoMeetingSearch.toLowerCase()));

  // Group the agent options by office (flow) so the picker shows cohesive
  // sections instead of one big pile of pills. Each section header carries
  // the flow name + colour stripe; cards inside use the agent's rank insignia
  // as a mini avatar so the user can identify them at a glance.
  $: autoMeetingAgentsByFlow = (() => {
    const byFlow = new Map<string, { flow: { id: string; name: string; color: string }; agents: typeof autoMeetingAgentOptions }>();
    for (const a of autoMeetingAgentOptions) {
      const f = flows.find(x => x.id === a.flow_id);
      const flowKey = f?.id ?? '_none';
      const flowMeta = f ?? { id: '_none', name: 'No office', color: '#6b7088' };
      if (!byFlow.has(flowKey)) byFlow.set(flowKey, { flow: flowMeta as any, agents: [] });
      byFlow.get(flowKey)!.agents.push(a);
    }
    // Sort offices alphabetically for stable rendering; agents within a flow
    // sorted by name.
    return [...byFlow.values()]
      .sort((a, b) => a.flow.name.localeCompare(b.flow.name))
      .map(g => ({ ...g, agents: [...g.agents].sort((x, y) => x.name.localeCompare(y.name)) }));
  })();

  function rankInfoForAgent(agentId: string): { insignia: string; color: string } | null {
    const a = agents.find(x => x.id === agentId);
    if (!a?.rank_id) return null;
    const r = ranks.find(x => x.id === a.rank_id);
    return r ? { insignia: r.insignia, color: r.color } : null;
  }

  function toggleAutoMeetingAttendee(id: string) {
    if (id === autoMeetingModeratorId) return; // moderator can't attend itself
    if (autoMeetingAttendeeIds.has(id)) autoMeetingAttendeeIds.delete(id);
    else autoMeetingAttendeeIds.add(id);
    autoMeetingAttendeeIds = new Set(autoMeetingAttendeeIds);
  }

  function setAutoMeetingModerator(id: string) {
    autoMeetingModeratorId = id;
    if (autoMeetingAttendeeIds.has(id)) {
      autoMeetingAttendeeIds.delete(id);
      autoMeetingAttendeeIds = new Set(autoMeetingAttendeeIds);
    }
  }

  function resetAutoMeetingForm() {
    autoMeetingTopic = '';
    autoMeetingContext = '';
    autoMeetingTopicsText = '';
    autoMeetingModeratorId = '';
    autoMeetingAttendeeIds = new Set();
    autoMeetingRounds = 2;
    autoMeetingUrgency = 'normal';
    autoMeetingError = '';
    autoMeetingSearch = '';
  }

  async function fireAutoMeeting() {
    if (!autoMeetingModeratorId || autoMeetingAttendeeIds.size === 0 || !autoMeetingTopic.trim()) return;
    autoMeetingFiring = true;
    autoMeetingError = '';
    try {
      const attendeeIds = [...autoMeetingAttendeeIds];
      const attendeeJson = JSON.stringify(attendeeIds);
      // Fold description + topics into the tool's `context` param — the
      // MeetingExecutor hands context verbatim to every participant, so the
      // agents drill into each listed topic during their turns.
      const autoTopics = parseMeetingTopics(autoMeetingTopicsText);
      const ctxParts: string[] = [];
      if (autoMeetingContext.trim()) ctxParts.push(autoMeetingContext.trim());
      if (autoTopics.length > 0) ctxParts.push(`Topics to dig into (every participant must address them explicitly): ${autoTopics.map(t => `(${t})`).join(' ')}`);
      const ctxCombined = ctxParts.join(' — ');
      const ctxLine = ctxCombined
        ? `Pasale como context: "${ctxCombined.replace(/"/g, '\\"')}".`
        : '';
      const goal =
        `Call a meeting using the kernel_agents_call_meeting tool with ` +
        `attendee_ids ${attendeeJson}, topic "${autoMeetingTopic.replace(/"/g, '\\"')}", ` +
        `rounds ${autoMeetingRounds}, urgency "${autoMeetingUrgency}". ${ctxLine} ` +
        `Return the meeting summary without invoking any other tool.`;
      const res = await fetch('/api/agents/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: autoMeetingModeratorId, goal }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        autoMeetingError = body?.error || `HTTP ${res.status}`;
        return;
      }
      // Live transcript modal opens itself when meeting_requested arrives.
      showAutoMeetingModal = false;
      resetAutoMeetingForm();
    } catch (e: any) {
      autoMeetingError = e?.message || 'Failed to start meeting';
    } finally {
      autoMeetingFiring = false;
    }
  }

  /** The only way in — the HQ dropdown calls it. */
  export function open(): void {
    showAutoMeetingModal = true;
  }
</script>

{#if showAutoMeetingModal}
  <div class="modal-overlay" on:click={() => showAutoMeetingModal = false} role="button" tabindex="-1" on:keydown={e => e.key === 'Escape' && (showAutoMeetingModal = false)}>
    <div class="modal auto-meeting-modal" on:click|stopPropagation role="presentation">
      <div class="modal-title">Auto-Meeting</div>
      <div class="modal-sub">The agents talk to each other (you don't take part). You'll see the conversation live as soon as it starts.</div>

      <label class="modal-label">
        Topic
        <input type="text" class="modal-input" bind:value={autoMeetingTopic}
          placeholder="What do they need to discuss?" />
      </label>

      <label class="modal-label">
        Description / Context (optional)
        <textarea class="modal-textarea" bind:value={autoMeetingContext} rows="3"
          placeholder="Background o documento que el moderador les muestra"></textarea>
      </label>

      <label class="modal-label">
        Topics to dig into (one per line, optional)
        <textarea class="modal-textarea" bind:value={autoMeetingTopicsText} rows="3"
          placeholder={'e.g.\nStatus of each workstream\nOpen risks\nPending decisions'}></textarea>
      </label>

      <div class="modal-row">
        <label class="modal-label modal-half">
          Rounds
          <select class="modal-input" bind:value={autoMeetingRounds}>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={15}>15</option>
            <option value={20}>20</option>
          </select>
        </label>
        <label class="modal-label modal-half">
          Urgencia
          <select class="modal-input" bind:value={autoMeetingUrgency}>
            <option value="normal">normal</option>
            <option value="urgent">urgent (rojo)</option>
          </select>
        </label>
      </div>

      <div class="modal-label">Moderador (1)</div>
      <div class="am-picker am-picker-mod">
        {#each autoMeetingAgentsByFlow as group (group.flow.id)}
          <div class="am-flow-section">
            <div class="am-flow-head" style="--c:{group.flow.color}">
              <span class="am-flow-stripe" style="background:{group.flow.color}"></span>
              <span class="am-flow-name">{group.flow.name}</span>
              <span class="am-flow-count">{group.agents.length}</span>
            </div>
            <div class="am-card-grid">
              {#each group.agents as a (a.id)}
                {@const rank = rankInfoForAgent(a.id)}
                <button type="button"
                  class="am-card am-card-mod {autoMeetingModeratorId === a.id ? 'am-card-mod-on' : ''}"
                  style="--flow-c:{group.flow.color}"
                  title={a.name}
                  on:click={() => setAutoMeetingModerator(a.id)}>
                  <span class="am-card-av" style="background:{group.flow.color}; color:{rank?.color ?? '#fff'}">
                    {#if rank}{rank.insignia}{:else}<span class="am-card-init">{initials(a.name)}</span>{/if}
                  </span>
                  <span class="am-card-name">{a.name}</span>
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>

      <div class="modal-label">Attendees ({autoMeetingAttendeeIds.size})</div>
      <input type="text" class="modal-input" bind:value={autoMeetingSearch} placeholder="search agent…" />
      <div class="am-picker am-picker-att">
        {#each autoMeetingAgentsByFlow as group (group.flow.id)}
          {@const attGroupAgents = group.agents.filter(a => a.id !== autoMeetingModeratorId)}
          {#if attGroupAgents.length > 0}
            <div class="am-flow-section">
              <div class="am-flow-head" style="--c:{group.flow.color}">
                <span class="am-flow-stripe" style="background:{group.flow.color}"></span>
                <span class="am-flow-name">{group.flow.name}</span>
                <span class="am-flow-count">{attGroupAgents.length}</span>
              </div>
              <div class="am-card-grid">
                {#each attGroupAgents as a (a.id)}
                  {@const rank = rankInfoForAgent(a.id)}
                  <button type="button"
                    class="am-card am-card-att {autoMeetingAttendeeIds.has(a.id) ? 'am-card-att-on' : ''}"
                    style="--flow-c:{group.flow.color}"
                    title={a.name}
                    on:click={() => toggleAutoMeetingAttendee(a.id)}>
                    <span class="am-card-av" style="background:{group.flow.color}; color:{rank?.color ?? '#fff'}">
                      {#if rank}{rank.insignia}{:else}<span class="am-card-init">{initials(a.name)}</span>{/if}
                    </span>
                    <span class="am-card-name">{a.name}</span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        {/each}
      </div>

      {#if autoMeetingError}
        <div class="modal-error">{autoMeetingError}</div>
      {/if}

      <div class="modal-actions">
        <button class="modal-cancel" on:click={() => { showAutoMeetingModal = false; resetAutoMeetingForm(); }}>Cancel</button>
        <button class="modal-confirm" on:click={fireAutoMeeting}
          disabled={autoMeetingFiring || !autoMeetingModeratorId || autoMeetingAttendeeIds.size === 0 || !autoMeetingTopic.trim()}>
          {autoMeetingFiring ? 'Starting…' : `Start (${autoMeetingAttendeeIds.size + 1} agents)`}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Modal ────────────────────
     The generic `.modal-*` rules are duplicated from AgentWorld3D: Svelte
     scopes styles per component, so a rule left in the parent stops applying
     here. `.modal-row` / `.modal-half` are the exception — this was their only
     consumer, so they moved rather than got copied. */
  .modal-overlay{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center}
  .modal{background:#0e1018;border:1px solid rgba(74,79,106,.4);border-radius:16px;padding:24px;width:420px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.6);animation:mslide .2s ease-out}
  @keyframes mslide{from{transform:translateY(12px);opacity:0}}
  .modal-title{font:700 16px 'Syne',sans-serif;color:var(--text-1,#e0e2ea);margin-bottom:4px}
  .modal-sub{font:400 11px 'Manrope',sans-serif;color:var(--text-3,#4a4f6a);margin-bottom:16px;line-height:1.4}
  .modal-label{display:block;font:600 9px 'Manrope',sans-serif;color:var(--text-3,#4a4f6a);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
  .modal-input{display:block;width:100%;margin-top:5px;padding:8px 12px;border-radius:8px;background:#141620;border:1px solid rgba(74,79,106,.3);color:var(--text-1,#e0e2ea);font:400 13px 'Manrope',sans-serif;outline:none;box-sizing:border-box}
  .modal-input:focus{border-color:#6366f1}
  .modal-textarea{display:block;width:100%;margin-top:5px;padding:8px 12px;border-radius:8px;background:#141620;border:1px solid rgba(74,79,106,.3);color:var(--text-1,#e0e2ea);font:400 12px 'Manrope',sans-serif;outline:none;resize:vertical;box-sizing:border-box;line-height:1.5}
  .modal-textarea:focus{border-color:#6366f1}
  .modal-row{display:flex;gap:10px}
  .modal-half{flex:1}
  .modal-error{font:500 11px 'Manrope',sans-serif;color:#ef4444;background:rgba(239,68,68,.1);padding:6px 10px;border-radius:6px;margin-bottom:8px}
  .modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  .modal-cancel{padding:8px 18px;border-radius:8px;font:600 11px 'Manrope',sans-serif;background:#1a1d2a;border:1px solid rgba(74,79,106,.3);color:var(--text-2,#8a8fa8);cursor:pointer;transition:all .15s}
  .modal-cancel:hover{background:#22253a}
  .modal-confirm{padding:8px 18px;border-radius:8px;font:600 11px 'Syne',sans-serif;letter-spacing:.5px;background:#10b981;border:none;color:#fff;cursor:pointer;transition:all .15s}
  .modal-confirm:hover{filter:brightness(1.1)}
  .modal-confirm:disabled{opacity:.4;cursor:not-allowed}

  /* ── Auto-Meeting modal: per-office grouped agent picker ─────────────── */
  .auto-meeting-modal{ width:min(720px, 94vw); max-height:88vh; overflow-y:auto; }
  /* Outer picker container — vertical stack of office sections. */
  .am-picker{
    display:flex; flex-direction:column; gap:10px;
    margin:4px 0 12px;
    max-height:260px; overflow-y:auto;
    padding:8px; border:1px solid #1f2236; border-radius:8px;
    background:#0c0d14;
  }
  /* One office's group: small flow-coloured header + grid of agent cards. */
  .am-flow-section{ display:flex; flex-direction:column; gap:6px; }
  .am-flow-head{
    display:flex; align-items:center; gap:8px;
    padding:2px 0 4px;
    border-bottom:1px dashed rgba(255,255,255,.06);
  }
  .am-flow-stripe{
    width:3px; height:14px; border-radius:2px;
    box-shadow:0 0 6px var(--c);
  }
  .am-flow-name{
    font:700 11px 'Manrope',sans-serif; letter-spacing:.4px;
    color:#e0e2ea; text-transform:uppercase;
  }
  .am-flow-count{
    font:600 10px 'JetBrains Mono',monospace;
    color:#8d92a8; background:rgba(255,255,255,.04);
    padding:1px 6px; border-radius:8px;
  }
  /* Medium square cards laid out in an auto-fill grid — names wrap to 2
   * lines if needed but the card height stays consistent. */
  .am-card-grid{
    display:grid;
    grid-template-columns:repeat(auto-fill, minmax(130px, 1fr));
    gap:6px;
  }
  .am-card{
    display:flex; flex-direction:column; align-items:center;
    gap:6px; padding:8px 6px;
    min-height:74px;
    background:#161827; color:#cbd0e8;
    border:1.5px solid #2a2f4a; border-radius:8px;
    cursor:pointer; transition:all .12s;
    text-align:center;
  }
  .am-card:hover{ background:#1a1d2c; border-color:var(--flow-c); }
  .am-card-av{
    width:28px; height:28px; border-radius:50%;
    display:inline-flex; align-items:center; justify-content:center;
    font:900 14px 'Manrope',sans-serif; line-height:1;
    text-shadow:0 1px 2px rgba(0,0,0,0.85);
    box-shadow:0 0 0 2px rgba(0,0,0,.35), 0 0 6px var(--flow-c);
    flex-shrink:0;
  }
  .am-card-init{ font:700 10px 'JetBrains Mono',monospace; color:#fff; }
  .am-card-name{
    font:600 10.5px/1.3 'Manrope',sans-serif;
    color:#cbd0e8;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
    overflow:hidden; word-break:break-word;
  }
  /* Selected states — gold for moderator, blue for attendee. */
  .am-card-mod-on{
    background:rgba(201,168,76,.18); color:#f4e1a3;
    border-color:#c9a84c; box-shadow:0 0 0 1px #c9a84c44, 0 0 12px rgba(201,168,76,.35);
  }
  .am-card-mod-on .am-card-name{ color:#f4e1a3; }
  .am-card-att-on{
    background:rgba(91,141,239,.18); color:#cbe0ff;
    border-color:#5b8def; box-shadow:0 0 0 1px #5b8def44, 0 0 10px rgba(91,141,239,.3);
  }
  .am-card-att-on .am-card-name{ color:#cbe0ff; }
</style>
