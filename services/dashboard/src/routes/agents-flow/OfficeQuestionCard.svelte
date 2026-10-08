<!--
  OfficeQuestionCard — one question an agent pinned for the operator: who asks,
  what, the chief's reason for escalating it, the four options and a free
  answer. Rendered in the chief's office twice (the "needs you" strip and the
  Questions tab), so it is one component; the writes stay with the panel,
  which owns the list, and arrive here as callbacks.
-->
<script lang="ts">
  import { t } from '$lib/i18n/index.js';
  import { fmtRelTime } from '$lib/display-format.js';
  import { firstUrlIn, urlForOption } from '$lib/agent-helpers.js';
  import type { PendingQuestion } from './world-types.js';

  export let q: PendingQuestion;
  export let agentName: string;
  export let color: string;
  export let busy = false;
  export let onAnswer: (q: PendingQuestion, idx: number, opt: { label: string; value?: string; url?: string }) => void;
  export let onDismiss: (q: PendingQuestion) => void;
  export let onFree: (q: PendingQuestion, text: string) => Promise<boolean>;

  let free = '';
  $: ctxUrl = firstUrlIn(q.context);

  async function submitFree(): Promise<void> {
    const text = free.trim();
    if (!text || busy) return;
    if (await onFree(q, text)) free = '';
  }

  // The AI's own take, offered as a fifth option. Asking answers nothing;
  // taking it sends the opinion as a free answer.
  interface Opinion { answer: string; reasoning: string; matches_option: number | null }
  let opinion: Opinion | null = null;
  let opinionLoading = false;
  let opinionError = '';
  /** Why there is no opinion, as the kernel classified it: drives the sentence shown. */
  let opinionReason: 'no_answer' | 'unavailable' | '' = '';

  async function askOpinion(): Promise<void> {
    if (opinionLoading) return;
    opinionLoading = true;
    opinionError = '';
    opinionReason = '';
    try {
      const res = await fetch(`/api/agents/questions/${q.id}/opinion`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.opinion) {
        // An older kernel sends no `reason`; its message still tells the two apart.
        const msg = String(body?.detail ?? body?.error ?? '');
        opinionReason = body?.reason === 'no_answer' || (!body?.reason && /did not return JSON|no answer/i.test(msg))
          ? 'no_answer' : 'unavailable';
        throw new Error(body?.detail ?? body?.error ?? `HTTP ${res.status}`);
      }
      opinion = body.opinion;
    } catch (e) {
      // The raw text (a model's half-finished thinking, a provider error) is
      // for "see details"; the card says what happened and what to do.
      opinionError = e instanceof Error ? e.message : String(e);
      if (!opinionReason) opinionReason = 'unavailable';
    } finally {
      opinionLoading = false;
    }
  }

  function takeOpinion(): void {
    if (!opinion || busy) return;
    const pick = opinion.matches_option;
    if (pick !== null && q.options[pick]) onAnswer(q, pick, q.options[pick]);
    else void onFree(q, opinion.answer);
  }
</script>

<div class="bq-card">
  <div class="bq-head">
    <span class="bq-from-dot" style="background:{color}"></span>
    <span class="bq-from">{agentName}</span>
    <span class="bq-time">{fmtRelTime(q.created_at)}</span>
    <button class="bq-dismiss" title={$t('office.chief.q_dismiss')} aria-label={$t('office.chief.q_dismiss')}
            on:click={() => onDismiss(q)} disabled={busy}>×</button>
  </div>
  <div class="bq-question">{q.question}</div>
  {#if q.chief_note}
    <div class="bq-chief-note">{$t('office.chief.q_escalated')}: {q.chief_note}</div>
  {/if}
  {#if q.context}
    <details class="bq-context">
      <summary>{$t('office.chief.q_context')}</summary>
      <div class="bq-context-body">{q.context}</div>
    </details>
  {/if}
  {#if ctxUrl}
    <a class="bq-direct-link" href={ctxUrl} target="_blank" rel="noopener noreferrer" title={ctxUrl}>
      🔗 {new URL(ctxUrl).host}
    </a>
  {/if}
  <div class="bq-options">
    {#each q.options as opt, i (i)}
      {@const optUrl = urlForOption(q, opt)}
      <button class="bq-option" class:bq-option-link={!!optUrl} class:bq-option-pick={opinion?.matches_option === i}
              on:click={() => onAnswer(q, i, opt)}
              disabled={busy}
              title={opinion?.matches_option === i && opinion.reasoning ? opinion.reasoning : optUrl ? `Opens ${optUrl}` : opt.label}>
        <span class="bq-option-idx">{i + 1}</span>
        <span class="bq-option-lbl">{opt.label}</span>
        {#if opinion?.matches_option === i}<span class="bq-pick-tag">{$t('office.chief.q_opinion_pick')}</span>{/if}
        {#if optUrl}<span class="bq-option-linkico" aria-hidden="true">↗</span>{/if}
      </button>
    {/each}

    {#if opinion && opinion.matches_option !== null}
      <!-- It picked one of the chief's options: the tag on that option says it all. -->
    {:else if opinion}
      <div class="bq-opinion" aria-live="polite">
        <div class="bq-opinion-head">
          <span class="bq-option-idx bq-ai-idx">{q.options.length + 1}</span>
          <span class="bq-opinion-title">{$t('office.chief.q_opinion_label')}</span>
        </div>
        <p class="bq-opinion-answer">{opinion.answer}</p>
        {#if opinion.reasoning}<p class="bq-opinion-why">{opinion.reasoning}</p>{/if}
        <div class="bq-opinion-actions">
          <button class="bq-opinion-retry" type="button" on:click={askOpinion} disabled={opinionLoading || busy}>
            {opinionLoading ? $t('office.chief.q_opinion_loading') : $t('office.chief.q_opinion_retry')}
          </button>
          <button class="bq-opinion-send" type="button" on:click={takeOpinion} disabled={busy || opinionLoading}>{$t('office.chief.q_opinion_send')}</button>
        </div>
      </div>
    {:else}
      <button class="bq-ask-ai" type="button" on:click={askOpinion} disabled={opinionLoading || busy}>
        <span class="bq-option-idx bq-ai-idx">{q.options.length + 1}</span>
        {#if opinionLoading}
          <span class="bq-spin" aria-hidden="true"></span>{$t('office.chief.q_opinion_loading')}
        {:else}
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>
          {$t('office.chief.q_opinion_ask')}
        {/if}
      </button>
      {#if opinionError}
        <div class="bq-opinion-err" role="alert">
          <p>{$t(opinionReason === 'no_answer' ? 'office.chief.q_opinion_no_answer' : 'office.chief.q_opinion_unavailable')}</p>
          <div class="bq-opinion-err-actions">
            <button type="button" class="bq-opinion-retry" on:click={askOpinion} disabled={opinionLoading || busy}>{$t('office.chief.q_opinion_try_again')}</button>
            {#if opinionReason === 'unavailable'}<a class="bq-opinion-link" href="/settings?section=ai&card=providers">{$t('office.chief.q_opinion_open_ai')}</a>{/if}
            <details class="bq-opinion-detail">
              <summary>{$t('office.chief.q_opinion_details')}</summary>
              <pre>{opinionError}</pre>
            </details>
          </div>
        </div>
      {/if}
    {/if}
  </div>
  <form class="bq-free" on:submit|preventDefault={submitFree}>
    <input class="bq-free-input" placeholder={$t('office.chief.q_other')} bind:value={free} disabled={busy}
           aria-label={$t('office.chief.q_other')} />
    <button class="bq-free-send" type="submit" disabled={busy || !free.trim()}>{$t('office.chief.q_send')}</button>
  </form>
</div>

<style>
  .bq-card{
    background:linear-gradient(180deg, rgba(240,184,116,.08) 0%, rgba(240,184,116,.02) 100%);
    border:1px solid rgba(240,184,116,.25); border-left:3px solid #f0b874;
    border-radius:8px; padding:10px 12px;
  }
  .bq-head{ display:flex; align-items:center; gap:8px; margin-bottom:6px; font:600 10px 'JetBrains Mono',monospace; color:#cbd0e8; }
  .bq-from-dot{ width:7px; height:7px; border-radius:50%; }
  .bq-from{ color:#e7e9f4; }
  .bq-time{ margin-left:auto; color:#6b7090; font-size:9px; }
  .bq-dismiss{
    background:transparent; border:none; color:#6b7090; font-size:16px;
    cursor:pointer; padding:0 3px; line-height:1;
  }
  .bq-dismiss:hover{ color:#ef5d6e; }
  .bq-question{
    font:600 13px/1.45 'Manrope',sans-serif; color:#e7e9f4;
    margin:0 0 8px; word-break:break-word;
  }
  .bq-context{ margin:0 0 8px; }
  .bq-context summary{
    cursor:pointer; color:#8b90af; font:500 10px 'JetBrains Mono',monospace;
    list-style:none;
  }
  .bq-context summary::-webkit-details-marker{ display:none; }
  .bq-context summary::before{ content:'▸ '; color:#6b7090; }
  .bq-context[open] summary::before{ content:'▾ '; }
  .bq-context-body{
    margin-top:6px; padding:8px 10px; background:#0a0b14; border:1px solid #1f2236;
    border-radius:4px; font:500 11px/1.5 'JetBrains Mono',monospace; color:#8b90af;
    white-space:pre-wrap; word-break:break-word; max-height:160px; overflow-y:auto;
  }
  .bq-options{ display:grid; grid-template-columns:1fr 1fr; gap:5px; }
  .bq-option{
    display:flex; align-items:center; gap:8px;
    padding:8px 10px; background:#161827; color:#cbd0e8;
    border:1px solid #2a2f4a; border-radius:5px;
    font:600 11px 'Manrope',sans-serif;
    cursor:pointer; transition:all .12s; text-align:left;
  }
  .bq-option:hover:not(:disabled){
    background:#252840; border-color:#f0b874; color:#f4e1a3;
    transform:translateY(-1px);
  }
  .bq-option:disabled{ opacity:.5; cursor:not-allowed; }
  .bq-option-idx{
    flex-shrink:0; width:20px; height:20px; border-radius:3px;
    background:#0a0b14; display:inline-flex; align-items:center; justify-content:center;
    font:700 10px 'JetBrains Mono',monospace; color:#f0b874;
  }
  .bq-option-lbl{ flex:1; word-break:break-word; }
  /* Options that open a URL — make them visually distinct (subtle teal tint
     + arrow chevron). */
  .bq-option-link{
    border-color:rgba(61,214,200,.35);
    background:linear-gradient(180deg, #161827 0%, #15212a 100%);
  }
  .bq-option-link:hover:not(:disabled){
    border-color:#3dd6c8;
    background:linear-gradient(180deg, #1a2f33 0%, #142329 100%);
    color:#a8e4dc;
  }
  .bq-option-link .bq-option-idx{ color:#3dd6c8; }
  .bq-option-linkico{
    flex-shrink:0; color:#3dd6c8; font:700 11px 'JetBrains Mono',monospace;
    opacity:.7; transition:opacity .12s, transform .12s;
  }
  .bq-option-link:hover:not(:disabled) .bq-option-linkico{
    opacity:1; transform:translate(2px,-2px);
  }
  /* The AI's opinion: a violet fifth slot under the chief's four options. */
  .bq-ask-ai, .bq-opinion{ grid-column:1 / -1; }
  .bq-ask-ai{
    display:flex; align-items:center; gap:8px; padding:8px 10px;
    background:rgba(167,139,250,.06); color:#c4b5fd;
    border:1px dashed rgba(167,139,250,.45); border-radius:5px;
    font:600 11px 'Manrope',sans-serif; cursor:pointer; text-align:left; transition:all .12s;
  }
  .bq-ask-ai:hover:not(:disabled){ background:rgba(167,139,250,.14); border-style:solid; color:#e4dcff; }
  .bq-ask-ai:disabled{ cursor:progress; }
  .bq-ai-idx{ color:#a78bfa !important; }
  .bq-spin{ width:11px; height:11px; border-radius:50%; border:2px solid rgba(167,139,250,.3); border-top-color:#a78bfa; animation:bq-spin .8s linear infinite; }
  @keyframes bq-spin{ to{ transform:rotate(360deg); } }
  .bq-opinion{
    padding:9px 10px; border-radius:6px;
    background:linear-gradient(180deg, rgba(167,139,250,.14) 0%, rgba(167,139,250,.05) 100%);
    border:1px solid rgba(167,139,250,.45);
  }
  .bq-opinion-head{ display:flex; align-items:center; gap:8px; }
  .bq-opinion-title{ font:700 11px 'Manrope',sans-serif; color:#e4dcff; }
  .bq-opinion-answer{ margin:7px 0 0; font:600 12px/1.5 'Manrope',sans-serif; color:#f1edff; word-break:break-word; }
  .bq-opinion-why{ margin:5px 0 0; font:500 10.5px/1.5 'Manrope',sans-serif; color:#a9a3c9; word-break:break-word; }
  .bq-opinion-actions{ display:flex; justify-content:flex-end; gap:6px; margin-top:8px; }
  .bq-opinion-retry, .bq-opinion-send{ padding:6px 11px; border-radius:5px; font:600 11px 'Manrope',sans-serif; cursor:pointer; }
  .bq-opinion-retry{ background:transparent; color:#c4b5fd; border:1px solid rgba(167,139,250,.35); }
  .bq-opinion-send{ background:#a78bfa; color:#1a1430; border:1px solid #a78bfa; }
  .bq-opinion-send:hover:not(:disabled){ filter:brightness(1.08); }
  .bq-opinion-retry:disabled, .bq-opinion-send:disabled{ opacity:.5; cursor:default; }
  .bq-opinion-err{ grid-column:1 / -1; margin:0; font:500 11px 'Manrope',sans-serif; color:#e8b04b; display:flex; flex-direction:column; gap:6px; }
  .bq-opinion-err p{ margin:0; }
  .bq-opinion-err-actions{ display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
  .bq-opinion-link{ color:#9fb4e8; font-size:11px; text-decoration:none; }
  .bq-opinion-link:hover{ text-decoration:underline; }
  .bq-opinion-detail{ color:#8b93aa; font-size:10.5px; }
  .bq-opinion-detail summary{ cursor:pointer; }
  .bq-opinion-detail pre{ margin:4px 0 0; max-height:90px; overflow:auto; white-space:pre-wrap; font:500 10px 'JetBrains Mono',monospace; color:#8b93aa; }
  .bq-option-pick{ border-color:#a78bfa; box-shadow:inset 0 0 0 1px rgba(167,139,250,.35); }
  .bq-pick-tag{ flex-shrink:0; font:700 9px 'JetBrains Mono',monospace; color:#1a1430; background:#a78bfa; padding:1px 6px; border-radius:8px; text-transform:uppercase; }
  @media (prefers-reduced-motion: reduce){ .bq-spin{ animation:none; } }
  .bq-chief-note{ font:500 10.5px 'Manrope',sans-serif; color:#f0b86e; background:#2a2214; border-left:2px solid #f0b86e; padding:5px 8px; border-radius:3px; margin:4px 0 6px; }
  .bq-free{ display:flex; gap:5px; margin-top:6px; }
  .bq-free-input{ flex:1; min-width:0; padding:7px 9px; background:#11131f; color:#cbd0e8; border:1px solid #2a2f4a; border-radius:5px; font:500 11px 'Manrope',sans-serif; }
  .bq-free-send{ padding:7px 11px; background:#1f2440; color:#cbd0e8; border:1px solid #2a2f4a; border-radius:5px; font:600 11px 'Manrope',sans-serif; cursor:pointer; }
  .bq-free-send:disabled{ opacity:.45; cursor:default; }
  /* Direct link chip — surfaces the URL from `context` above the options
     so the user can preview the link without having to commit to an answer. */
  .bq-direct-link{
    display:inline-flex; align-items:center; gap:5px;
    margin:6px 0 2px;
    padding:4px 9px;
    border:1px solid rgba(61,214,200,.3);
    background:rgba(61,214,200,.08);
    border-radius:14px;
    color:#88e0d6; text-decoration:none;
    font:600 10.5px 'JetBrains Mono',monospace;
    letter-spacing:.2px;
    transition:all .12s;
    max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .bq-direct-link:hover{
    background:rgba(61,214,200,.16);
    border-color:rgba(61,214,200,.5);
    color:#c8f0ea;
  }
</style>
