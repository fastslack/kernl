<script lang="ts">
  /**
   * Generic plugin frontend renderer.
   * Interprets a PluginFrontendDescriptor JSON to render KPIs, panels, tables.
   */
  import Panel from './Panel.svelte';
  import KpiCard from './KpiCard.svelte';
  import Badge from './Badge.svelte';

  export let descriptor: any;
  export let data: any;

  function fmtBytes(bytes: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }

  function resolve(obj: any, path: string): any {
    if (!obj || !path) return undefined;
    return path.split('.').reduce((o, k) => o?.[k], obj);
  }

  function formatValue(val: any, format?: string): string {
    if (val === undefined || val === null) return '-';
    if (format === 'bytes') return fmtBytes(Number(val));
    if (format === 'number') return Number(val).toLocaleString();
    if (format === 'percent') return `${Number(val).toFixed(1)}%`;
    return String(val);
  }
</script>

{#if descriptor?.sections}
  {#each descriptor.sections as section}
    {#if section.type === 'kpi-row'}
      <div class="kpi-row anim">
        {#each section.items as item}
          <KpiCard
            label={item.label}
            value={formatValue(resolve(data, item.field), item.format)}
            accent={item.accent ?? '--blue'}
            color={item.color ?? 'var(--text-1)'}
          />
        {/each}
      </div>

    {:else if section.type === 'panel'}
      {@const items = resolve(data, section.field) ?? []}
      {#if items.length > 0}
        <Panel title={section.title} dotColor={section.dotColor ?? 'var(--blue)'} cls="anim d2">
          {#each items.slice(0, section.maxItems ?? 20) as item}
            <div class="plugin-item">
              {#if section.itemTemplate}
                <div class="item-content">
                  <div class="item-title">{resolve(item, section.itemTemplate.title) ?? ''}</div>
                  {#if section.itemTemplate.subtitle}
                    <div class="item-sub">{resolve(item, section.itemTemplate.subtitle) ?? ''}</div>
                  {/if}
                  <div class="item-meta">
                    {#if section.itemTemplate.badge}
                      <Badge text={resolve(item, section.itemTemplate.badge) ?? ''} />
                    {/if}
                    {#if section.itemTemplate.meta}
                      {#each section.itemTemplate.meta as metaField}
                        <span class="meta-val">{resolve(item, metaField) ?? ''}</span>
                      {/each}
                    {/if}
                  </div>
                </div>
              {:else}
                <div class="item-content">
                  <div class="item-title">{JSON.stringify(item).slice(0, 100)}</div>
                </div>
              {/if}
            </div>
          {/each}
          {#if items.length === 0 && section.emptyMessage}
            <div class="empty-msg">{section.emptyMessage}</div>
          {/if}
        </Panel>
      {/if}

    {:else if section.type === 'table'}
      {@const rows = resolve(data, section.field) ?? []}
      {#if rows.length > 0}
        <Panel title={section.title} dotColor="var(--teal)" cls="anim d3">
          <div class="plugin-table-wrap">
            <table class="plugin-table">
              <thead>
                <tr>
                  {#each section.columns as col}
                    <th style="text-align:{col.align ?? 'left'}">{col.header}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each rows.slice(0, section.maxRows ?? 50) as row}
                  <tr>
                    {#each section.columns as col}
                      <td style="text-align:{col.align ?? 'left'}">
                        {#if col.format === 'badge'}
                          <Badge text={resolve(row, col.field) ?? ''} />
                        {:else}
                          {formatValue(resolve(row, col.field), col.format)}
                        {/if}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Panel>
      {/if}

    {:else if section.type === 'two-col'}
      <div class="two-col anim d3">
        <svelte:self descriptor={{ sections: [section.left] }} {data} />
        <svelte:self descriptor={{ sections: [section.right] }} {data} />
      </div>
    {/if}
  {/each}
{/if}

<style>
  .plugin-item { padding: 6px 0; border-bottom: 1px solid var(--bg-3); }
  .plugin-item:last-child { border-bottom: none; }
  .item-content { display: flex; flex-direction: column; gap: 2px; }
  .item-title { font-size: 13px; font-weight: 500; color: var(--text-1); }
  .item-sub { font-size: 11px; color: var(--text-3); }
  .item-meta { display: flex; gap: 6px; align-items: center; margin-top: 2px; }
  .meta-val { font-size: 11px; color: var(--text-3); }
  .empty-msg { font-size: 12px; color: var(--text-3); padding: 8px 0; }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 768px) { .two-col { grid-template-columns: 1fr; } }

  .plugin-table-wrap { overflow-x: auto; }
  .plugin-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .plugin-table th { padding: 6px 8px; color: var(--text-2); font-weight: 600; border-bottom: 2px solid var(--bg-3); }
  .plugin-table td { padding: 5px 8px; border-bottom: 1px solid var(--bg-3); color: var(--text-1); }
  .plugin-table tr:hover td { background: var(--bg-2); }
</style>
