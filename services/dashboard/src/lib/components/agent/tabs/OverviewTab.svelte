<!--
  OverviewTab — the drawer's first tab, in the order that answers the panel's
  questions in the order people ask them.

      VerdictLine        is this agent OK?
      <slot name="result">   what came out of the last run — the failure card
                             when it failed, the output when it did not
      MandateSection     what is it supposed to be (collapsed)
      <slot name="auth">     the one dependency that expires on its own
      TriggeringSection  what makes it run
      GoalSection        what it runs on when nobody says
      RuntimeSection     what carries it out — the only editable block
      ToolsSection       what it may touch (collapsed)
      VariablesSection   what it was handed (collapsed)
      AppearanceSection  what it looks like
      <slot name="footer">   the office environment, which is not the agent's

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
  import { createEventDispatcher } from 'svelte';
  import type { Readable } from 'svelte/store';
  import VerdictLine from '../VerdictLine.svelte';
  import MandateSection from '../sections/MandateSection.svelte';
  import TriggeringSection from '../sections/TriggeringSection.svelte';
  import GoalSection from '../sections/GoalSection.svelte';
  import RuntimeSection from '../sections/RuntimeSection.svelte';
  import ToolsSection from '../sections/ToolsSection.svelte';
  import VariablesSection from '../sections/VariablesSection.svelte';
  import AppearanceSection from '../sections/AppearanceSection.svelte';

  const dispatch = createEventDispatcher<{ skin: { skinId: string } }>();

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

  // ── RuntimeSection ──
  /** A run is in flight. Changes still save; they take effect next run. */
  export let running = false;
  /**
   * Bound out so the caller can reach RuntimeSection's methods — the run
   * failure card's remedies steer the model picker and the executor.
   */
  export let runtimeSection: RuntimeSection | null = null;

  // ── AppearanceSection ──
  export let skins: Array<{ manifest: { id: string; name: string; description?: string } }> = [];
  export let savingSkin = false;

  /** Collapsed state, held by the caller so it survives a close/reopen. */
  export let collapsed: { mandate: boolean; tools: boolean; variables: boolean } = {
    mandate: true,
    tools: true,
    variables: false,
  };

  /**
   * Is the detail row in? Runtime edits the three limits only that row
   * carries, so the block below waits for it exactly as it did inline.
   */
  export let ready = true;

  $: agent = ($store ?? {}).agent ?? null;
</script>

<div class="ip-body">
  <VerdictLine {agent} {stats} {lastRun} />

  <slot name="result" />

  <MandateSection {store} {compact} {prompt} {loading} bind:collapsed={collapsed.mandate} />

  <slot name="auth" />

  <TriggeringSection {store} {compact} {chains} {triggers} {schedules} {connections} />

  {#if ready}
    <GoalSection {store} {compact} />

    <RuntimeSection bind:this={runtimeSection} {store} {compact} {running} />

    <ToolsSection {store} {compact} bind:collapsed={collapsed.tools} />

    <VariablesSection {store} {compact} bind:collapsed={collapsed.variables} />

    <AppearanceSection
      {store}
      {compact}
      {skins}
      saving={savingSkin}
      on:change={(e) => dispatch('skin', e.detail)}
    />
  {/if}

  <slot name="footer" />
</div>

<style>
  /* ── Body (scrollable) ────────── */
  /* A copy of the parent's rule: the other tab bodies still render their own
     `.ip-body`, and Svelte scopes CSS per component. */
  .ip-body{
    flex:1;overflow-y:auto;overflow-x:hidden;
    padding:16px 18px 24px;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  .ip-body::-webkit-scrollbar{width:6px}
  .ip-body::-webkit-scrollbar-thumb{background:rgba(120,130,160,.2);border-radius:3px}
  .ip-body::-webkit-scrollbar-thumb:hover{background:rgba(120,130,160,.35)}
</style>
