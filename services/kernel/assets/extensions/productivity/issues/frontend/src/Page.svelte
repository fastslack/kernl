<script lang="ts">
  // /issues — migrated from services/dashboard/src/routes/issues/+page.svelte
  // (Fase 2b). Read-only over the shell "issues" + "house" stores; the shell
  // keeps hydrating them (issues WS channel for this path, house via layout).
  import Badge from '$shared/components/Badge.svelte';
  import { fmtTime } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const issues = ctx.getStore('issues') as any;
  const house = ctx.getStore('house') as any;

  // Tab state
  let activeTab: 'dev' | 'home' = 'dev';

  // Dev Issues data
  $: devData = $issues as any;
  $: hasProviders = (devData?.providers?.length ?? 0) > 0;

  // Home Incidents data
  $: homeData = $house as any;
  $: allIncidents = (homeData?.openIncidents ?? []) as any[];

  // Dev issues computed
  $: kpis = devData?.kpis ?? { total: 0, open: 0, closed: 0, prs: 0 };
  $: providers = (devData?.providers ?? []) as any[];
  $: byRepo = (devData?.byRepo ?? []) as any[];
  $: velocity = (devData?.velocity ?? []) as any[];
  $: staleIssues = (devData?.staleIssues ?? []) as any[];
  $: recentlyClosed = (devData?.recentlyClosed ?? []) as any[];
  $: byLabel = (devData?.byLabel ?? []) as any[];
  $: assigneeWorkload = (devData?.assigneeWorkload ?? []) as any[];
  $: avgCloseTime = devData?.avgCloseTimeDays ?? 0;

  // Home incidents computed
  $: openIncidents = allIncidents.filter((i: any) => i.status === 'open');
  $: inProgressIncidents = allIncidents.filter((i: any) => i.status === 'in_progress');

  // Velocity
  $: velocityMax = Math.max(1, ...velocity.map((v: any) => Math.max(v.opened, v.closed)));
  function velHeight(val: number): number {
    return Math.max(2, (val / velocityMax) * 32);
  }

  function severityColor(sev: string) {
    if (sev === 'emergency') return 'overdue';
    if (sev === 'urgent') return 'high';
    return 'medium';
  }
</script>

<div class="issues-compact">
  <!-- Tabs -->
  <div class="tabs-row">
    <button class="tab" class:active={activeTab === 'dev'} on:click={() => activeTab = 'dev'}>
      Dev Issues {#if kpis.open > 0}<span class="cnt">{kpis.open}</span>{/if}
    </button>
    <button class="tab" class:active={activeTab === 'home'} on:click={() => activeTab = 'home'}>
      Home {#if openIncidents.length > 0}<span class="cnt">{openIncidents.length}</span>{/if}
    </button>
  </div>

  {#if activeTab === 'dev'}
    {#if !devData}
      <div class="loading">Loading...</div>
    {:else if !hasProviders}
      <!-- Setup -->
      <div class="setup-box">
        <div class="setup-title">Connect GitHub or GitLab</div>
        <div class="setup-grid">
          <div class="setup-card">
            <strong>GitHub</strong>
            <p>1. Create token at <a href="https://github.com/settings/tokens" target="_blank">github.com/settings/tokens</a> with <code>repo</code> scope</p>
            <p>2. Run: <code>kernel_issues_configure</code> with provider: "github", token: "ghp_..."</p>
            <p>3. Sync: <code>kernel_issues_sync</code> with repos: ["owner/repo"]</p>
          </div>
          <div class="setup-card">
            <strong>GitLab</strong>
            <p>1. Create token at <a href="https://gitlab.com/-/user_settings/personal_access_tokens" target="_blank">GitLab Access Tokens</a> with <code>read_api</code></p>
            <p>2. Run: <code>kernel_issues_configure</code> with provider: "gitlab", token: "glpat-..."</p>
            <p>3. Sync: <code>kernel_issues_sync</code> with repos: ["group/project"]</p>
          </div>
        </div>
      </div>
    {:else}
      <!-- Dashboard -->
      <div class="dash-grid">
        <!-- KPIs -->
        <div class="kpi-strip">
          <div class="kpi"><span class="kpi-val" style="color:var(--red)">{kpis.open}</span><span class="kpi-lbl">Open</span></div>
          <div class="kpi"><span class="kpi-val" style="color:var(--green)">{kpis.closed}</span><span class="kpi-lbl">Closed</span></div>
          <div class="kpi"><span class="kpi-val" style="color:var(--purple)">{kpis.prs}</span><span class="kpi-lbl">PRs</span></div>
          <div class="kpi"><span class="kpi-val" style="color:var(--orange)">{staleIssues.length}</span><span class="kpi-lbl">Stale</span></div>
          {#each providers as p}
            <div class="kpi provider">
              <span class="kpi-val">{p.repoCount}</span>
              <span class="kpi-lbl">{p.provider === 'github' ? 'GH' : 'GL'} repos</span>
            </div>
          {/each}
        </div>

        <!-- Row 1 -->
        <div class="panels-row">
          <!-- Repos -->
          <div class="panel">
            <div class="panel-head">By Repository</div>
            <div class="repo-list">
              {#each byRepo.slice(0, 5) as r}
                <div class="repo-row">
                  <span class="repo-name">{r.repo.split('/').pop()}</span>
                  <div class="repo-bar-wrap">
                    <div class="repo-bar" style="width:{Math.max(4, (r.open / Math.max(1, byRepo[0]?.open)) * 100)}%"></div>
                  </div>
                  <span class="repo-num">{r.open}</span>
                </div>
              {/each}
            </div>
          </div>

          <!-- Velocity -->
          <div class="panel">
            <div class="panel-head">Velocity (8w)</div>
            <div class="vel-chart">
              {#each velocity as w, i}
                <div class="vel-week">
                  <div class="vel-bars">
                    <div class="vel-bar op" style="height:{velHeight(w.opened)}px" title="Opened: {w.opened}"></div>
                    <div class="vel-bar cl" style="height:{velHeight(w.closed)}px" title="Closed: {w.closed}"></div>
                  </div>
                  <span class="vel-lbl">{i + 1}</span>
                </div>
              {/each}
            </div>
            <div class="vel-legend">
              <span><i class="dot op"></i>Open</span>
              <span><i class="dot cl"></i>Close</span>
            </div>
          </div>

          <!-- Labels -->
          <div class="panel">
            <div class="panel-head">Top Labels</div>
            <div class="label-list">
              {#each byLabel.slice(0, 5) as lbl}
                <div class="label-row">
                  <span class="label-name">{lbl.label}</span>
                  <span class="label-cnt">{lbl.count}</span>
                </div>
              {/each}
              {#if byLabel.length === 0}
                <div class="empty-msg">No labels</div>
              {/if}
            </div>
          </div>
        </div>

        <!-- Row 2 -->
        <div class="panels-row">
          <!-- Stale -->
          <div class="panel">
            <div class="panel-head">Stale ({staleIssues.length})</div>
            <div class="stale-list">
              {#each staleIssues.slice(0, 4) as issue}
                <div class="stale-row">
                  <span class="stale-title">{issue.title.slice(0, 35)}{issue.title.length > 35 ? '...' : ''}</span>
                  <span class="stale-days">{issue.daysSinceUpdate}d</span>
                </div>
              {/each}
              {#if staleIssues.length === 0}
                <div class="empty-msg">No stale issues</div>
              {/if}
            </div>
          </div>

          <!-- Recently Closed -->
          <div class="panel">
            <div class="panel-head">Recently Closed</div>
            <div class="closed-list">
              {#each recentlyClosed.slice(0, 4) as issue}
                <div class="closed-row">
                  <span class="closed-title">{issue.title.slice(0, 35)}{issue.title.length > 35 ? '...' : ''}</span>
                  <span class="closed-date">{fmtTime(issue.closed_at)}</span>
                </div>
              {/each}
              {#if recentlyClosed.length === 0}
                <div class="empty-msg">None recently</div>
              {/if}
            </div>
          </div>

          <!-- Assignees -->
          <div class="panel">
            <div class="panel-head">Workload</div>
            <div class="assignee-list">
              {#each assigneeWorkload.slice(0, 4) as a}
                <div class="assignee-row">
                  <span class="assignee-name">{a.assignee}</span>
                  <span class="assignee-cnt">{a.openCount}</span>
                </div>
              {/each}
              {#if assigneeWorkload.length === 0}
                <div class="empty-msg">No assignees</div>
              {/if}
              {#if avgCloseTime > 0}
                <div class="avg-close">Avg close: {avgCloseTime.toFixed(1)}d</div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    {/if}

  {:else}
    <!-- Home Tab -->
    {#if !homeData}
      <div class="loading">Loading...</div>
    {:else}
      <div class="home-grid">
        <div class="kpi-strip">
          <div class="kpi"><span class="kpi-val" style="color:var(--red)">{openIncidents.length}</span><span class="kpi-lbl">Open</span></div>
          <div class="kpi"><span class="kpi-val" style="color:var(--gold)">{inProgressIncidents.length}</span><span class="kpi-lbl">In Progress</span></div>
        </div>
        <div class="incidents-list">
          {#each allIncidents.slice(0, 6) as inc}
            <div class="inc-row">
              <Badge text={inc.severity} variant={severityColor(inc.severity)} />
              <span class="inc-title">{inc.title}</span>
              <span class="inc-date">{fmtTime(inc.date_reported)}</span>
            </div>
          {/each}
          {#if allIncidents.length === 0}
            <div class="empty-msg">No incidents</div>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .issues-compact {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 120px);
    overflow: hidden;
  }
  .tabs-row {
    display: flex;
    gap: 6px;
    margin-bottom: 12px;
    flex-shrink: 0;
  }
  .tab {
    padding: 6px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tab:hover { background: var(--surface-3); }
  .tab.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .tab .cnt {
    background: rgba(255,255,255,0.2);
    padding: 1px 5px;
    border-radius: 8px;
    font-size: 10px;
  }
  .loading { color: var(--text-3); font-size: 13px; }

  /* Setup */
  .setup-box { flex: 1; }
  .setup-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
  .setup-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .setup-card {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    font-size: 12px;
    line-height: 1.6;
  }
  .setup-card strong { display: block; margin-bottom: 8px; font-size: 13px; }
  .setup-card p { margin: 4px 0; color: var(--text-2); }
  .setup-card a { color: var(--accent); }
  .setup-card code { background: var(--surface-3); padding: 1px 4px; border-radius: 3px; font-size: 11px; }

  /* Dashboard */
  .dash-grid { display: flex; flex-direction: column; flex: 1; gap: 10px; min-height: 0; }
  .kpi-strip {
    display: flex;
    gap: 16px;
    flex-shrink: 0;
    padding: 10px 14px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .kpi { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .kpi-val { font-size: 18px; font-weight: 700; font-family: var(--font-mono); }
  .kpi-lbl { font-size: 10px; color: var(--text-3); text-transform: uppercase; }
  .kpi.provider { margin-left: auto; }
  .kpi.provider:first-of-type { margin-left: auto; }

  .panels-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 10px;
    flex: 1;
    min-height: 0;
  }
  .panel {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .panel-head {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-2);
    text-transform: uppercase;
    margin-bottom: 8px;
    flex-shrink: 0;
  }

  /* Repos */
  .repo-list { display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
  .repo-row { display: flex; align-items: center; gap: 8px; }
  .repo-name { font-size: 11px; color: var(--text-2); width: 70px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .repo-bar-wrap { flex: 1; height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; }
  .repo-bar { height: 100%; background: var(--accent); border-radius: 3px; }
  .repo-num { font-size: 11px; font-weight: 600; color: var(--text-1); width: 24px; text-align: right; }

  /* Velocity */
  .vel-chart { display: flex; justify-content: space-between; align-items: flex-end; height: 50px; gap: 4px; flex: 1; }
  .vel-week { display: flex; flex-direction: column; align-items: center; gap: 3px; flex: 1; }
  .vel-bars { display: flex; gap: 1px; align-items: flex-end; }
  .vel-bar { width: 8px; border-radius: 2px 2px 0 0; min-height: 2px; }
  .vel-bar.op { background: var(--red); }
  .vel-bar.cl { background: var(--green); }
  .vel-lbl { font-size: 9px; color: var(--text-3); }
  .vel-legend { display: flex; gap: 12px; margin-top: 6px; font-size: 10px; color: var(--text-3); flex-shrink: 0; }
  .vel-legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
  .vel-legend .dot.op { background: var(--red); }
  .vel-legend .dot.cl { background: var(--green); }

  /* Stale */
  .stale-list { display: flex; flex-direction: column; gap: 4px; overflow: hidden; flex: 1; }
  .stale-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .stale-title { font-size: 11px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .stale-days { font-size: 10px; color: var(--orange); font-weight: 600; flex-shrink: 0; }

  /* Labels */
  .label-list { display: flex; flex-direction: column; gap: 4px; overflow: hidden; flex: 1; }
  .label-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .label-name { font-size: 11px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .label-cnt { font-size: 10px; color: var(--purple); font-weight: 600; flex-shrink: 0; }

  /* Closed */
  .closed-list { display: flex; flex-direction: column; gap: 4px; overflow: hidden; flex: 1; }
  .closed-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .closed-title { font-size: 11px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .closed-date { font-size: 10px; color: var(--green); flex-shrink: 0; }

  /* Assignees */
  .assignee-list { display: flex; flex-direction: column; gap: 4px; overflow: hidden; flex: 1; }
  .assignee-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .assignee-name { font-size: 11px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .assignee-cnt { font-size: 10px; color: var(--blue); font-weight: 600; flex-shrink: 0; }
  .avg-close { font-size: 10px; color: var(--text-3); margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--border); }

  .empty-msg { font-size: 11px; color: var(--text-3); font-style: italic; }

  /* Home */
  .home-grid { display: flex; flex-direction: column; gap: 10px; flex: 1; }
  .incidents-list { display: flex; flex-direction: column; gap: 6px; }
  .inc-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .inc-row:last-child { border-bottom: none; }
  .inc-title { flex: 1; font-size: 12px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .inc-date { font-size: 10px; color: var(--text-3); flex-shrink: 0; }
</style>
