<script lang="ts">
	/*
	  Office panel → Projects: which projects this office works for, its
	  settings for each (shaped by the office's own schema when its extension
	  declares one, raw JSON otherwise), and a way to run the office lead for
	  one of them.
	*/
	import { onMount } from 'svelte';
	import { apiFetchRaw, readApiError } from '$lib/api.js';

	export let flowId: string;
	/** The office lead — "Correr" runs it for the chosen project. */
	export let leadId: string | null = null;

	interface Project { id: string; slug: string; name: string; status: string }
	interface Row { project_id: string; active: boolean; settings: Record<string, unknown>; project: Project }
	interface Schema { type?: string; properties?: Record<string, { type?: string; title?: string; description?: string; items?: { type?: string } }> }

	let rows: Row[] = [];
	let schema: Schema | null = null;
	let all: Project[] = [];
	let error = '';
	let notice = '';
	let busy = false;
	let editing = '';
	let jsonText = '';
	let form: Record<string, string> = {};
	let flags: Record<string, boolean> = {};
	let adding = false;
	let addId = '';

	async function call(path: string, init: RequestInit = {}): Promise<any> {
		const r = await apiFetchRaw(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
		if (!r.ok) throw new Error((await readApiError(r)) ?? `HTTP ${r.status}`);
		return r.json();
	}

	async function load() {
		try {
			const [op, list] = await Promise.all([call(`/api/offices/${encodeURIComponent(flowId)}/projects`), call('/api/projects')]);
			rows = op.projects ?? [];
			schema = op.settings_schema ?? null;
			all = list.projects ?? [];
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	onMount(load);
	$: if (flowId) void load();

	$: unassigned = all.filter((p) => p.status === 'active' && !rows.some((r) => r.project_id === p.id));
	$: props = Object.entries(schema?.properties ?? {});

	async function act(fn: () => Promise<void>, ok = '') {
		busy = true;
		try { await fn(); notice = ok; error = ''; } catch (e) { error = e instanceof Error ? e.message : String(e); notice = ''; } finally { busy = false; }
	}

	const setActive = (r: Row, active: boolean) => act(async () => {
		await call(`/api/projects/${r.project_id}/offices/${encodeURIComponent(flowId)}`, { method: 'PUT', body: JSON.stringify({ active }) });
		await load();
	});

	const assign = () => act(async () => {
		if (!addId) return;
		await call(`/api/projects/${addId}/offices/${encodeURIComponent(flowId)}`, { method: 'PUT', body: JSON.stringify({ active: true }) });
		adding = false;
		addId = '';
		await load();
	});

	const unassign = (r: Row) => act(async () => {
		await call(`/api/projects/${r.project_id}/offices/${encodeURIComponent(flowId)}`, { method: 'DELETE' });
		if (editing === r.project_id) editing = '';
		await load();
	});

	function edit(r: Row) {
		editing = editing === r.project_id ? '' : r.project_id;
		jsonText = JSON.stringify(r.settings ?? {}, null, 2);
		form = {};
		flags = {};
		for (const [k, p] of props) {
			const v = r.settings?.[k];
			if (p.type === 'boolean') flags[k] = v === true;
			else form[k] = Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v);
		}
	}

	function settingsFromForm(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [k, p] of props) {
			const v = form[k];
			if (p.type === 'boolean') out[k] = flags[k] === true;
			else if (p.type === 'array') out[k] = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
			else if (p.type === 'number' || p.type === 'integer') { if (String(v).trim() !== '') out[k] = Number(v); }
			else if (String(v ?? '').trim() !== '') out[k] = String(v);
		}
		return out;
	}

	const saveSettings = (r: Row) => act(async () => {
		let settings: Record<string, unknown>;
		if (props.length) settings = settingsFromForm();
		else {
			try { settings = JSON.parse(jsonText || '{}'); } catch { throw new Error('Los settings no son JSON válido'); }
			if (typeof settings !== 'object' || Array.isArray(settings) || settings === null) throw new Error('Los settings tienen que ser un objeto JSON');
		}
		await call(`/api/projects/${r.project_id}/offices/${encodeURIComponent(flowId)}`, { method: 'PUT', body: JSON.stringify({ settings }) });
		editing = '';
		await load();
	}, 'Settings guardados');

	const runFor = (r: Row) => act(async () => {
		if (!leadId) throw new Error('La oficina no tiene líder');
		const res = await call('/api/agents/run', { method: 'POST', body: JSON.stringify({ agent_id: leadId, project: r.project_id }) });
		if (!res?.run_id) throw new Error('El run no arrancó');
	}, 'Run iniciado');
</script>

<div class="opj">
	{#if error}<p class="k-error" role="alert">{error}</p>{/if}
	{#if notice}<p class="k-help" aria-live="polite">{notice}</p>{/if}

	{#if rows.length === 0}
		<p class="k-help">Esta oficina todavía no trabaja para ningún proyecto.</p>
	{/if}

	<ul>
		{#each rows as r (r.project_id)}
			<li>
				<div class="line">
					<label class="sw"><input type="checkbox" checked={r.active} disabled={busy} on:change={(e) => setActive(r, e.currentTarget.checked)} aria-label="Activo para {r.project.name}" /></label>
					<span class="pname" class:dim={!r.active}>{r.project.name}<small>{r.project.slug}</small></span>
					<button class="k-btn sm" type="button" on:click={() => edit(r)} aria-expanded={editing === r.project_id}>Settings</button>
					<button class="k-btn sm" type="button" on:click={() => runFor(r)} disabled={busy || !r.active || !leadId} title="Corre al líder de la oficina para este proyecto">▶ Correr</button>
					<button class="x" type="button" on:click={() => unassign(r)} aria-label="Quitar {r.project.name}">×</button>
				</div>
				{#if editing === r.project_id}
					<form class="settings" on:submit|preventDefault={() => saveSettings(r)}>
						{#if props.length}
							{#each props as [k, p]}
								{#if p.type === 'boolean'}
									<label class="chk"><input type="checkbox" bind:checked={flags[k]} />{p.title ?? k}</label>
								{:else}
									<label>{p.title ?? k}{#if p.type === 'array'}<small> (separado por comas)</small>{/if}
										<input bind:value={form[k]} inputmode={p.type === 'number' || p.type === 'integer' ? 'decimal' : 'text'} />
										{#if p.description}<small>{p.description}</small>{/if}
									</label>
								{/if}
							{/each}
						{:else}
							<label>Settings (JSON)<textarea rows="5" bind:value={jsonText} spellcheck="false"></textarea></label>
						{/if}
						<div class="acts"><button class="k-btn" type="button" on:click={() => (editing = '')}>Cancelar</button><button class="k-btn k-btn--primary" disabled={busy}>Guardar</button></div>
					</form>
				{/if}
			</li>
		{/each}
	</ul>

	{#if adding}
		<form class="add" on:submit|preventDefault={assign}>
			<select bind:value={addId} aria-label="Proyecto a asignar">
				<option value="">Elegí un proyecto…</option>
				{#each unassigned as p}<option value={p.id}>{p.name}</option>{/each}
			</select>
			<button class="k-btn" type="button" on:click={() => (adding = false)}>Cancelar</button>
			<button class="k-btn k-btn--primary" disabled={!addId || busy}>Asignar</button>
		</form>
	{:else if unassigned.length}
		<button class="k-btn" type="button" on:click={() => (adding = true)}>+ Asignar proyecto</button>
	{:else if all.length === 0}
		<p class="k-help">Creá proyectos en <a href="/projects">Proyectos</a>.</p>
	{/if}
</div>

<style>
	.opj { display: grid; gap: 8px; }
	ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
	.line { display: grid; grid-template-columns: 22px 1fr auto auto 28px; align-items: center; gap: 6px; min-height: 36px; }
	.pname { display: flex; flex-direction: column; font-size: 13px; color: var(--text-1); }
	.pname small { font-family: var(--font-mono); font-size: 10px; color: var(--text-3); }
	.pname.dim { opacity: 0.55; }
	.sm { padding: 4px 9px; font-size: 12px; }
	.x { background: none; border: 0; color: var(--text-3); cursor: pointer; font-size: 17px; height: 28px; }
	.x:hover { color: var(--red); }
	.settings { display: grid; gap: 8px; padding: 8px 0 8px 28px; }
	.settings label { display: grid; gap: 3px; font-size: 12px; color: var(--text-2); }
	.settings small { color: var(--text-3); font-size: 11px; }
	.settings .chk { display: flex; align-items: center; gap: 8px; }
	input, select, textarea { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-1); padding: 6px 8px; font: inherit; font-size: 13px; }
	textarea { font-family: var(--font-mono); font-size: 12px; resize: vertical; }
	.acts, .add { display: flex; gap: 6px; justify-content: flex-end; }
	.add select { flex: 1; }
</style>
