<script lang="ts">
  /**
   * Sent-email viewer.
   *
   * An activity row whose tool result is an email send carries a "Ver email"
   * link; it calls `open(commId)` here and this fetches the real message —
   * from / to / subject / body — rather than showing the tool's JSON.
   *
   * The link itself stays in AgentWorld3D, next to the row it belongs to. What
   * moved is everything behind it: the fetch, the four pieces of state, and the
   * modal's styles.
   */
  import { getCommDetail } from '$lib/api.js';
  import { sanitizeHtml } from '$lib/sanitize.js';
  import { fmtClock } from '$lib/display-format.js';

  let emailModalOpen = false;
  let emailModalLoading = false;
  let emailModalError: string | null = null;
  let emailModalData: any = null;

  /** The only way in — the activity rows pass the communication id. */
  export async function open(commId: string): Promise<void> {
    emailModalOpen = true;
    emailModalLoading = true;
    emailModalError = null;
    emailModalData = null;
    try {
      const d: any = await getCommDetail(commId);
      if (!d || d.error) throw new Error(d?.error || 'No se encontró el email');
      emailModalData = d;
    } catch (err: any) {
      emailModalError = err?.message ? String(err.message) : String(err);
    } finally {
      emailModalLoading = false;
    }
  }

  function closeEmailModal(): void { emailModalOpen = false; emailModalData = null; emailModalError = null; }
</script>

{#if emailModalOpen}
  <div class="email-modal-backdrop" on:click={closeEmailModal} role="presentation">
    <div class="email-modal" on:click|stopPropagation role="dialog" aria-modal="true">
      <div class="email-modal-head">
        <span class="email-modal-title">📧 Email enviado</span>
        <button class="email-modal-close" on:click={closeEmailModal} title="Close">×</button>
      </div>
      {#if emailModalLoading}
        <div class="email-modal-body email-modal-dim">Loading email…</div>
      {:else if emailModalError}
        <div class="email-modal-body email-modal-err">⚠ {emailModalError}</div>
      {:else if emailModalData?.comm}
        {@const c = emailModalData.comm}
        {@const acc = emailModalData.account}
        {@const fromAddr = c.direction === 'outbound' ? (acc?.email ?? '—') : (acc?.email ?? '—')}
        <div class="email-modal-meta">
          <div class="emm-row"><span class="emm-k">De</span><span class="emm-v">{acc?.label ? acc.label + ' · ' : ''}{fromAddr}</span></div>
          <div class="emm-row"><span class="emm-k">Para</span><span class="emm-v">{c.recipients_to || '—'}</span></div>
          {#if c.recipients_cc}<div class="emm-row"><span class="emm-k">CC</span><span class="emm-v">{c.recipients_cc}</span></div>{/if}
          <div class="emm-row"><span class="emm-k">Asunto</span><span class="emm-v emm-subj">{c.subject || '(sin asunto)'}</span></div>
          {#if c.sent_at}<div class="emm-row"><span class="emm-k">Enviado</span><span class="emm-v">{fmtClock(c.sent_at)} · {c.status}</span></div>{/if}
        </div>
        <div class="email-modal-body">
          {#if c.body_html}
            <div class="email-modal-html">{@html sanitizeHtml(c.body_html)}</div>
          {:else}
            <div class="email-modal-text">{c.body || '(sin cuerpo)'}</div>
          {/if}
        </div>
      {:else}
        <div class="email-modal-body email-modal-dim">No se encontró el email.</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Moved wholesale from AgentWorld3D — nothing else used these. The
     `.email-view-link` chip stayed behind, because the link that opens this
     modal lives in the activity row, not here. */
  .email-modal-backdrop{
    position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center;
    background:rgba(2,2,6,.72); backdrop-filter:blur(3px); padding:24px;
  }
  .email-modal{
    width:min(680px,94vw); max-height:86vh; display:flex; flex-direction:column;
    background:#0d1018; border:1px solid #2a3350; border-radius:12px;
    box-shadow:0 18px 60px rgba(0,0,0,.6); overflow:hidden;
  }
  .email-modal-head{
    display:flex; align-items:center; justify-content:space-between;
    padding:12px 16px; border-bottom:1px solid #1e2335; background:#11151f;
  }
  .email-modal-title{ font:700 13px 'Manrope',sans-serif; color:#e6ecff; }
  .email-modal-close{
    width:26px; height:26px; border-radius:6px; border:1px solid #2a3350; background:transparent;
    color:#9aa3bd; font-size:18px; line-height:1; cursor:pointer;
  }
  .email-modal-close:hover{ background:#1a1f30; color:#fff; }
  .email-modal-meta{ padding:12px 16px; border-bottom:1px solid #1a1f30; display:flex; flex-direction:column; gap:4px; }
  .emm-row{ display:grid; grid-template-columns:64px 1fr; gap:8px; font:500 12px 'Manrope',sans-serif; }
  .emm-k{ color:#6b7390; font-weight:600; text-transform:uppercase; font-size:10px; padding-top:2px; }
  .emm-v{ color:#cdd5ec; word-break:break-word; }
  .emm-subj{ color:#fff; font-weight:600; }
  .email-modal-body{ padding:14px 16px; overflow:auto; }
  .email-modal-text{ font:400 13px/1.6 'Manrope',sans-serif; color:#cdd5ec; white-space:pre-wrap; }
  .email-modal-html{ font-size:13px; line-height:1.6; color:#cdd5ec; }
  .email-modal-html :global(a){ color:#9fd0ff; }
  .email-modal-dim{ color:#6b7390; }
  .email-modal-err{ color:#ff8a8a; }
</style>
