<script lang="ts">
  /**
   * Entity preview modal — what opens when a UUID chip inside a run output is
   * clicked.
   *
   * The id could belong to any of seven things, and the kernel's tool results
   * do not say which, so `open()` asks each endpoint in turn and renders
   * whichever one answers: communication, note, prospect, agent run, agent,
   * CRM contact, reminder. Order matters — communications are the common case
   * and are tried first.
   *
   * `handleOutputClick` stays in AgentWorld3D: it is wired to six different
   * output panes there and only needs to call `open(id)`.
   */
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import { formatRunOutput } from '$lib/run-format.js';
  import { formatAgentRecentRuns } from '$lib/agent-helpers.js';

  let draftModalOpen = false;
  let draftModalLoading = false;
  let draftModalError = '';
  let draftModalData: any = null;

  /** The only way in — the UUID chip hands over the entity id. */
  export async function open(entityId: string) {
    draftModalOpen = true;
    draftModalLoading = true;
    draftModalError = '';
    draftModalData = null;
    try {
      // Try communication first
      const commRes: any = await fetch('/api/dashboard/comms/detail?id=' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (commRes?.comm) { draftModalData = commRes; draftModalLoading = false; return; }

      // Try note
      const noteRes: any = await fetch('/api/notes/' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (noteRes?.note || noteRes?.id) {
        const n = noteRes.note ?? noteRes;
        draftModalData = { _type: 'note', note: n };
        draftModalLoading = false;
        return;
      }

      // Try prospect
      const prospRes: any = await fetch('/api/prospecting/' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (prospRes?.prospect || prospRes?.id) {
        const p = prospRes.prospect ?? prospRes;
        draftModalData = { _type: 'prospect', prospect: p };
        draftModalLoading = false;
        return;
      }

      // Try agent run
      const runRes: any = await fetch('/api/agents/runs/' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (runRes?.run) {
        draftModalData = { _type: 'run', run: runRes.run };
        draftModalLoading = false;
        return;
      }

      // Try agent (the entity that PRODUCES runs)
      const agentRes: any = await fetch('/api/agents/' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (agentRes?.agent) {
        draftModalData = {
          _type: 'agent',
          agent: agentRes.agent,
          recentRuns: agentRes.runs ?? [],
        };
        draftModalLoading = false;
        return;
      }

      // Try CRM contact (used by prospector → copywriter → dispatcher pipelines)
      const contactRes: any = await fetch('/api/contacts/detail?id=' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (contactRes?.contact) {
        draftModalData = { _type: 'contact', contact: contactRes.contact };
        draftModalLoading = false;
        return;
      }

      // Try reminder (kernel_reminders_create / kernel_reminders_schedule emit
      // these IDs in tool results; users clicking the hash should land here).
      const reminderRes: any = await fetch('/api/reminders/detail?id=' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (reminderRes?.reminder) {
        draftModalData = { _type: 'reminder', reminder: reminderRes.reminder };
        draftModalLoading = false;
        return;
      }

      draftModalError = `ID ${entityId.slice(0, 8)}… not found in communications, notes, prospects, runs, agents, contacts, or reminders.`;
    } catch (e: any) {
      draftModalError = e?.message || 'Failed to load';
    } finally {
      draftModalLoading = false;
    }
  }

  function closeDraftModal() {
    draftModalOpen = false;
    draftModalData = null;
    draftModalError = '';
  }
</script>

{#if draftModalOpen}
  <div class="modal-overlay" on:click={closeDraftModal} role="button" tabindex="-1" on:keydown={e => e.key === 'Escape' && closeDraftModal()}>
    <div class="modal draft-modal" on:click|stopPropagation role="presentation">
      <div class="draft-modal-head">
        <div>
          <div class="modal-title">
            {#if draftModalData?._type === 'note'}Note
            {:else if draftModalData?._type === 'prospect'}Prospect
            {:else if draftModalData?._type === 'run'}Agent Run
            {:else if draftModalData?._type === 'agent'}Agent
            {:else if draftModalData?._type === 'contact'}Contact
            {:else if draftModalData?._type === 'reminder'}Reminder
            {:else}Draft{/if}
          </div>
          <div class="modal-sub">
            {#if draftModalData?.comm}
              {draftModalData.comm.channel ?? 'email'} · <span class="draft-status">{draftModalData.comm.status}</span>
              {#if draftModalData.comm.id}· <code>{draftModalData.comm.id.slice(0,8)}</code>{/if}
            {:else if draftModalData?._type === 'note'}
              {draftModalData.note.tags || 'note'} · <code>{draftModalData.note.id?.slice(0,8)}</code>
            {:else if draftModalData?._type === 'prospect'}
              {draftModalData.prospect.city || ''} · <code>{draftModalData.prospect.id?.slice(0,8)}</code>
            {:else if draftModalData?._type === 'run'}
              {draftModalData.run.status} · {draftModalData.run.steps_count ?? 0} steps · <code>{draftModalData.run.id?.slice(0,8)}</code>
            {:else if draftModalData?._type === 'agent'}
              {draftModalData.agent.role || 'worker'} · {draftModalData.agent.active ? 'active' : 'inactive'} · <code>{draftModalData.agent.id?.slice(0,8)}</code>
            {:else if draftModalData?._type === 'contact'}
              {draftModalData.contact.relationship || 'contact'} · <code>{draftModalData.contact.id?.slice(0,8)}</code>
            {:else if draftModalData?._type === 'reminder'}
              {draftModalData.reminder.status} · {draftModalData.reminder.repeat} · <code>{draftModalData.reminder.id?.slice(0,8)}</code>
            {:else}Loading…{/if}
          </div>
        </div>
        <button class="draft-modal-close" on:click={closeDraftModal} title="Close">×</button>
      </div>

      {#if draftModalLoading}
        <div class="ip-loading">Loading…</div>
      {:else if draftModalError}
        <div class="modal-error">{draftModalError}</div>

      {:else if draftModalData?.comm}
        {@const c = draftModalData.comm}
        <div class="draft-field">
          <span class="draft-lbl">To</span>
          <span class="draft-val">{c.recipients_to || '—'}</span>
        </div>
        {#if c.recipients_cc}
          <div class="draft-field"><span class="draft-lbl">Cc</span><span class="draft-val">{c.recipients_cc}</span></div>
        {/if}
        {#if c.recipients_bcc}
          <div class="draft-field"><span class="draft-lbl">Bcc</span><span class="draft-val">{c.recipients_bcc}</span></div>
        {/if}
        <div class="draft-field">
          <span class="draft-lbl">Subject</span>
          <span class="draft-val draft-subject">{c.subject || '(no subject)'}</span>
        </div>
        {#if draftModalData.contact}
          <div class="draft-field"><span class="draft-lbl">Contact</span><span class="draft-val">{draftModalData.contact.name} &lt;{draftModalData.contact.email}&gt;</span></div>
        {/if}
        <div class="draft-body copy-wrap">
          <CopyTextBtn text={c.body || c.body_html || ''} title="Copy body" />
          {#if c.body_html}
            <iframe title="draft-body" class="draft-iframe" srcdoc={c.body_html}></iframe>
          {:else}
            <pre class="draft-body-pre">{c.body || '(empty body)'}</pre>
          {/if}
        </div>
        {#if draftModalData.attachments?.length}
          <div class="draft-field">
            <span class="draft-lbl">Files</span>
            <span class="draft-val">{draftModalData.attachments.length} attachment(s)</span>
          </div>
        {/if}

      {:else if draftModalData?._type === 'note'}
        {@const n = draftModalData.note}
        <div class="draft-field"><span class="draft-lbl">Title</span><span class="draft-val draft-subject">{n.title || '(untitled)'}</span></div>
        {#if n.tags}<div class="draft-field"><span class="draft-lbl">Tags</span><span class="draft-val">{n.tags}</span></div>{/if}
        {#if n.created_at}<div class="draft-field"><span class="draft-lbl">Created</span><span class="draft-val">{String(n.created_at).slice(0,16).replace('T',' ')}</span></div>{/if}
        <div class="draft-body copy-wrap">
          <CopyTextBtn text={n.body || n.content || ''} title="Copy note" />
          <div class="draft-body-pre ip-out-md">{@html formatRunOutput(n.body || n.content || '(empty)')}</div>
        </div>

      {:else if draftModalData?._type === 'prospect'}
        {@const p = draftModalData.prospect}
        <div class="draft-field"><span class="draft-lbl">Name</span><span class="draft-val draft-subject">{p.name || p.business_name || '?'}</span></div>
        {#if p.city}<div class="draft-field"><span class="draft-lbl">City</span><span class="draft-val">{p.city}{p.country ? ', ' + p.country : ''}</span></div>{/if}
        {#if p.industry}<div class="draft-field"><span class="draft-lbl">Industry</span><span class="draft-val">{p.industry}</span></div>{/if}
        {#if p.email || p.phone}<div class="draft-field"><span class="draft-lbl">Contact</span><span class="draft-val">{[p.email, p.phone].filter(Boolean).join(' · ')}</span></div>{/if}
        {#if p.website}<div class="draft-field"><span class="draft-lbl">Website</span><span class="draft-val"><a href={p.website} target="_blank" rel="noopener">{p.website}</a></span></div>{/if}
        {#if p.score != null}<div class="draft-field"><span class="draft-lbl">Score</span><span class="draft-val">{p.score}/100</span></div>{/if}
        {#if p.notes}<div class="draft-body copy-wrap"><CopyTextBtn text={p.notes} title="Copy notes" /><pre class="draft-body-pre">{p.notes}</pre></div>{/if}

      {:else if draftModalData?._type === 'run'}
        {@const r = draftModalData.run}
        <div class="draft-field"><span class="draft-lbl">Status</span><span class="draft-val">{r.status}</span></div>
        <div class="draft-field"><span class="draft-lbl">Trigger</span><span class="draft-val">{r.trigger_type}</span></div>
        <div class="draft-field"><span class="draft-lbl">Steps</span><span class="draft-val">{r.steps_count ?? 0}</span></div>
        <div class="draft-field"><span class="draft-lbl">Tokens</span><span class="draft-val">{r.tokens_used ?? 0}</span></div>
        {#if r.created_at}<div class="draft-field"><span class="draft-lbl">Date</span><span class="draft-val">{String(r.created_at).slice(0,16).replace('T',' ')}</span></div>{/if}
        {#if r.result || r.error}
          <div class="draft-body copy-wrap">
            <CopyTextBtn text={r.result || r.error || ''} title="Copy run output" />
            <div class="draft-body-pre ip-out-md">{@html formatRunOutput(r.result || r.error || '')}</div>
          </div>
        {/if}

      {:else if draftModalData?._type === 'agent'}
        {@const a = draftModalData.agent}
        <div class="draft-field"><span class="draft-lbl">Name</span><span class="draft-val draft-subject">{a.name}</span></div>
        {#if a.description}<div class="draft-field"><span class="draft-lbl">Description</span><span class="draft-val">{a.description}</span></div>{/if}
        <div class="draft-field"><span class="draft-lbl">Role</span><span class="draft-val">{a.role || 'worker'}</span></div>
        {#if a.provider || a.model}<div class="draft-field"><span class="draft-lbl">Model</span><span class="draft-val">{[a.provider, a.model].filter(Boolean).join(' / ') || '—'}</span></div>{/if}
        <div class="draft-field"><span class="draft-lbl">Active</span><span class="draft-val">{a.active ? 'yes' : 'no'}</span></div>
        {#if draftModalData.recentRuns?.length}
          <div class="draft-field"><span class="draft-lbl">Recent</span><span class="draft-val">{draftModalData.recentRuns.length} run(s)</span></div>
          <div class="draft-body copy-wrap">
            <CopyTextBtn text={formatAgentRecentRuns(draftModalData.recentRuns)} title="Copy recent runs" />
            <pre class="draft-body-pre">{formatAgentRecentRuns(draftModalData.recentRuns)}</pre>
          </div>
        {/if}

      {:else if draftModalData?._type === 'contact'}
        {@const k = draftModalData.contact}
        <div class="draft-field"><span class="draft-lbl">Name</span><span class="draft-val draft-subject">{k.name || '?'}</span></div>
        {#if k.company}<div class="draft-field"><span class="draft-lbl">Company</span><span class="draft-val">{k.company}</span></div>{/if}
        {#if k.relationship}<div class="draft-field"><span class="draft-lbl">Relationship</span><span class="draft-val">{k.relationship}</span></div>{/if}
        {#if k.email && k.email !== ''}<div class="draft-field"><span class="draft-lbl">Email</span><span class="draft-val">{k.email}</span></div>{/if}
        {#if k.phone && k.phone !== ''}<div class="draft-field"><span class="draft-lbl">Phone</span><span class="draft-val">{k.phone}</span></div>{/if}
        {#if k.notes && k.notes !== ''}<div class="draft-body copy-wrap"><CopyTextBtn text={k.notes} title="Copy notes" /><pre class="draft-body-pre">{k.notes}</pre></div>{/if}

      {:else if draftModalData?._type === 'reminder'}
        {@const rem = draftModalData.reminder}
        <div class="draft-field"><span class="draft-lbl">Title</span><span class="draft-val draft-subject">{rem.title || '(no title)'}</span></div>
        {#if rem.trigger_at}<div class="draft-field"><span class="draft-lbl">Trigger</span><span class="draft-val">{String(rem.trigger_at).slice(0,16).replace('T',' ')}</span></div>{/if}
        <div class="draft-field"><span class="draft-lbl">Status</span><span class="draft-val">{rem.status}</span></div>
        <div class="draft-field"><span class="draft-lbl">Repeat</span><span class="draft-val">{rem.repeat}</span></div>
        {#if rem.snoozed_until}<div class="draft-field"><span class="draft-lbl">Snoozed until</span><span class="draft-val">{String(rem.snoozed_until).slice(0,16).replace('T',' ')}</span></div>{/if}
        {#if rem.last_fired_at}<div class="draft-field"><span class="draft-lbl">Last fired</span><span class="draft-val">{String(rem.last_fired_at).slice(0,16).replace('T',' ')}</span></div>{/if}
        <div class="draft-field"><span class="draft-lbl">Notify</span><span class="draft-val">{[rem.notify_mattermost ? 'Mattermost' : null, rem.notify_telegram ? 'Telegram' : null].filter(Boolean).join(', ') || '—'}</span></div>
        {#if rem.body && rem.body !== ''}
          <div class="draft-body copy-wrap">
            <CopyTextBtn text={rem.body} title="Copy body" />
            <pre class="draft-body-pre">{rem.body}</pre>
          </div>
        {/if}
      {/if}

      <div class="modal-actions">
        {#if draftModalData?.comm?.id}
          <a class="modal-cancel" href={'/comms/edit/' + draftModalData.comm.id} target="_blank" rel="noopener">Open editor →</a>
        {/if}
        <button class="modal-confirm" on:click={closeDraftModal}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Shared shell, duplicated from AgentWorld3D ────────────────
     Svelte scopes styles per component, so these have to exist here even
     though the parent still needs its own copy for the other modals.
     `.modal-error` is the exception — this was its last consumer, so it
     moved. `.copy-wrap` is not here at all: it is declared `:global` in the
     parent and reaches these elements on its own. */
  .modal-overlay{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center}
  .modal{background:#0e1018;border:1px solid rgba(74,79,106,.4);border-radius:16px;padding:24px;width:420px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.6);animation:mslide .2s ease-out}
  @keyframes mslide{from{transform:translateY(12px);opacity:0}}
  .modal-title{font:700 16px 'Syne',sans-serif;color:var(--text-1,#e0e2ea);margin-bottom:4px}
  .modal-sub{font:400 11px 'Manrope',sans-serif;color:var(--text-3,#4a4f6a);margin-bottom:16px;line-height:1.4}
  .modal-error{font:500 11px 'Manrope',sans-serif;color:#ef4444;background:rgba(239,68,68,.1);padding:6px 10px;border-radius:6px;margin-bottom:8px}
  .modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  .modal-cancel{padding:8px 18px;border-radius:8px;font:600 11px 'Manrope',sans-serif;background:#1a1d2a;border:1px solid rgba(74,79,106,.3);color:var(--text-2,#8a8fa8);cursor:pointer;transition:all .15s}
  .modal-cancel:hover{background:#22253a}
  .modal-confirm{padding:8px 18px;border-radius:8px;font:600 11px 'Syne',sans-serif;letter-spacing:.5px;background:#10b981;border:none;color:#fff;cursor:pointer;transition:all .15s}
  .modal-confirm:hover{filter:brightness(1.1)}

  /* Copied from the parent's `.ip-loading,.ip-empty` pair — only the loading
     half, since nothing here is ever an empty state. */
  .ip-loading{
    font:500 11px 'Manrope',sans-serif;color:#6a6f82;
    text-align:center;padding:24px 12px;
  }

  /* The base rule only. Its `:global(.ip-out-md …)` children stay in the
     parent and reach the rendered markdown from there. */
  .ip-out-md{
    font:400 12.5px/1.6 'Manrope',sans-serif;color:#d0d4e0;
    padding:14px 18px;border-radius:6px;background:rgba(0,0,0,.22);
    word-break:break-word;overflow-wrap:anywhere;max-height:380px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }

  /* ── Draft modal ── */
  .draft-modal{width:620px;max-width:92vw;padding:18px 20px}
  .draft-modal-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}
  .draft-modal-close{
    background:transparent;border:none;color:#8a8fa8;font:400 22px/1 'Manrope',sans-serif;
    cursor:pointer;padding:0 4px;transition:color .12s;
  }
  .draft-modal-close:hover{color:#fff}
  .draft-status{text-transform:uppercase;font:700 9px 'JetBrains Mono',monospace;color:#fbbf24;letter-spacing:.5px}
  .draft-field{
    display:flex;gap:10px;align-items:baseline;
    padding:4px 0;border-bottom:1px dashed rgba(120,130,160,.12);
    font:400 11px 'Manrope',sans-serif;
  }
  .draft-field:last-of-type{border-bottom:none}
  .draft-lbl{
    flex:0 0 70px;font:600 9px 'JetBrains Mono',monospace;
    color:#6a6f82;text-transform:uppercase;letter-spacing:.5px;
  }
  .draft-val{flex:1;color:#d0d4e0;word-break:break-word}
  .draft-subject{color:#fff;font-weight:600}
  .draft-body{margin:12px 0 4px;border:1px solid rgba(74,79,106,.25);border-radius:8px;overflow:hidden;background:#0a0c14}
  .draft-iframe{width:100%;height:340px;border:none;background:#fff;display:block}
  .draft-body-pre{
    margin:0;padding:12px 14px;max-height:340px;overflow-y:auto;
    font:400 11px/1.55 'JetBrains Mono',monospace;
    color:#d0d4e0;white-space:pre-wrap;word-break:break-word;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
</style>
