<script lang="ts">
	import { t } from '$lib/i18n/index.js';

	export let name = '';
	export let color = '#2563eb';
	export let agents: Array<{ name: string; lead: boolean }> = [];
	export let repo = false;
	export let every: string | null = null;

	$: doorLabel = (name.trim() || $t('office.wizard.title')).toUpperCase().slice(0, 14);
	$: deskCount = Math.max(agents.length, 1);
	$: shown = Math.min(deskCount, 9);
	$: cols = Math.ceil(Math.sqrt(shown));
	$: rows = Math.ceil(shown / cols);
	$: leadIdx = agents.findIndex((a) => a.lead);
	$: planNo = (name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'office').slice(0, 18);
	$: today = new Date().toISOString().slice(0, 10);

	function desk(i: number, c: number, r: number): { x: number; y: number } {
		const cellW = 150 / c;
		const cellH = 120 / r;
		return { x: 55 + (i % c) * cellW + cellW / 2, y: 78 + Math.floor(i / c) * cellH + cellH / 2 };
	}
</script>

<figure class="bp" style="--office:{color}">
	<svg viewBox="0 0 260 300" aria-hidden="true">
		<defs>
			<pattern id="k-bp-grid" width="20" height="20" patternUnits="userSpaceOnUse">
				<path d="M20 0H0V20" fill="none" stroke="rgba(107,164,255,.10)" stroke-width="0.6" />
			</pattern>
		</defs>
		<rect x="0" y="0" width="260" height="300" fill="url(#k-bp-grid)" />
		<g stroke="rgba(127,180,255,.5)" stroke-width="1.2" fill="none">
			<path d="M10 20 V10 H20" /><path d="M240 10 H250 V20" /><path d="M250 280 V290 H240" /><path d="M20 290 H10 V280" />
		</g>
		<g fill="none" stroke="#7FB4FF" stroke-width="1.6">
			<path d="M113 228 H45 V60 H215 V228 H147" />
			<path d="M113 228 A 34 34 0 0 1 147 262" stroke-dasharray="3 3" stroke-width="1" opacity="0.7" />
		</g>
		<line x1="45" y1="55" x2="215" y2="55" stroke="var(--office)" stroke-width="3.5" stroke-linecap="round" />
		<rect x="60" y="34" width="140" height="16" rx="2" fill="rgba(10,20,40,.9)" stroke="rgba(127,180,255,.6)" stroke-width="0.8" />
		<text x="130" y="45.5" text-anchor="middle" class="bp-plate">{doorLabel}</text>
		{#each Array(shown) as _, i (i)}
			{@const p = desk(i, cols, rows)}
			<rect x={p.x - 11} y={p.y - 7} width="22" height="14" rx="1.5" fill="rgba(127,180,255,.08)"
				stroke={i === leadIdx ? '#D4A84B' : 'rgba(127,180,255,.75)'} stroke-width="1.2" />
			<circle cx={p.x} cy={p.y + 12} r="3.2" fill="none" stroke={i === leadIdx ? '#D4A84B' : 'rgba(127,180,255,.55)'} stroke-width="1" />
			{#if i === leadIdx}<text x={p.x} y={p.y - 11} text-anchor="middle" class="bp-star">★</text>{/if}
		{/each}
		{#if deskCount > 9}<text x="205" y="215" text-anchor="end" class="bp-small">+{deskCount - 9}</text>{/if}
		{#if repo}
			<rect x="50" y="236" width="12" height="16" rx="1" fill="none" stroke="rgba(127,180,255,.8)" stroke-width="1" />
			<line x1="52.5" y1="248" x2="59.5" y2="248" stroke="var(--office)" stroke-width="1.4" />
			<text x="68" y="247" class="bp-small">{$t('office.wizard.repo_label')}</text>
		{/if}
		{#if every}
			<circle cx="212" cy="244" r="7" fill="none" stroke="rgba(127,180,255,.8)" stroke-width="1" />
			<line x1="212" y1="244" x2="212" y2="239.5" stroke="rgba(127,180,255,.9)" stroke-width="1" />
			<line x1="212" y1="244" x2="215.5" y2="245.5" stroke="var(--office)" stroke-width="1.2" />
			<text x="202" y="247" text-anchor="end" class="bp-small">{every}</text>
		{/if}
		<line x1="24" y1="266" x2="236" y2="266" stroke="rgba(127,180,255,.35)" stroke-width="0.8" />
		<text x="24" y="278" class="bp-tb">{$t('office.wizard.plan_no', { n: planNo })}</text>
		<text x="236" y="278" text-anchor="end" class="bp-tb">{today}</text>
		<text x="24" y="289" class="bp-tb bp-tb--dim">{$t('office.wizard.desks', { n: deskCount })}</text>
	</svg>
	<figcaption class="bp-caption">{$t('office.wizard.blueprint_label', { name: name.trim() || '—' })}</figcaption>
</figure>

<style>
	.bp { margin: 0; padding: 14px; border-radius: 12px; background: #0a1426; border: 1px solid #1d3155; display: grid; gap: 6px; }
	.bp svg { width: 100%; height: auto; display: block; }
	.bp-plate { font: 600 9px/1 var(--font-mono); fill: #cfe0ff; letter-spacing: 0.08em; }
	.bp-star { font-size: 9px; fill: #D4A84B; }
	.bp-small { font: 400 9px/1 var(--font-mono); fill: #8fb0e0; }
	.bp-tb { font: 400 8.5px/1 var(--font-mono); fill: #6f8fc2; letter-spacing: 0.06em; }
	.bp-tb--dim { fill: #4f6a96; }
	.bp-caption { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
