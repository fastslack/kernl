<!--
  OverviewTab — the drawer's first tab, in the order that answers the panel's
  questions in the order people ask them.

      VerdictLine        is this agent OK?
      <slot name="result">   what came out of the last run — the failure card
                             when it failed, the output when it did not
      MandateSection     what is it supposed to be (collapsed)
      <slot name="auth">     the one dependency that expires on its own
      TriggeringSection  what makes it run
      <slot name="footer">   the office environment, which is not the agent's

  It only reads. Everything that sets the agent up — engine, model, limits,
  goal, tools, variables, skin — lives in ConfigTab, grouped and explained.

  The three slots are the pieces that belong to whoever mounts the drawer: the
  3D world's run-output renderer, its Google re-login flow and its office
  panel all read state and call functions that only exist out there. They keep
  their place in the order instead of being pushed to the end.

  Everything else reads the agent from the store, which now loads its own
  detail row. The props that duplicate what the store already has
  (`prompt`, `triggers`, `schedules`, `connections`, `loading`) stay because
  the 3D world keeps its own detail fetch — it feeds more than this tab — and
  each of them falls back to the store when left null. Left null is what the
  embedded mount on /agents does, and it is the shorter path.
-->
<script lang="ts">
  import type { Readable } from 'svelte/store';
  import VerdictLine from '../VerdictLine.svelte';
  import MandateSection from '../sections/MandateSection.svelte';
  import TriggeringSection from '../sections/TriggeringSection.svelte';

  /** The drawer's agent store (`AgentDrawer` publishes it on the overview slot). */
  export let store: Readable<any> & { patch: (fields: Record<string, unknown>) => Promise<void> };
  /** Reserved for the embedded mount on /agents — tightens the spacing. */
  export let compact = false;

  // ── VerdictLine ──
  export let stats: { total_runs: number; completed: number; failed: number; success_rate: number } | null = null;
  export let lastRun: { status: string; created_at: string } | null = null;

  // ── MandateSection ──
  export let prompt: string | null = null;
  export let loading: boolean | null = null;

  // ── TriggeringSection ──
  export let chains: Array<{ out: boolean; name: string; label?: string }> = [];
  export let triggers: any[] | null = null;
  export let schedules: any[] | null = null;
  export let connections: { invokedBy?: any[]; invoked?: any[] } | null = null;

  /** Collapsed state, held by the caller so it survives a close/reopen. */
  export let collapsed: { mandate: boolean } = { mandate: false };

  $: agent = ($store ?? {}).agent ?? null;
</script>

<div class="ip-body">
  <VerdictLine {agent} {stats} {lastRun} />

  <slot name="result" />

  <MandateSection {store} {compact} {prompt} {loading} bind:collapsed={collapsed.mandate} />

  <slot name="auth" />

  <TriggeringSection {store} {compact} {chains} {triggers} {schedules} {connections} />

  <slot name="footer" />
</div>

<style>
  /* ── Body (scrollable) ────────── */
  /* A copy of the parent's rule: the other tab bodies still render their own
     `.ip-body`, and Svelte scopes CSS per component. */
  .ip-body{
    flex:1;overflow-y:auto;overflow-x:hidden;
    padding:16px 18px 16px;
    /* A column, so an open Mandate can take the height left below it. */
    display:flex;flex-direction:column;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  /* Nothing else in the column may be squeezed to make room for it. */
  .ip-body > :global(*){flex-shrink:0}
  .ip-body > :global(.ip-mandate-open){flex-shrink:1}
  .ip-body::-webkit-scrollbar{width:6px}
  .ip-body::-webkit-scrollbar-thumb{background:rgba(120,130,160,.2);border-radius:3px}
  .ip-body::-webkit-scrollbar-thumb:hover{background:rgba(120,130,160,.35)}
</style>
