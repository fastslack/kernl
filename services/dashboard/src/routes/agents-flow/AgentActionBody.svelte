<!--
  AgentActionBody — the inside of a LIVE / HISTORY row where an agent acted
  on another agent (see $lib/agent-actions.ts): the icon the 3D world pops
  over the desk, what it did and to whom in plain words, what it said, and
  whether it landed — with the kernel's reason when it did not.

  The row around it (dot, button, expand) belongs to each tab; this is only
  the content, so both tabs read the same. `compact` is the hero's version:
  no body, no 3D hint.
-->
<script lang="ts">
  import { t } from '$lib/i18n/index.js';
  import { plainActionText, type AgentAction } from '$lib/agent-actions.js';

  export let action: AgentAction;
  export let compact = false;

  $: title = $t(`agent.action.${action.kind}`, { target: action.target || '—' });
  $: outcome = action.outcome === 'pending'
    ? $t('agent.action.pending')
    : action.kind === 'message'
      ? $t(action.outcome === 'ok' ? 'agent.action.message.ok' : 'agent.action.message.failed')
      : $t(action.outcome === 'ok' ? 'agent.action.ok' : 'agent.action.failed');
  // The kernel's failure, in the operator's words when the case is known.
  $: why = (() => {
    if (action.outcome !== 'failed' || !action.failure) return '';
    const noAgent = /No agent named "([^"]+)" found/.exec(action.failure);
    return noAgent ? $t('agent.action.fail.no_agent', { name: noAgent[1] }) : action.failure;
  })();
  // What the same moment looks like in the 3D world, where we know it.
  $: seen = action.kind === 'message'
    ? $t('agent.action.message.seen')
    : action.kind === 'edit' ? $t('agent.action.edit.seen') : '';
</script>

<span class="aa-icon" aria-hidden="true">{action.icon}</span>
<span class="aa-main">
  <span class="aa-title">{title}</span>
  {#if action.headline}<span class="aa-headline">{action.headline}</span>{/if}
  {#if action.body && !compact}<span class="aa-body">{plainActionText(action.body)}</span>{/if}
  <span class="aa-outcome aa-{action.outcome}">
    <span class="aa-pill">{outcome}</span>
    {#if why}<span class="aa-why">{why}</span>{/if}
  </span>
  {#if seen && !compact}<span class="aa-seen">{seen}</span>{/if}
</span>

<style>
  .aa-icon{font-size:17px;line-height:1.15;flex-shrink:0}
  .aa-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1;text-align:left}
  .aa-title{font:700 12px 'Manrope',sans-serif;color:#eef0f6}
  .aa-headline{font:600 11.5px 'Manrope',sans-serif;color:#d6d9e4;overflow-wrap:anywhere}
  .aa-body{
    font:500 11px/1.45 'Manrope',sans-serif;color:#9aa0b6;
    display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  }
  .aa-outcome{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:2px}
  .aa-pill{
    flex:none;padding:1px 8px;border-radius:999px;
    font:700 10px 'Manrope',sans-serif;
    color:#9aa3c0;background:rgba(154,163,192,.12);
  }
  .aa-ok .aa-pill{color:#78dc8c;background:rgba(120,220,140,.12)}
  .aa-failed .aa-pill{color:#ff8fa0;background:rgba(239,93,110,.16)}
  .aa-pending .aa-pill{color:#f0b44c;background:rgba(240,180,76,.12)}
  .aa-why{font:500 11px/1.4 'Manrope',sans-serif;color:#ffb3bd}
  .aa-seen{font:500 10px 'Manrope',sans-serif;color:#6f7590;font-style:italic}
</style>
