<script lang="ts">
	/**
	 * New Office wizard — the no-code way to found an office in the 3D building.
	 *
	 * Three short steps (Office → Team → Review) assemble an
	 * OfficeDefinition and POST it to the shared Office Kit engine
	 * (`offices.create` RPC / POST /api/offices/create). All validation and
	 * smart defaults live server-side; this component only collects intent.
	 *
	 * Signature element: the live blueprint pane — a schematic top-down plan of
	 * the future room that draws itself as you type (door plate = office name,
	 * roof line = flow color, one desk per agent, gold star = manager, badges
	 * for repo/cron). On success a "FUNDADA" stamp slams over the plan — the
	 * same office then materializes in the real 3D building.
	 */
	import { createEventDispatcher } from 'svelte';
	import { createOffice } from '$lib/api.js';

	const dispatch = createEventDispatcher();

	// ── Palette (mirrors OFFICE_PALETTE in office-kit.ts) ──────────
	const PALETTE = [
		'#16a34a', '#e11d48', '#2563eb', '#d97706', '#7c3aed',
		'#0d9488', '#db2777', '#65a30d', '#dc2626', '#0891b2'
	];

	interface AgentRow {
		name: string;
		prompt: string;
		manager: boolean;
	}

	// ── Wizard state ───────────────────────────────────────────────
	let step = 0; // 0 = office, 1 = team, 2 = review
	let officeName = '';
	let color = PALETTE[0];
	let repo = '';
	let previewUrl = '';
	let agents: AgentRow[] = [{ name: '', prompt: '', manager: true }];
	let autoChain = true;
	let cronEvery = '';
	let creating = false;
	let createError = '';
	let founded = false;
	let report: {
		created?: string[]; updated?: string[]; chained?: [string, string][];
		scheduled?: { agent: string; intervalMs: number };
		repo?: { registered: boolean; path: string }; warnings?: string[];
	} | null = null;

	// ── Templates — the common cases, one click ────────────────────
	type TemplateId = 'blank' | 'builder' | 'research';
	let template: TemplateId = 'blank';

	function applyTemplate(id: TemplateId) {
		template = id;
		if (id === 'builder') {
			agents = [
				{
					name: 'Tech Lead', manager: true,
					prompt: 'You are the office Tech Lead. Every run: read BACKLOG.md, pick ONE pending item, dispatch it to the Builder (kernel_agents_run), then to QA, and only tick the item off if QA passes. One item per run, then stop.'
				},
				{
					name: 'Builder', manager: false,
					prompt: 'You are the Builder. You implement exactly the item the Tech Lead hands you, against real files, using your native tools (Read/Write/Edit/Bash). Read before you write, make the smallest change that satisfies the item, and run the local build/typecheck.'
				},
				{
					name: 'QA', manager: false,
					prompt: 'You are QA. You verify the Builder\'s work: run build/typecheck/tests and review the diff (read-only). First line of your reply: PASS or FAIL, then the evidence. You never edit files.'
				}
			];
		} else if (id === 'research') {
			agents = [
				{
					name: 'Curador', manager: true,
					prompt: 'You are the office Curator. You decide what to research, dispatch the Researcher (kernel_agents_run), and consolidate their findings into one short, actionable note (kernel_notes_create).'
				},
				{
					name: 'Investigador', manager: false,
					prompt: 'You are the Researcher. You search with the kernel tools (rss, research, webintel), verify sources, and return concrete findings with links. No filler: if there is no signal, say so.'
				}
			];
		} else {
			agents = [{ name: '', prompt: '', manager: true }];
		}
	}

	// ── Derivations (mirror office-kit slugify so chainTo matches) ─
	function slugify(text: string): string {
		return text
			.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
			.toLowerCase().trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48);
	}
	$: officeSlug = slugify(officeName) || 'office';
	$: managerIdx = agents.findIndex((a) => a.manager);
	$: validAgents = agents.filter((a) => a.name.trim() && a.prompt.trim());
	$: doorLabel = (officeName.trim() || 'NEW OFFICE').toUpperCase().slice(0, 14);

	$: step1Ok = officeName.trim().length > 0;
	$: step2Ok = validAgents.length > 0;

	function agentSlug(a: AgentRow): string {
		return slugify(`${officeSlug}-${a.name}`) || `${officeSlug}-agent`;
	}

	function addAgent() {
		agents = [...agents, { name: '', prompt: '', manager: false }];
	}
	function removeAgent(i: number) {
		agents = agents.filter((_, idx) => idx !== i);
		if (agents.length && managerIdx === -1) agents[0].manager = true;
	}
	function setManager(i: number) {
		agents = agents.map((a, idx) => ({ ...a, manager: idx === i ? !a.manager : false }));
	}

	function buildPayload(): Record<string, unknown> {
		const list = validAgents;
		const manager = list.find((a) => a.manager);
		const workers = list.filter((a) => !a.manager);
		return {
			name: officeName.trim(),
			color,
			repo: repo.trim() || undefined,
			previewUrl: previewUrl.trim() || undefined,
			agents: list.map((a) => ({
				slug: agentSlug(a),
				name: a.name.trim(),
				role: a.manager ? 'manager' : 'worker',
				prompt: a.prompt.trim(),
				tools: a.manager && workers.length ? ['kernel_agents_run', 'kernel_agents_list', 'kernel_notes_create'] : undefined,
				chainTo: autoChain && a.manager && workers.length ? workers.map((w) => agentSlug(w)) : undefined
			})),
			cron: cronEvery.trim() && manager
				? { agent: agentSlug(manager), every: cronEvery.trim(), goal: 'resume' }
				: undefined
		};
	}

	async function create() {
		if (creating) return;
		creating = true;
		createError = '';
		try {
			const res = (await createOffice(buildPayload())) as {
				success?: boolean; report?: typeof report; error?: string;
			};
			if (res && res.success && res.report) {
				report = res.report;
				founded = true;
				dispatch('created');
			} else {
				createError = (res && res.error) || 'The office could not be created.';
			}
		} catch (err) {
			createError = err instanceof Error ? err.message : String(err);
		} finally {
			creating = false;
		}
	}

	function close() {
		dispatch('close');
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}

	// ── Blueprint geometry ─────────────────────────────────────────
	// Desks laid out in a centered grid inside the room (max 9 drawn).
	$: deskCount = Math.max(validAgents.length, agents.filter((a) => a.name.trim()).length, 1);
	$: shownDesks = Math.min(deskCount, 9);
	$: deskCols = Math.ceil(Math.sqrt(shownDesks));
	$: deskRows = Math.ceil(shownDesks / deskCols);
	function deskXY(i: number): { x: number; y: number } {
		const c = i % deskCols;
		const r = Math.floor(i / deskCols);
		const w = 150, h = 120; // usable room interior
		const cellW = w / deskCols, cellH = h / deskRows;
		return { x: 55 + c * cellW + cellW / 2, y: 78 + r * cellH + cellH / 2 };
	}
	$: managerDeskIdx = (() => {
		const named = agents.filter((a) => a.name.trim());
		const idx = named.findIndex((a) => a.manager);
		return idx >= 0 && idx < shownDesks ? idx : -1;
	})();
	$: today = new Date().toISOString().slice(0, 10);
</script>

<svelte:window on:keydown={onKeydown} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="ofw-overlay" on:click={close} role="presentation">
	<div class="ofw" on:click|stopPropagation role="dialog" aria-modal="true" aria-label="New office">
		<header class="ofw-head">
			<div>
				<div class="ofw-title">NEW OFFICE</div>
				<div class="ofw-sub">Sketch the floor plan — the building constructs itself.</div>
			</div>
			<button class="ofw-x" on:click={close} title="Close (Esc)">&times;</button>
		</header>

		<div class="ofw-body">
			<!-- ── Blueprint pane (signature) ──────────────────────── -->
			<aside class="ofw-plan" style="--office:{color}">
				<svg viewBox="0 0 260 300" aria-hidden="true">
					<defs>
						<pattern id="ofw-grid" width="20" height="20" patternUnits="userSpaceOnUse">
							<path d="M20 0H0V20" fill="none" stroke="rgba(107,164,255,.10)" stroke-width="0.6" />
						</pattern>
					</defs>
					<rect x="0" y="0" width="260" height="300" fill="url(#ofw-grid)" />

					<!-- corner marks -->
					<g stroke="rgba(127,180,255,.5)" stroke-width="1.2">
						<path d="M10 20 V10 H20" fill="none" /><path d="M240 10 H250 V20" fill="none" />
						<path d="M250 280 V290 H240" fill="none" /><path d="M20 290 H10 V280" fill="none" />
					</g>

					<!-- room shell: door gap bottom center -->
					<g class="ofw-room" fill="none" stroke="#7FB4FF" stroke-width="1.6">
						<path d="M113 228 H45 V60 H215 V228 H147" />
						<!-- door swing arc -->
						<path d="M113 228 A 34 34 0 0 1 147 262" stroke-dasharray="3 3" stroke-width="1" opacity="0.7" />
					</g>

					<!-- roof line = office color -->
					<line x1="45" y1="55" x2="215" y2="55" stroke="var(--office)" stroke-width="3.5" stroke-linecap="round" class="ofw-roof" />

					<!-- door plate -->
					<g class="ofw-plate">
						<rect x="60" y="34" width="140" height="16" rx="2" fill="rgba(10,20,40,.9)" stroke="rgba(127,180,255,.6)" stroke-width="0.8" />
						<text x="130" y="45.5" text-anchor="middle" class="ofw-plate-text">{doorLabel}</text>
					</g>

					<!-- desks -->
					{#each Array(shownDesks) as _, i (i)}
						{@const p = deskXY(i)}
						<g class="ofw-desk" style="animation-delay:{120 + i * 70}ms">
							<rect x={p.x - 11} y={p.y - 7} width="22" height="14" rx="1.5"
								fill="rgba(127,180,255,.08)" stroke={i === managerDeskIdx ? '#D4A84B' : 'rgba(127,180,255,.75)'} stroke-width="1.2" />
							<circle cx={p.x} cy={p.y + 12} r="3.2" fill="none"
								stroke={i === managerDeskIdx ? '#D4A84B' : 'rgba(127,180,255,.55)'} stroke-width="1" />
							{#if i === managerDeskIdx}
								<text x={p.x} y={p.y - 11} text-anchor="middle" class="ofw-star">★</text>
							{/if}
						</g>
					{/each}
					{#if deskCount > 9}
						<text x="205" y="215" text-anchor="end" class="ofw-more">+{deskCount - 9}</text>
					{/if}

					<!-- badges: repo / cron -->
					{#if repo.trim()}
						<g class="ofw-badge">
							<rect x="50" y="236" width="12" height="16" rx="1" fill="none" stroke="rgba(127,180,255,.8)" stroke-width="1" />
							<line x1="52.5" y1="240" x2="59.5" y2="240" stroke="rgba(127,180,255,.8)" stroke-width="1" />
							<line x1="52.5" y1="244" x2="59.5" y2="244" stroke="rgba(127,180,255,.8)" stroke-width="1" />
							<line x1="52.5" y1="248" x2="59.5" y2="248" stroke="var(--office)" stroke-width="1.4" />
							<text x="68" y="247" class="ofw-badge-text">repo</text>
						</g>
					{/if}
					{#if cronEvery.trim()}
						<g class="ofw-badge">
							<circle cx="212" cy="244" r="7" fill="none" stroke="rgba(127,180,255,.8)" stroke-width="1" />
							<line x1="212" y1="244" x2="212" y2="239.5" stroke="rgba(127,180,255,.9)" stroke-width="1" />
							<line x1="212" y1="244" x2="215.5" y2="245.5" stroke="var(--office)" stroke-width="1.2" />
							<text x="202" y="247" text-anchor="end" class="ofw-badge-text">{cronEvery.trim()}</text>
						</g>
					{/if}

					<!-- title block -->
					<line x1="24" y1="266" x2="236" y2="266" stroke="rgba(127,180,255,.35)" stroke-width="0.8" />
					<text x="24" y="278" class="ofw-tb">PLANO Nº {officeSlug.slice(0, 18)}</text>
					<text x="236" y="278" text-anchor="end" class="ofw-tb">{today}</text>
					<text x="24" y="289" class="ofw-tb ofw-tb-dim">{`${deskCount} ${deskCount === 1 ? 'agent' : 'agents'}${repo.trim() ? ' · claude_code' : ''}${cronEvery.trim() ? ` · cron ${cronEvery.trim()}` : ''}`}</text>
				</svg>

				{#if founded}
					<div class="ofw-stamp">FUNDADA</div>
				{/if}
			</aside>

			<!-- ── Steps pane ──────────────────────────────────────── -->
			<section class="ofw-steps">
				{#if !founded}
					<nav class="ofw-crumbs">
						{#each ['Office', 'Team', 'Review'] as label, i (label)}
							<button
								class="ofw-crumb" class:on={step === i} class:done={step > i}
								disabled={(i === 1 && !step1Ok) || (i === 2 && !(step1Ok && step2Ok))}
								on:click={() => (step = i)}>
								<span class="ofw-crumb-n">{step > i ? '✓' : i + 1}</span>{label}
							</button>
						{/each}
					</nav>
				{/if}

				{#if founded}
					<!-- ── Success ─────────────────────────────────── -->
					<div class="ofw-done">
						<div class="ofw-done-title">The office <strong style="color:{color}">{officeName.trim()}</strong> now exists.</div>
						<ul class="ofw-done-list">
							{#if report?.created?.length}<li>{report.created.length} {report.created.length === 1 ? 'agent created' : 'agents created'}: {report.created.join(', ')}</li>{/if}
							{#if report?.updated?.length}<li>{report.updated.length} refrescados: {report.updated.join(', ')}</li>{/if}
							{#if report?.chained?.length}<li>Cadenas: {report.chained.map(([s, t]) => `${s} → ${t}`).join(', ')}</li>{/if}
							{#if report?.scheduled}<li>Cron: every {Math.round(report.scheduled.intervalMs / 60000)} min</li>{/if}
							{#if report?.repo}<li>Repo: {report.repo.path} {report.repo.registered ? '(registrado)' : '(no registrado)'}</li>{/if}
							{#each report?.warnings ?? [] as w (w)}<li class="warn">⚠ {w}</li>{/each}
						</ul>
						<p class="ofw-done-hint">The agents are already walking to their room in the building.</p>
						<div class="ofw-nav">
							<span></span>
							<button class="ofw-btn ofw-primary" on:click={close}>View the building</button>
						</div>
					</div>

				{:else if step === 0}
					<!-- ── Step 1: Office ─────────────────────────── -->
					<div class="ofw-step">
						<div class="ofw-field">
							<span class="ofw-label">Plantilla</span>
							<div class="ofw-templates">
								<button class="ofw-tpl" class:sel={template === 'blank'} on:click={() => applyTemplate('blank')}>
									<span class="ofw-tpl-name">En blanco</span>
									<span class="ofw-tpl-desc">Empezá de cero</span>
								</button>
								<button class="ofw-tpl" class:sel={template === 'builder'} on:click={() => applyTemplate('builder')}>
									<span class="ofw-tpl-name">Constructora</span>
									<span class="ofw-tpl-desc">Lead + Builder + QA over a repo</span>
								</button>
								<button class="ofw-tpl" class:sel={template === 'research'} on:click={() => applyTemplate('research')}>
									<span class="ofw-tpl-name">Research</span>
									<span class="ofw-tpl-desc">Curator + Researcher, no repo</span>
								</button>
							</div>
						</div>

						<label class="ofw-field">
							<span class="ofw-label">Nombre</span>
							<!-- svelte-ignore a11y-autofocus -->
							<input class="ofw-input ofw-input-lg" bind:value={officeName} placeholder="Marketing" maxlength="40" autofocus />
						</label>

						<div class="ofw-field">
							<span class="ofw-label">Room color</span>
							<div class="ofw-swatches">
								{#each PALETTE as c (c)}
									<button class="ofw-swatch" class:sel={color === c} style="background:{c}" on:click={() => (color = c)} title={c}></button>
								{/each}
							</div>
						</div>

						<label class="ofw-field">
							<span class="ofw-label">Repo <em>(opcional)</em></span>
							<input class="ofw-input ofw-mono" bind:value={repo} placeholder="~/mtwProjects/mi-app" spellcheck="false" />
							<span class="ofw-help">With a repo the agents run as <code>claude_code</code> and work on those files with native tools.</span>
						</label>

						<details class="ofw-adv">
							<summary>Avanzado</summary>
							<label class="ofw-field">
								<span class="ofw-label">Preview URL</span>
								<input class="ofw-input ofw-mono" bind:value={previewUrl} placeholder="http://localhost:4321" spellcheck="false" />
							</label>
						</details>

						<div class="ofw-nav">
							<span></span>
							<button class="ofw-btn ofw-primary" disabled={!step1Ok} on:click={() => (step = 1)}>Equipo →</button>
						</div>
					</div>

				{:else if step === 1}
					<!-- ── Step 2: Equipo ──────────────────────────── -->
					<div class="ofw-step">
						<div class="ofw-agents">
							{#each agents as agent, i (i)}
								<div class="ofw-agent" class:mgr={agent.manager}>
									<div class="ofw-agent-head">
										<input class="ofw-input ofw-agent-name" bind:value={agent.name} placeholder={agent.manager ? 'Manager (e.g. Lead)' : 'Agent (e.g. Writer)'} maxlength="32" />
										<button class="ofw-mgr-toggle" class:on={agent.manager} on:click={() => setManager(i)}
											title={agent.manager ? 'This is the office manager' : 'Make manager'}>★</button>
										{#if agents.length > 1}
											<button class="ofw-agent-del" on:click={() => removeAgent(i)} title="Remove">&times;</button>
										{/if}
									</div>
									<textarea class="ofw-input ofw-agent-prompt" rows="3" bind:value={agent.prompt}
										placeholder="What this agent does, in 2-3 lines. e.g. 'You write the blog posts, following the editorial calendar…'"></textarea>
								</div>
							{/each}
						</div>
						<button class="ofw-add" on:click={addAgent}>+ Add agent</button>

						{#if managerIdx >= 0 && validAgents.length > 1}
							<label class="ofw-check">
								<input type="checkbox" bind:checked={autoChain} />
								<span>Chain manager → team (the manager dispatches the rest)</span>
							</label>
						{/if}
						{#if managerIdx >= 0}
							<label class="ofw-field ofw-cron">
								<span class="ofw-label">Manager cron <em>(optional)</em></span>
								<input class="ofw-input ofw-mono ofw-cron-input" bind:value={cronEvery} placeholder="45m" spellcheck="false" />
								<span class="ofw-help">Runs on its own every so often: <code>45m</code>, <code>6h</code>… Empty = manual only.</span>
							</label>
						{/if}

						<div class="ofw-nav">
							<button class="ofw-btn" on:click={() => (step = 0)}>← Office</button>
							<button class="ofw-btn ofw-primary" disabled={!step2Ok} on:click={() => (step = 2)}>Review →</button>
						</div>
					</div>

				{:else}
					<!-- ── Step 3: Review ─────────────────────────── -->
					<div class="ofw-step">
						<ul class="ofw-review">
							<li><span class="ofw-rv-k">Office</span><span class="ofw-rv-v"><span class="ofw-dot" style="background:{color}"></span>{officeName.trim()}</span></li>
							<li><span class="ofw-rv-k">Team</span><span class="ofw-rv-v">{validAgents.map((a) => a.manager ? `★ ${a.name.trim()}` : a.name.trim()).join(' · ')}</span></li>
							<li><span class="ofw-rv-k">Executor</span><span class="ofw-rv-v ofw-mono-sm">{repo.trim() ? `claude_code · cwd ${repo.trim()}` : 'native (default provider)'}</span></li>
							{#if autoChain && managerIdx >= 0 && validAgents.length > 1}
								<li><span class="ofw-rv-k">Chains</span><span class="ofw-rv-v">manager → {validAgents.filter((a) => !a.manager).length} agent(s)</span></li>
							{/if}
							{#if cronEvery.trim() && managerIdx >= 0}
								<li><span class="ofw-rv-k">Cron</span><span class="ofw-rv-v ofw-mono-sm">every {cronEvery.trim()} · goal "resume"</span></li>
							{/if}
							{#if previewUrl.trim()}
								<li><span class="ofw-rv-k">Preview</span><span class="ofw-rv-v ofw-mono-sm">{previewUrl.trim()}</span></li>
							{/if}
						</ul>
						<p class="ofw-help">Safe defaults are applied: prompts with office discipline, idempotent (re-creating duplicates nothing){repo.trim() ? ', repo registered automatically' : ''}.</p>

						{#if createError}
							<div class="ofw-error">{createError}</div>
						{/if}

						<div class="ofw-nav">
							<button class="ofw-btn" on:click={() => (step = 1)}>← Equipo</button>
							<button class="ofw-btn ofw-primary ofw-found" disabled={creating} on:click={create}>
								{creating ? 'Founding…' : 'Found office'}
							</button>
						</div>
					</div>
				{/if}
			</section>
		</div>
	</div>
</div>

<style>
	.ofw-overlay {
		position: fixed; inset: 0; z-index: 120;
		background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(5px);
		display: flex; align-items: center; justify-content: center;
	}
	.ofw {
		width: min(880px, calc(100vw - 32px));
		max-height: calc(100vh - 48px);
		display: flex; flex-direction: column;
		background: #0e1018;
		border: 1px solid #2a2e48; border-radius: 12px;
		box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(127, 180, 255, 0.04);
		overflow: hidden;
		animation: ofw-in 0.22s cubic-bezier(0.22, 1, 0.36, 1);
	}
	@keyframes ofw-in { from { opacity: 0; transform: translateY(10px) scale(0.985); } }

	/* ── Header ─────────────────────────────────────────────── */
	.ofw-head {
		display: flex; align-items: flex-start; justify-content: space-between;
		padding: 18px 20px 14px; border-bottom: 1px solid #1e2236;
	}
	.ofw-title {
		font: 700 15px var(--font-display, 'Geist', sans-serif);
		letter-spacing: 4px; color: #d4a84b;
		text-shadow: 0 0 10px rgba(212, 168, 75, 0.25);
	}
	.ofw-sub { font: 400 12px var(--font-body, 'Manrope', sans-serif); color: #8a8fa8; margin-top: 3px; }
	.ofw-x {
		border: none; background: transparent; color: #4a4f6a;
		font-size: 22px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px;
	}
	.ofw-x:hover { color: #e0e2ea; background: rgba(255, 255, 255, 0.05); }

	/* ── Body: blueprint + steps ────────────────────────────── */
	.ofw-body { display: flex; min-height: 0; flex: 1; }

	.ofw-plan {
		position: relative; flex: 0 0 280px;
		background: #0a1428;
		border-right: 1px solid #1e2236;
		display: flex; align-items: center; justify-content: center;
		padding: 10px;
	}
	.ofw-plan svg { width: 100%; height: auto; max-height: 100%; }

	.ofw-room path { stroke-dasharray: 900; stroke-dashoffset: 900; animation: ofw-draw 1.1s ease-out forwards; }
	@keyframes ofw-draw { to { stroke-dashoffset: 0; } }
	.ofw-roof { transition: stroke 0.25s; }
	.ofw-plate-text {
		font: 600 9.5px var(--font-mono, 'Geist Mono', monospace);
		letter-spacing: 2.5px; fill: #cfe3ff;
	}
	.ofw-desk { animation: ofw-pop 0.3s ease-out backwards; }
	@keyframes ofw-pop { from { opacity: 0; transform: translateY(4px); } }
	.ofw-star { font-size: 9px; fill: #d4a84b; }
	.ofw-more { font: 600 10px var(--font-mono, monospace); fill: rgba(127, 180, 255, 0.7); }
	.ofw-badge { animation: ofw-pop 0.3s ease-out; }
	.ofw-badge-text { font: 500 8px var(--font-mono, monospace); letter-spacing: 1px; fill: rgba(160, 195, 255, 0.85); }
	.ofw-tb { font: 500 8px var(--font-mono, monospace); letter-spacing: 1.5px; fill: rgba(127, 180, 255, 0.6); }
	.ofw-tb-dim { fill: rgba(127, 180, 255, 0.35); }

	.ofw-stamp {
		position: absolute; top: 42%; left: 50%;
		transform: translate(-50%, -50%) rotate(-12deg);
		font: 800 26px var(--font-display, sans-serif);
		letter-spacing: 6px; color: #d4a84b;
		border: 3px solid #d4a84b; border-radius: 6px;
		padding: 6px 16px;
		text-shadow: 0 0 18px rgba(212, 168, 75, 0.5);
		box-shadow: inset 0 0 12px rgba(212, 168, 75, 0.15);
		animation: ofw-stamp 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
		pointer-events: none;
	}
	@keyframes ofw-stamp {
		from { opacity: 0; transform: translate(-50%, -50%) rotate(-12deg) scale(1.9); }
		60% { opacity: 1; }
		to { transform: translate(-50%, -50%) rotate(-12deg) scale(1); }
	}

	/* ── Steps pane ─────────────────────────────────────────── */
	.ofw-steps { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 16px 20px 18px; overflow-y: auto; }

	.ofw-crumbs { display: flex; gap: 4px; margin-bottom: 16px; }
	.ofw-crumb {
		display: flex; align-items: center; gap: 6px;
		border: none; background: transparent; cursor: pointer;
		font: 600 11px var(--font-body, sans-serif); color: #4a4f6a;
		padding: 5px 10px; border-radius: 6px;
	}
	.ofw-crumb:disabled { cursor: default; opacity: 0.55; }
	.ofw-crumb.on { color: #e0e2ea; background: #1a1d2a; }
	.ofw-crumb.done { color: #8a8fa8; }
	.ofw-crumb-n {
		display: inline-flex; align-items: center; justify-content: center;
		width: 16px; height: 16px; border-radius: 50%;
		font: 700 9px var(--font-mono, monospace);
		border: 1px solid currentColor;
	}
	.ofw-crumb.done .ofw-crumb-n { border-color: #3dd68c; color: #3dd68c; }

	.ofw-step { display: flex; flex-direction: column; gap: 14px; }

	.ofw-field { display: flex; flex-direction: column; gap: 6px; }
	.ofw-label {
		font: 600 9.5px var(--font-mono, 'Geist Mono', monospace);
		letter-spacing: 1.8px; text-transform: uppercase; color: #4a4f6a;
	}
	.ofw-label em { font-style: normal; text-transform: none; letter-spacing: 0.5px; color: #3a3f58; }
	.ofw-input {
		width: 100%;
		background: #141620; border: 1px solid #1e2236; border-radius: 7px;
		color: #e0e2ea; font: 400 13px var(--font-body, sans-serif);
		padding: 8px 10px; outline: none; transition: border-color 0.15s;
	}
	.ofw-input:focus { border-color: #2a2e48; }
	.ofw-input::placeholder { color: #3a3f58; }
	.ofw-input-lg { font-size: 16px; font-weight: 600; padding: 10px 12px; }
	.ofw-mono { font-family: var(--font-mono, monospace); font-size: 12px; }
	.ofw-mono-sm { font-family: var(--font-mono, monospace); font-size: 11px; }
	.ofw-help { font: 400 11px var(--font-body, sans-serif); color: #4a4f6a; line-height: 1.45; }
	.ofw-help code { color: #8a8fa8; font-family: var(--font-mono, monospace); font-size: 10.5px; }

	.ofw-templates { display: flex; gap: 8px; }
	.ofw-tpl {
		flex: 1; display: flex; flex-direction: column; gap: 3px; text-align: left;
		background: #141620; border: 1px solid #1e2236; border-radius: 8px;
		padding: 9px 10px; cursor: pointer; transition: border-color 0.15s, background 0.15s;
	}
	.ofw-tpl:hover { border-color: #2a2e48; }
	.ofw-tpl.sel { border-color: #d4a84b; background: rgba(212, 168, 75, 0.06); }
	.ofw-tpl-name { font: 600 12px var(--font-body, sans-serif); color: #e0e2ea; }
	.ofw-tpl-desc { font: 400 10.5px var(--font-body, sans-serif); color: #4a4f6a; line-height: 1.3; }

	.ofw-swatches { display: flex; gap: 7px; flex-wrap: wrap; }
	.ofw-swatch {
		width: 22px; height: 22px; border-radius: 50%; cursor: pointer;
		border: 2px solid transparent; outline: 2px solid transparent; outline-offset: 2px;
		transition: transform 0.12s, outline-color 0.12s;
	}
	.ofw-swatch:hover { transform: scale(1.15); }
	.ofw-swatch.sel { outline-color: #e0e2ea; transform: scale(1.12); }

	.ofw-adv summary {
		font: 600 11px var(--font-body, sans-serif); color: #4a4f6a;
		cursor: pointer; user-select: none;
	}
	.ofw-adv summary:hover { color: #8a8fa8; }
	.ofw-adv[open] summary { margin-bottom: 10px; }

	/* Agents */
	.ofw-agents { display: flex; flex-direction: column; gap: 10px; }
	.ofw-agent {
		background: #141620; border: 1px solid #1e2236; border-radius: 9px;
		padding: 10px; display: flex; flex-direction: column; gap: 8px;
	}
	.ofw-agent.mgr { border-color: rgba(212, 168, 75, 0.4); }
	.ofw-agent-head { display: flex; align-items: center; gap: 8px; }
	.ofw-agent-name { flex: 1; background: #0e1018; }
	.ofw-mgr-toggle {
		flex: 0 0 auto; width: 28px; height: 28px; border-radius: 7px;
		border: 1px solid #1e2236; background: transparent; cursor: pointer;
		color: #3a3f58; font-size: 13px; line-height: 1;
		transition: color 0.15s, border-color 0.15s;
	}
	.ofw-mgr-toggle:hover { color: #8a8fa8; }
	.ofw-mgr-toggle.on { color: #d4a84b; border-color: rgba(212, 168, 75, 0.5); }
	.ofw-agent-del {
		flex: 0 0 auto; border: none; background: transparent; cursor: pointer;
		color: #3a3f58; font-size: 16px; padding: 2px 5px; border-radius: 5px;
	}
	.ofw-agent-del:hover { color: #f04770; }
	.ofw-agent-prompt { resize: vertical; min-height: 54px; background: #0e1018; font-size: 12px; line-height: 1.5; }

	.ofw-add {
		align-self: flex-start;
		border: 1px dashed #2a2e48; background: transparent; border-radius: 7px;
		color: #8a8fa8; font: 600 11.5px var(--font-body, sans-serif);
		padding: 7px 12px; cursor: pointer; transition: color 0.15s, border-color 0.15s;
	}
	.ofw-add:hover { color: #e0e2ea; border-color: #4a4f6a; }

	.ofw-check {
		display: flex; align-items: center; gap: 8px; cursor: pointer;
		font: 400 12px var(--font-body, sans-serif); color: #8a8fa8;
	}
	.ofw-check input { accent-color: #d4a84b; }
	.ofw-cron-input { max-width: 120px; }

	/* Review */
	.ofw-review { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
	.ofw-review li {
		display: flex; gap: 12px; align-items: baseline;
		padding: 8px 2px; border-bottom: 1px solid #171a28;
	}
	.ofw-rv-k {
		flex: 0 0 76px;
		font: 600 9.5px var(--font-mono, monospace);
		letter-spacing: 1.5px; text-transform: uppercase; color: #4a4f6a;
	}
	.ofw-rv-v { font: 500 12.5px var(--font-body, sans-serif); color: #e0e2ea; display: inline-flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; overflow-wrap: anywhere; }
	.ofw-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }

	.ofw-error {
		background: rgba(240, 71, 112, 0.08); border: 1px solid rgba(240, 71, 112, 0.35);
		border-radius: 7px; padding: 8px 10px;
		font: 400 12px var(--font-body, sans-serif); color: #f04770;
	}

	/* Success */
	.ofw-done { display: flex; flex-direction: column; gap: 12px; }
	.ofw-done-title { font: 500 14px var(--font-body, sans-serif); color: #e0e2ea; }
	.ofw-done-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
	.ofw-done-list li { font: 400 12px var(--font-body, sans-serif); color: #8a8fa8; }
	.ofw-done-list li.warn { color: #f0883e; }
	.ofw-done-hint { font: 400 12px var(--font-body, sans-serif); color: #4a4f6a; font-style: italic; }

	/* Nav */
	.ofw-nav { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; padding-top: 4px; }
	.ofw-btn {
		border: 1px solid #2a2e48; background: transparent; border-radius: 8px;
		color: #8a8fa8; font: 600 12px var(--font-body, sans-serif);
		padding: 8px 16px; cursor: pointer; transition: color 0.15s, border-color 0.15s, background 0.15s;
	}
	.ofw-btn:hover:not(:disabled) { color: #e0e2ea; border-color: #4a4f6a; }
	.ofw-btn:disabled { opacity: 0.45; cursor: default; }
	.ofw-primary {
		border-color: rgba(212, 168, 75, 0.55); color: #d4a84b;
	}
	.ofw-primary:hover:not(:disabled) { background: rgba(212, 168, 75, 0.1); color: #e8c26a; border-color: #d4a84b; }
	.ofw-found { font-size: 13px; padding: 9px 20px; letter-spacing: 0.3px; }

	/* Responsive: blueprint stacks on top */
	@media (max-width: 720px) {
		.ofw-body { flex-direction: column; overflow-y: auto; }
		.ofw-plan { flex: 0 0 auto; border-right: none; border-bottom: 1px solid #1e2236; }
		.ofw-plan svg { max-width: 260px; }
		.ofw-steps { overflow-y: visible; }
	}

	@media (prefers-reduced-motion: reduce) {
		.ofw, .ofw-room path, .ofw-desk, .ofw-badge, .ofw-stamp { animation: none; }
		.ofw-room path { stroke-dashoffset: 0; }
	}
</style>
