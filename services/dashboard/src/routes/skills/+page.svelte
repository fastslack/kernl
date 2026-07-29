<script lang="ts">
  import { skills } from '$lib/stores.js';
  import { rpcOrCall } from '$lib/ws.js';
  import { goto } from '$app/navigation';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Empty from '$lib/components/Empty.svelte';
  import { enableSkill, disableSkill, uninstallSkill, installSkill } from '$lib/api.js';

  $: sk = ($skills as any);
  $: allSkills = (sk?.skills ?? []) as any[];
  $: enabled = allSkills.filter((s: any) => s.status === 'enabled');
  $: disabled = allSkills.filter((s: any) => s.status === 'disabled' || s.status === 'installed');
  $: errors = allSkills.filter((s: any) => s.status === 'error');
  $: totalTools = allSkills.reduce((a: number, s: any) => a + (s.toolCount ?? 0), 0);

  let showInstall = false;
  let installType = 'local';
  let installPath = '';
  let autoEnable = true;
  let installing = false;
  let installError = '';

  async function doToggle(id: string, enable: boolean) {
    try {
      if (enable) await enableSkill(id);
      else await disableSkill(id);
      // Refresh skills list
      const data = await rpcOrCall('skills.list', {}, async () => {
        const res = await fetch('/api/skills');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      skills.set(data);
    } catch (e: any) { alert('Error: ' + e.message); }
  }

  async function doUninstall(id: string) {
    if (!confirm('Uninstall this skill?')) return;
    try {
      await uninstallSkill(id);
      // Refresh skills list
      const data = await rpcOrCall('skills.list', {}, async () => {
        const res = await fetch('/api/skills');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      skills.set(data);
    } catch (e: any) { alert('Error: ' + e.message); }
  }

  async function doInstall() {
    if (!installPath.trim()) { installError = 'Please provide a path/package/URL/ID'; return; }
    installing = true; installError = '';
    try {
      const body: Record<string, unknown> = { type: installType, autoEnable };
      if (installType === 'local') body.path = installPath;
      else if (installType === 'npm') body.package = installPath;
      else if (installType === 'git') body.url = installPath;
      else if (installType === 'bundled') body.id = installPath;
      await installSkill(body);
      showInstall = false; installPath = '';
    } catch (e: any) {
      installError = e.message;
    } finally { installing = false; }
  }
</script>

<ViewHeader title="Skills" sub="Installed plugins that extend the kernel with new capabilities">
  <button class="search-btn" on:click={() => showInstall = true}>+ Install Skill</button>
</ViewHeader>

<div class="legacy-banner anim">
  <span class="legacy-icon">ⓘ</span>
  <div class="legacy-text">
    <strong>Superseded by Extensions.</strong>
    Skills are now managed alongside modules, flows and themes in
    <a href="/extensions">/extensions</a>. This page remains for legacy
    troubleshooting.
  </div>
  <button class="legacy-cta" on:click={() => goto('/extensions')}>Go to Extensions →</button>
</div>

{#if showInstall}
  <div class="compose-overlay" on:click|self={() => showInstall = false} role="presentation">
    <div class="compose-modal">
      <h3>Install Skill</h3>
      <div class="compose-row">
        <label>Source Type</label>
        <select class="search-input" bind:value={installType}>
          {#each ['local','bundled','git','npm'] as t}<option value={t}>{t}</option>{/each}
        </select>
      </div>
      <div class="compose-row">
        <label>Path / Package / URL / ID</label>
        <input class="search-input" bind:value={installPath} placeholder="e.g. /path/to/skill or my-skill-id" />
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
        <input type="checkbox" id="autoEnable" bind:checked={autoEnable} />
        <label for="autoEnable" style="font-size:12px;color:var(--text-2)">Auto-enable after install</label>
      </div>
      {#if installError}<div style="color:var(--red);font-size:12px;margin-bottom:10px">{installError}</div>{/if}
      <div class="compose-actions">
        <button class="compose-btn-cancel" on:click={() => showInstall = false}>Cancel</button>
        <button class="compose-btn-send" on:click={doInstall} disabled={installing}>{installing ? 'Installing...' : 'Install'}</button>
      </div>
    </div>
  </div>
{/if}

{#if !sk}
  <div class="loading-view">Loading skills...</div>
{:else}
  <!-- KPI Row -->
  <div class="kpi-row anim">
    <KpiCard label="Installed" value={allSkills.length} sub="total" accent="--gold" color="var(--gold)" />
    <KpiCard label="Enabled" value={enabled.length} sub="active" accent="--green" color="var(--green)" />
    <KpiCard label="Disabled" value={disabled.length} sub="paused" accent="--text-3" />
    <KpiCard label="Tools" value={totalTools} sub="available" accent="--teal" color="var(--teal)" />
  </div>

  {#if allSkills.length === 0}
    <!-- Empty State -->
    <Panel cls="anim" style="text-align:center;padding:40px">
      <div style="font-size:32px;margin-bottom:12px">🧩</div>
      <div style="font-weight:600;margin-bottom:6px">No skills installed</div>
      <div style="color:var(--text-3);font-size:13px;margin-bottom:16px">Browse the Marketplace to find skills that extend your kernel</div>
      <button class="search-btn" on:click={() => goto('/marketplace')}>→ Open Marketplace</button>
    </Panel>
  {:else}
    <!-- Enabled Skills -->
    {#if enabled.length > 0}
      <Panel title="Enabled" dotColor="var(--green)" cls="anim d1 full-width">
        {#each enabled as skill}
          <div class="sr-card" style="margin-bottom:8px;padding:14px 16px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
                {#if skill.icon}<span style="font-size:18px">{skill.icon}</span>{/if}
                <span style="font-weight:600;font-size:13px">{skill.name}</span>
                <span style="font-size:10px;color:var(--text-3);font-family:var(--font-mono)">{skill.version}</span>
                <Badge text="enabled" variant="done" />
              </div>
              {#if skill.description}<div style="font-size:12px;color:var(--text-2);margin-bottom:4px">{skill.description}</div>{/if}
              <div style="font-size:11px;color:var(--text-3);display:flex;gap:12px;margin-top:4px;flex-wrap:wrap">
                {#if skill.author}<span>by {skill.author}</span>{/if}
                {#if skill.toolCount > 0}<span>{skill.toolCount} tools</span>{/if}
                {#if skill.tags?.length}<span>{skill.tags.slice(0, 3).join(' · ')}</span>{/if}
              </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
              <button class="header-btn" style="font-size:11px" on:click={() => doToggle(skill.id, false)}>⏸ Disable</button>
              <button class="header-btn" style="font-size:11px;color:var(--red);border-color:var(--red)" on:click={() => doUninstall(skill.id)}>✕</button>
            </div>
          </div>
        {/each}
      </Panel>
    {/if}

    <!-- Disabled Skills -->
    {#if disabled.length > 0}
      <Panel title="Disabled" dotColor="var(--text-2)" cls="anim d2 full-width">
        {#each disabled as skill}
          <div class="sr-card" style="margin-bottom:8px;padding:14px 16px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
                {#if skill.icon}<span style="font-size:18px">{skill.icon}</span>{/if}
                <span style="font-weight:600;font-size:13px">{skill.name}</span>
                <span style="font-size:10px;color:var(--text-3);font-family:var(--font-mono)">{skill.version}</span>
                <Badge text="disabled" variant="low" />
              </div>
              {#if skill.description}<div style="font-size:12px;color:var(--text-2);margin-bottom:4px">{skill.description}</div>{/if}
              <div style="font-size:11px;color:var(--text-3);display:flex;gap:12px;margin-top:4px;flex-wrap:wrap">
                {#if skill.author}<span>by {skill.author}</span>{/if}
                {#if skill.toolCount > 0}<span>{skill.toolCount} tools</span>{/if}
                {#if skill.tags?.length}<span>{skill.tags.slice(0, 3).join(' · ')}</span>{/if}
              </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
              <button class="header-btn" style="font-size:11px;color:var(--green);border-color:var(--green)" on:click={() => doToggle(skill.id, true)}>▶ Enable</button>
              <button class="header-btn" style="font-size:11px;color:var(--red);border-color:var(--red)" on:click={() => doUninstall(skill.id)}>✕</button>
            </div>
          </div>
        {/each}
      </Panel>
    {/if}

    <!-- Error Skills -->
    {#if errors.length > 0}
      <Panel title="Errors" dotColor="var(--red)" cls="anim d3 full-width">
        {#each errors as skill}
          <div class="sr-card" style="margin-bottom:8px;padding:14px 16px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
                {#if skill.icon}<span style="font-size:18px">{skill.icon}</span>{/if}
                <span style="font-weight:600;font-size:13px">{skill.name}</span>
                <span style="font-size:10px;color:var(--text-3);font-family:var(--font-mono)">{skill.version}</span>
                <Badge text="error" variant="overdue" />
              </div>
              {#if skill.description}<div style="font-size:12px;color:var(--text-2);margin-bottom:4px">{skill.description}</div>{/if}
              {#if skill.error}
                <div class="failed-error" style="color:var(--red);font-size:12px;margin-top:4px;padding:6px 8px;background:rgba(240,71,112,0.1);border-radius:4px">{skill.error}</div>
              {/if}
              <div style="font-size:11px;color:var(--text-3);display:flex;gap:12px;margin-top:4px;flex-wrap:wrap">
                {#if skill.author}<span>by {skill.author}</span>{/if}
                {#if skill.toolCount > 0}<span>{skill.toolCount} tools</span>{/if}
                {#if skill.tags?.length}<span>{skill.tags.slice(0, 3).join(' · ')}</span>{/if}
              </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
              <button class="header-btn" style="font-size:11px;color:var(--red);border-color:var(--red)" on:click={() => doUninstall(skill.id)}>✕</button>
            </div>
          </div>
        {/each}
      </Panel>
    {/if}
  {/if}
{/if}

<style>
  .legacy-banner {
    display: flex; align-items: center; gap: 12px;
    background: color-mix(in srgb, var(--amber) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--amber) 40%, transparent);
    border-radius: 8px; padding: 12px 16px; margin-bottom: 16px;
    font-size: 13px; color: var(--text-1);
  }
  .legacy-icon { font-size: 18px; color: var(--amber); }
  .legacy-text { flex: 1; line-height: 1.45; }
  .legacy-text a { color: var(--blue); text-decoration: underline; }
  .legacy-cta {
    background: var(--blue); color: var(--bg-1); border: none;
    border-radius: 6px; padding: 6px 12px; font-weight: 600;
    cursor: pointer; white-space: nowrap;
  }
  .legacy-cta:hover { opacity: .9; }
</style>
