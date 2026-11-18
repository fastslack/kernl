<!--
  BuildingStats — the header bar's numbers: the building's own (agents,
  working, runs today) and, next to them, what each extension building
  publishes through `publishStats` (e.g. the Growth Plaza). A click on a group
  flies the camera there: the building group frames everything, a plugin
  group calls the plugin's own focus.

  It shares one line with the bar's buttons, so names live in tooltips and
  for screen readers only, the feeds fold into one dot (the worst state's
  colour, with the names of any feed that is not ok), and narrower bars keep
  one metric per group. Widths are the bar's own (container `bar`, set by
  CommandBar), not the window's.
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
	function notOk(list: WorldStatStatus[] | undefined): WorldStatStatus[] {
		return (list ?? []).filter((s) => s.state === 'error' || s.state === 'connecting');
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
	<div class="bs-group" role="button" tabindex="0" title={$t('office.bar.stats_fit')}
		on:click={() => dispatch('fit')} on:keydown={(e) => onKey(e, () => dispatch('fit'))}>
		<span class="bs-m bs-m--primary"><b>{agents}</b><small>{$t(agents === 1 ? 'office.bar.agent' : 'office.bar.agents')}</small></span>
		<span class="bs-m bs-m--primary tone-green"><b>{working}</b><small>{$t('office.bar.working')}</small></span>
		<span class="bs-m"><b>{runsToday}</b><small>{$t('office.bar.runs_today')}</small></span>
	</div>

	{#each plugins as p (p.title)}
		{@const w = worst(p.statuses)}
		{@const pk = primaryKey(p)}
		{@const bad = notOk(p.statuses)}
		<span class="bs-sep" aria-hidden="true"></span>
		<div class="bs-group" role="button" tabindex="0" class:bs-group--alert={w === 'error'}
			title={$t('office.bar.stats_focus', { name: p.title })} aria-label={$t('office.bar.stats_focus', { name: p.title })}
			on:click={() => focus(p)} on:keydown={(e) => onKey(e, () => focus(p))}>
			{#if p.badge}<span class="bs-badge bs-badge--{p.badge.tone}"><i></i>{p.badge.text}</span>{/if}
			{#if p.waiting}
				<span class="bs-wait">{p.waiting}</span>
			{:else}
				{#each p.metrics as m (m.key)}
					<span class="bs-m tone-{m.tone ?? 'neutral'}" class:bs-m--primary={m.key === pk} title={m.title ?? null}><b>{m.value}</b><small>{m.label}</small></span>
				{/each}
			{/if}
			{#if p.statuses?.length}
				<span class="bs-feeds st-{w}" title={p.statuses.map(statusTitle).join('\n')}>
					<i></i>{#each bad as s (s.key)}<em class="st-{s.state}">{s.label}</em>{/each}
				</span>
			{/if}
		</div>
		{#each p.actions ?? [] as a (a.key)}
			<button type="button" class="bs-act" class:on={a.pressed} aria-pressed={a.pressed ?? null} title={a.title ?? a.label} aria-label={a.label}
				on:click|stopPropagation={() => a.run()}>{a.icon ?? a.label.slice(0, 1)}</button>
		{/each}
	{/each}
</div>

<style>
	.bs {
		display: flex; align-items: center; gap: 2px; min-width: 0; overflow: hidden;
		padding: 2px; border: 1px solid var(--border); border-radius: 9px;
		background: color-mix(in srgb, var(--surface-2) 70%, transparent);
		font: 400 11px/1.2 var(--font-body); color: var(--text-2); font-variant-numeric: tabular-nums;
	}
	.bs-group {
		display: flex; align-items: center; gap: 0; min-width: 0; padding: 2px 4px; border-radius: 7px;
		cursor: pointer; border: 1px solid transparent; transition: background .15s, border-color .15s; white-space: nowrap;
	}
	.bs-group:hover, .bs-group:focus-visible { background: var(--surface-3); border-color: var(--border-h); outline: none; }
	.bs-group--alert { border-color: color-mix(in srgb, var(--red) 25%, transparent); }
	.bs-sep { width: 1px; align-self: stretch; margin: 3px 1px; background: var(--border-h); flex: none; }

	.bs-m { display: inline-flex; align-items: baseline; gap: 3px; padding: 1px 5px; }
	.bs-m b { font: 600 13px/1 var(--font-body); color: var(--text-1); }
	.bs-m small { font-size: 10.5px; color: var(--text-3, var(--text-2)); }
	.tone-green b { color: var(--green); }
	.tone-cyan b { color: color-mix(in srgb, var(--teal) 80%, var(--text-1)); }
	.tone-violet b { color: color-mix(in srgb, var(--purple) 80%, var(--text-1)); }
	.tone-amber b { color: color-mix(in srgb, var(--gold) 85%, var(--text-1)); }

	.bs-badge {
		--k: var(--green); display: inline-flex; align-items: center; gap: 4px; margin-right: 2px; padding: 1px 6px; border-radius: 99px;
		font: 700 9px/1.4 var(--font-body); letter-spacing: .4px; color: color-mix(in srgb, var(--k) 70%, var(--text-1));
		background: color-mix(in srgb, var(--k) 12%, transparent);
	}
	.bs-badge--demo { --k: var(--gold); }
	.bs-badge i { width: 5px; height: 5px; border-radius: 50%; background: var(--k); animation: bs-pulse 1.6s infinite; }
	@keyframes bs-pulse { 50% { opacity: .35; } }
	.bs-wait { color: var(--text-3, var(--text-2)); padding: 0 5px; }

	/* All feeds in one dot (the worst state); a feed that is not ok adds its name, small. */
	.bs-feeds { --k: var(--text-3, #858a95); display: inline-flex; align-items: center; gap: 4px; padding: 0 3px 0 5px; }
	.bs-feeds i { width: 7px; height: 7px; border-radius: 50%; background: var(--k); flex: none; }
	.bs-feeds.st-error i { box-shadow: 0 0 0 3px color-mix(in srgb, var(--red) 20%, transparent); }
	.bs-feeds em { --k: var(--gold); font-style: normal; font-size: 10px; font-weight: 600; color: color-mix(in srgb, var(--k) 65%, var(--text-1)); }
	.st-ok { --k: var(--green); }
	.st-connecting { --k: var(--gold); }
	.bs-feeds .st-error, .bs-feeds.st-error { --k: var(--red); }
	.st-off { --k: var(--text-3, #858a95); }

	.bs-act {
		flex: none; display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border-radius: 6px;
		border: 1px solid transparent; background: transparent; color: var(--text-2); font: 500 12px/1 var(--font-body); cursor: pointer;
	}
	.bs-act:hover { border-color: var(--border-h); background: var(--surface-3); }
	.bs-act.on { border-color: color-mix(in srgb, var(--gold) 55%, transparent); background: color-mix(in srgb, var(--gold) 10%, transparent); }

	/* Narrow bars: one metric per group. */
	@container bar (max-width: 1180px) {
		.bs-m:not(.bs-m--primary) { display: none; }
	}
	@container bar (max-width: 820px) {
		.bs-badge { font-size: 0; gap: 0; padding: 3px; }
		.bs-feeds em { display: none; }
	}
	@media (max-width: 700px) {
		.bs { width: 100%; }
	}
	@media (prefers-reduced-motion: reduce) { .bs-badge i { animation: none; } .bs-group { transition: none; } }
</style>
