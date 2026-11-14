<!--
  BuildingStats — the header bar's numbers: the building's own (agents,
  working, runs today) and, next to them, what each extension building
  publishes through `publishStats` (e.g. the Growth Plaza). A click on a group
  flies the camera there: the building group frames everything, a plugin
  group calls the plugin's own focus.

  Narrow bars keep each group's primary metric and fold the feeds into one
  dot that takes the colour of the worst state; a failing feed still shows.
-->
<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { t } from '$lib/i18n/index.js';
	import type { WorldStats, WorldStatStatus } from '$shared/world-plugin.js';

	export let agents = 0;
	export let working = 0;
	export let runsToday = 0;
	export let plugins: WorldStats[] = [];

	const dispatch = createEventDispatcher<{ fit: void; focus: { stats: WorldStats } }>();
	const RANK: Record<WorldStatStatus['state'], number> = { off: 0, ok: 1, connecting: 2, error: 3 };

	function worst(list: WorldStatStatus[] | undefined): WorldStatStatus['state'] | null {
		if (!list?.length) return null;
		return list.reduce<WorldStatStatus['state']>((w, s) => (RANK[s.state] > RANK[w] ? s.state : w), 'off');
	}
	function statusTitle(s: WorldStatStatus): string {
		return s.title ?? `${s.label}${s.badge ? ` · ${s.badge}` : ''}`;
	}
	function primaryKey(stats: WorldStats): string | undefined {
		return (stats.metrics.find((m) => m.primary) ?? stats.metrics[0])?.key;
	}
	function focus(stats: WorldStats) {
		dispatch('focus', { stats });
	}
	function onKey(e: KeyboardEvent, run: () => void) {
		if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); }
	}
</script>

<div class="bs">
	<div class="bs-group bs-group--building" role="button" tabindex="0" title={$t('office.bar.stats_fit')}
		on:click={() => dispatch('fit')} on:keydown={(e) => onKey(e, () => dispatch('fit'))}>
		<span class="bs-m bs-m--primary"><b>{agents}</b><small>{$t(agents === 1 ? 'office.bar.agent' : 'office.bar.agents')}</small></span>
		<span class="bs-m bs-m--primary tone-green"><b>{working}</b><small>{$t('office.bar.working')}</small></span>
		<span class="bs-m"><b>{runsToday}</b><small>{$t('office.bar.runs_today')}</small></span>
	</div>

	{#each plugins as p (p.title)}
		{@const w = worst(p.statuses)}
		{@const pk = primaryKey(p)}
		<span class="bs-sep" aria-hidden="true"></span>
		<div class="bs-group bs-group--plugin" role="button" tabindex="0" class:bs-group--alert={w === 'error'}
			title={$t('office.bar.stats_focus', { name: p.title })}
			on:click={() => focus(p)} on:keydown={(e) => onKey(e, () => focus(p))}>
			<span class="bs-head">
				{#if p.badge}<span class="bs-badge bs-badge--{p.badge.tone}"><i></i>{p.badge.text}</span>{/if}
				<span class="bs-title">{p.title}</span>
			</span>
			{#if p.waiting}
				<span class="bs-wait">{p.waiting}</span>
			{:else}
				{#each p.metrics as m (m.key)}
					<span class="bs-m tone-{m.tone ?? 'neutral'}" class:bs-m--primary={m.key === pk} title={m.title ?? null}><b>{m.value}</b><small>{m.label}</small></span>
				{/each}
			{/if}
			{#if p.statuses?.length}
				<span class="bs-feeds">
					{#each p.statuses as s (s.key)}
						<span class="bs-feed st-{s.state}" title={statusTitle(s)}>
							<i></i><span class="bs-feed-l">{s.label}</span>
							{#if s.value}<b class:stale={s.stale}>{s.value}</b>{#if s.unit}<small>{s.unit}</small>{/if}{/if}
							{#if s.badge && s.state !== 'ok'}<em>{s.badge}</em>{/if}
						</span>
					{/each}
				</span>
				<span class="bs-feeds-dot st-{w}" title={p.statuses.map(statusTitle).join('\n')}><i></i></span>
			{/if}
		</div>
		{#if p.actions?.length}
			<span class="bs-actions">
				{#each p.actions as a (a.key)}
					<button type="button" class="bs-act" class:on={a.pressed} aria-pressed={a.pressed ?? null} title={a.title ?? a.label}
						on:click|stopPropagation={() => a.run()}>{#if a.icon}<span aria-hidden="true">{a.icon}</span>{/if}<span class="bs-act-l">{a.label}</span></button>
				{/each}
			</span>
		{/if}
	{/each}
</div>

<style>
	.bs {
		display: flex; align-items: center; gap: 4px; min-width: 0; flex-wrap: wrap;
		padding: 3px; border: 1px solid var(--border); border-radius: 10px;
		background: color-mix(in srgb, var(--surface-2) 70%, transparent);
		font: 400 12px/1.2 var(--font-body); color: var(--text-2); font-variant-numeric: tabular-nums;
	}
	.bs-group {
		display: flex; align-items: center; gap: 2px; min-width: 0; padding: 3px 6px; border-radius: 7px;
		cursor: pointer; border: 1px solid transparent; transition: background .15s, border-color .15s;
	}
	.bs-group:hover, .bs-group:focus-visible { background: var(--surface-3); border-color: var(--border-h); outline: none; }
	.bs-group--alert { border-color: color-mix(in srgb, var(--red) 28%, transparent); }
	.bs-sep { width: 1px; align-self: stretch; margin: 4px 2px; background: var(--border-h); }

	.bs-m { display: inline-flex; align-items: baseline; gap: 4px; padding: 2px 6px; white-space: nowrap; }
	.bs-m b { font: 600 14px/1 var(--font-body); color: var(--text-1); }
	.bs-m small { font-size: 11px; color: var(--text-3, var(--text-2)); }
	.tone-green b { color: var(--green); }
	.tone-cyan b { color: color-mix(in srgb, var(--teal) 80%, var(--text-1)); }
	.tone-violet b { color: color-mix(in srgb, var(--purple) 80%, var(--text-1)); }
	.tone-amber b { color: color-mix(in srgb, var(--gold) 85%, var(--text-1)); }

	.bs-head { display: inline-flex; align-items: center; gap: 6px; margin-right: 4px; white-space: nowrap; min-width: 0; }
	.bs-title { font: 600 12px/1.2 var(--font-body); color: var(--text-1); max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
	.bs-badge {
		--k: var(--green); display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 99px;
		font: 700 9.5px/1.4 var(--font-body); letter-spacing: .4px; color: color-mix(in srgb, var(--k) 70%, var(--text-1));
		background: color-mix(in srgb, var(--k) 12%, transparent);
	}
	.bs-badge--demo { --k: var(--gold); }
	.bs-badge i { width: 6px; height: 6px; border-radius: 50%; background: var(--k); animation: bs-pulse 1.6s infinite; }
	@keyframes bs-pulse { 50% { opacity: .35; } }
	.bs-wait { color: var(--text-3, var(--text-2)); font-size: 11px; padding: 0 6px; }

	.bs-feeds { display: inline-flex; align-items: center; gap: 8px; margin-left: 6px; padding-left: 8px; border-left: 1px solid var(--border); white-space: nowrap; }
	.bs-feed { --k: var(--text-3, #858a95); display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-2); }
	.bs-feed i, .bs-feeds-dot i { width: 6px; height: 6px; border-radius: 50%; background: var(--k); flex: none; }
	.st-ok { --k: var(--green); }
	.st-connecting { --k: var(--gold); }
	.st-error { --k: var(--red); }
	.st-off { --k: var(--text-3, #858a95); }
	.bs-feed.st-off { opacity: .6; }
	.bs-feed b { color: var(--text-1); font-weight: 600; }
	.bs-feed b.stale { opacity: .45; text-decoration: line-through; text-decoration-thickness: 1px; }
	.bs-feed small { font-size: 10px; color: var(--text-3, var(--text-2)); }
	/* A failing feed reads as a quiet red pill: visible at a glance, never a banner. */
	.bs-feed.st-error {
		padding: 1px 6px; border-radius: 99px; color: color-mix(in srgb, var(--red) 55%, var(--text-1));
		background: color-mix(in srgb, var(--red) 12%, transparent);
	}
	.bs-feed em { font-style: normal; font-weight: 600; color: color-mix(in srgb, var(--k) 70%, var(--text-1)); }
	.bs-feeds-dot { display: none; padding: 0 4px; }
	.bs-feeds-dot i { width: 8px; height: 8px; }
	.bs-feeds-dot.st-error i { box-shadow: 0 0 0 3px color-mix(in srgb, var(--red) 22%, transparent); }

	.bs-actions { display: inline-flex; gap: 4px; padding-right: 2px; }
	.bs-act {
		display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 6px;
		border: 1px solid var(--border); background: transparent; color: var(--text-2); font: 500 11px/1 var(--font-body); cursor: pointer; white-space: nowrap;
	}
	.bs-act:hover { color: var(--text-1); border-color: var(--border-h); background: var(--surface-3); }
	.bs-act.on { color: color-mix(in srgb, var(--gold) 70%, var(--text-1)); border-color: color-mix(in srgb, var(--gold) 55%, transparent); background: color-mix(in srgb, var(--gold) 10%, transparent); }

	/* Medium bars: feeds fold into one dot, actions show their icon only. */
	@media (max-width: 1500px) {
		.bs-feeds { display: none; }
		.bs-feeds-dot { display: inline-flex; }
		.bs-act-l { display: none; }
	}
	/* Narrow bars: one metric per group. */
	@media (max-width: 1240px) {
		.bs-m:not(.bs-m--primary) { display: none; }
		.bs-title { max-width: 110px; }
	}
	@media (max-width: 700px) {
		.bs { width: 100%; }
		.bs-m small { display: none; }
		.bs-m--primary small { display: inline; }
	}
	@media (prefers-reduced-motion: reduce) { .bs-badge i { animation: none; } .bs-group { transition: none; } }
</style>
