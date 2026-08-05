<script lang="ts">
	import { tick } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { CommanderTab, PaneId, PaneState } from '$lib/commander-stores.js';
	import {
		activeTab,
		closeTab,
		setActiveTab,
		summarize,
		updateActiveTab,
		visibleEntries,
		createTab
	} from '$lib/commander-stores.js';
	import type { FsEntry } from '$lib/fs-api.js';

	export let paneId: PaneId;
	export let store: Writable<PaneState>;
	export let active: boolean;
	export let onActivate: () => void;
	export let onNavigate: (path: string) => void;
	export let onOpen: (entry: FsEntry) => void;
	/** Re-runs the listing for this pane's current path. */
	export let onRetry: () => void;
	/** Jumps this pane back to the provider's home directory. */
	export let onHome: () => void;
	/** Dismisses the transient operation notice. */
	export let onDismissNotice: () => void;

	$: tab = activeTab($store);
	$: entries = tab ? visibleEntries(tab) : [];
	$: stats = summarize(tab);
	$: atRoot = !tab || tab.path === '/' || tab.path === '';
	$: parentPath = tab ? parentOf(tab.path) : '/';

	/** DOM id of the cursor row — drives aria-activedescendant. */
	$: cursorId = tab?.cursor ? `${paneId}-row-${hashName(tab.cursor)}` : undefined;

	let listEl: HTMLDivElement | null = null;

	/**
	 * Keep the cursor row on screen. The keyboard router lives on `window`, so
	 * nothing scrolls the list on its own — without this, j/k walks the cursor
	 * straight off the bottom of a long directory and the pane looks frozen.
	 */
	$: if (tab?.cursor && listEl) scrollCursorIntoView(tab.cursor);

	async function scrollCursorIntoView(name: string): Promise<void> {
		await tick();
		const el = listEl?.querySelector<HTMLElement>(`[data-name="${cssEscape(name)}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	}

	function cssEscape(s: string): string {
		return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"');
	}

	/** Stable, selector-safe id fragment for a filename. */
	function hashName(name: string): string {
		let h = 0;
		for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
		return Math.abs(h).toString(36);
	}

	// ── Formatting ──────────────────────────────────────────────────

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		const units = ['K', 'M', 'G', 'T'];
		let v = n / 1024;
		let i = 0;
		while (v >= 1024 && i < units.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
	}

	/**
	 * Dates carry meaning at a glance only when they are relative. A column of
	 * identical `2025-06-06 14:38` stamps is 16 characters of noise; "6 Jun" and
	 * "2h ago" are scannable. The full ISO stamp stays in the row's title.
	 */
	function fmtMtime(iso: string): string {
		const then = new Date(iso);
		if (Number.isNaN(then.getTime())) return iso.slice(0, 16).replace('T', ' ');
		const diffMs = Date.now() - then.getTime();
		const mins = Math.round(diffMs / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.round(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const sameYear = then.getFullYear() === new Date().getFullYear();
		return then.toLocaleDateString('en-GB', {
			day: '2-digit',
			month: 'short',
			...(sameYear ? {} : { year: 'numeric' })
		});
	}

	const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz', 'tbz']);

	function entryClass(e: FsEntry): string {
		if (e.kind === 'dir') return 'dir';
		if (e.kind === 'symlink') return 'symlink';
		if (e.kind === 'file') {
			const ext = e.name.includes('.') ? e.name.split('.').pop()!.toLowerCase() : '';
			if (ARCHIVE_EXTS.has(ext)) return 'archive';
			if (e.permissions?.includes('x')) return 'exec';
		}
		return 'file';
	}

	/**
	 * Glyphs, not emoji — emoji render differently per platform and can't be
	 * recoloured by the theme. Each kind gets a distinct shape so the list stays
	 * readable without relying on colour alone.
	 */
	function entryIcon(e: FsEntry): string {
		if (e.kind === 'dir') return '▪';
		if (e.kind === 'symlink') return '↗';
		const cls = entryClass(e);
		if (cls === 'archive') return '◈';
		if (cls === 'exec') return '▸';
		return '·';
	}

	function entryKindLabel(e: FsEntry): string {
		if (e.kind === 'dir') return 'Folder';
		if (e.kind === 'symlink') return `Symlink${e.target ? ` to ${e.target}` : ''}`;
		const cls = entryClass(e);
		if (cls === 'archive') return 'Archive';
		if (cls === 'exec') return 'Executable';
		return 'File';
	}

	function crumbs(path: string): Array<{ label: string; path: string }> {
		const parts = path.split('/').filter(Boolean);
		const out: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }];
		let cur = '';
		for (const p of parts) {
			cur += '/' + p;
			out.push({ label: p, path: cur });
		}
		return out;
	}

	function parentOf(p: string): string {
		if (!p || p === '/') return '/';
		const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
		return trimmed.slice(0, trimmed.lastIndexOf('/')) || '/';
	}

	// ── Interaction ─────────────────────────────────────────────────

	function onRowClick(e: MouseEvent, entry: FsEntry): void {
		onActivate();
		if (!tab) return;
		const t = tab;
		if (e.shiftKey) {
			const names = entries.map((x) => x.name);
			const a = names.indexOf(t.cursor ?? names[0]);
			const b = names.indexOf(entry.name);
			const [from, to] = a < b ? [a, b] : [b, a];
			const newSel = new Set(t.selection);
			for (let i = from; i <= to; i++) newSel.add(names[i]);
			updateActiveTab(store, (x) => ({ ...x, selection: newSel, cursor: entry.name }));
		} else if (e.ctrlKey || e.metaKey) {
			const newSel = new Set(t.selection);
			if (newSel.has(entry.name)) newSel.delete(entry.name);
			else newSel.add(entry.name);
			updateActiveTab(store, (x) => ({ ...x, selection: newSel, cursor: entry.name }));
		} else {
			updateActiveTab(store, (x) => ({ ...x, cursor: entry.name }));
		}
	}

	function onRowDblClick(entry: FsEntry): void {
		onActivate();
		onOpen(entry);
	}

	function goTo(path: string): void {
		onActivate();
		onNavigate(path);
	}

	function onFilterInput(ev: Event): void {
		const value = (ev.target as HTMLInputElement).value;
		updateActiveTab(store, (x) => ({ ...x, filter: value }));
	}

	function clearFilter(): void {
		updateActiveTab(store, (x) => ({ ...x, filter: '' }));
	}

	function onSortClick(by: 'name' | 'size' | 'mtime'): void {
		updateActiveTab(store, (x) => ({
			...x,
			sortBy: by,
			sortDir: x.sortBy === by && x.sortDir === 'asc' ? 'desc' : 'asc'
		}));
	}

	function ariaSort(by: 'name' | 'size' | 'mtime'): 'ascending' | 'descending' | 'none' {
		if (tab?.sortBy !== by) return 'none';
		return tab.sortDir === 'asc' ? 'ascending' : 'descending';
	}

	// ── Editable path (Ctrl+L / click the path chip) ────────────────

	let editingPath = false;
	let pathDraft = '';
	let pathInput: HTMLInputElement | null = null;

	export async function beginPathEdit(): Promise<void> {
		if (!tab) return;
		pathDraft = tab.path;
		editingPath = true;
		await tick();
		pathInput?.focus();
		pathInput?.select();
	}

	function commitPath(): void {
		const next = pathDraft.trim();
		editingPath = false;
		if (next && next !== tab?.path) goTo(next);
	}

	function onPathKeydown(ev: KeyboardEvent): void {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			commitPath();
		} else if (ev.key === 'Escape') {
			ev.preventDefault();
			editingPath = false;
		}
	}

	/** Rows drawn while a listing is in flight — steadier than a spinner. */
	const SKELETON_ROWS = 14;
</script>

<section
	class="cmd-pane"
	class:active
	on:click={onActivate}
	on:focusin={onActivate}
	role="presentation"
	aria-label={`${paneId} pane`}
>
	<!-- Tabs -->
	<div class="cmd-tabs" role="tablist" aria-label={`${paneId} pane tabs`}>
		{#each $store.tabs as t (t.id)}
			<div class="cmd-tab-wrap" class:active={t.id === $store.activeTabId}>
				<button
					class="cmd-tab"
					role="tab"
					aria-selected={t.id === $store.activeTabId}
					on:click|stopPropagation={() => {
						onActivate();
						setActiveTab(store, t.id);
					}}
					title={`${t.providerId}:${t.path}`}
				>
					{t.title || '/'}
				</button>
				{#if $store.tabs.length > 1}
					<button
						class="cmd-tab-close"
						aria-label={`Close tab ${t.title || '/'}`}
						title="Close tab (Ctrl+W)"
						on:click|stopPropagation={() => closeTab(store, t.id)}>×</button
					>
				{/if}
			</div>
		{/each}
		<button
			class="cmd-tab-new"
			aria-label="New tab"
			title="New tab (Ctrl+T)"
			on:click|stopPropagation={() => {
				onActivate();
				if (tab) createTab(store, tab.providerId, tab.path);
			}}>+</button
		>
	</div>

	<!-- Header: provider + breadcrumb + quick filter -->
	<div class="cmd-header">
		<span class="provider-pill" title={`Provider: ${tab?.providerId ?? 'none'}`}>
			{tab?.providerId ?? '—'}
		</span>

		{#if editingPath}
			<input
				class="path-input"
				bind:this={pathInput}
				bind:value={pathDraft}
				aria-label="Edit path"
				spellcheck="false"
				on:keydown={onPathKeydown}
				on:blur={() => (editingPath = false)}
				on:click|stopPropagation
			/>
		{:else}
			<nav class="crumb" aria-label="Path">
				{#if tab}
					{#each crumbs(tab.path) as c, i (c.path)}
						{#if i > 0}<span class="crumb-sep" aria-hidden="true">/</span>{/if}
						<button
							class="crumb-seg"
							class:last={i === crumbs(tab.path).length - 1}
							on:click|stopPropagation={() => goTo(c.path)}>{c.label}</button
						>
					{/each}
				{/if}
			</nav>
			<button
				class="path-edit"
				title="Edit path (Ctrl+L)"
				aria-label="Edit path"
				on:click|stopPropagation={beginPathEdit}>✎</button
			>
		{/if}

		<div class="actions">
			<div class="filter-wrap">
				<span class="filter-icon" aria-hidden="true">⌕</span>
				<input
					class="filter"
					placeholder="Filter"
					aria-label="Filter entries by name"
					value={tab?.filter ?? ''}
					on:input={onFilterInput}
					on:click|stopPropagation
				/>
				{#if tab?.filter}
					<button
						class="filter-clear"
						aria-label="Clear filter"
						on:click|stopPropagation={clearFilter}>×</button
					>
				{/if}
			</div>
		</div>
	</div>

	<!-- Column headers double as sort controls -->
	<div class="cmd-cols" role="row">
		<span class="col-icon" aria-hidden="true"></span>
		<button
			class="col-btn name"
			role="columnheader"
			aria-sort={ariaSort('name')}
			on:click|stopPropagation={() => onSortClick('name')}
		>
			Name
			<span class="caret" aria-hidden="true"
				>{tab?.sortBy === 'name' ? (tab.sortDir === 'asc' ? '▲' : '▼') : ''}</span
			>
		</button>
		<button
			class="col-btn size"
			role="columnheader"
			aria-sort={ariaSort('size')}
			on:click|stopPropagation={() => onSortClick('size')}
		>
			<span class="caret" aria-hidden="true"
				>{tab?.sortBy === 'size' ? (tab.sortDir === 'asc' ? '▲' : '▼') : ''}</span
			>
			Size
		</button>
		<button
			class="col-btn mtime"
			role="columnheader"
			aria-sort={ariaSort('mtime')}
			on:click|stopPropagation={() => onSortClick('mtime')}
		>
			<span class="caret" aria-hidden="true"
				>{tab?.sortBy === 'mtime' ? (tab.sortDir === 'asc' ? '▲' : '▼') : ''}</span
			>
			Modified
		</button>
	</div>

	<!-- Transient operation failure — sits above the listing instead of
	     replacing it, so the user keeps their place. -->
	{#if tab?.notice}
		<div class="cmd-notice" role="status">
			<span class="notice-glyph" aria-hidden="true">⚠</span>
			<span class="notice-text">{tab.notice}</span>
			<button class="notice-close" aria-label="Dismiss message" on:click|stopPropagation={onDismissNotice}
				>×</button
			>
		</div>
	{/if}

	<!-- File list -->
	<div
		class="cmd-list"
		bind:this={listEl}
		role="listbox"
		tabindex="0"
		aria-label={`Entries in ${tab?.path ?? '/'}`}
		aria-activedescendant={cursorId}
		aria-multiselectable="true"
		on:focus={onActivate}
	>
		{#if tab?.loading}
			<div class="cmd-skeleton" aria-busy="true" aria-label="Loading directory">
				{#each Array(SKELETON_ROWS) as _, i}
					<div class="sk-row" style={`--sk-delay:${i * 40}ms`}>
						<span class="sk-bar icon"></span>
						<span class="sk-bar name" style={`width:${35 + ((i * 17) % 45)}%`}></span>
						<span class="sk-bar size"></span>
						<span class="sk-bar mtime"></span>
					</div>
				{/each}
			</div>
		{:else if tab?.error}
			<div class="cmd-state error" role="alert">
				<span class="state-glyph" aria-hidden="true">⚠</span>
				<h3 class="state-title">{tab.error.message}</h3>
				<p class="state-body">
					<code>{tab.error.path ?? tab.path}</code>
				</p>
				<div class="state-actions">
					<button class="state-btn primary" on:click|stopPropagation={onRetry}>Retry</button>
					{#if !atRoot}
						<button class="state-btn" on:click|stopPropagation={() => goTo(parentPath)}>
							Go up
						</button>
					{/if}
					<button class="state-btn" on:click|stopPropagation={onHome}>Go to home</button>
				</div>
				{#if tab.error.detail}
					<details class="state-detail">
						<summary>Technical detail</summary>
						<pre>{tab.error.status ? `HTTP ${tab.error.status} — ` : ''}{tab.error.detail}</pre>
					</details>
				{/if}
			</div>
		{:else if entries.length === 0 && tab?.filter}
			<div class="cmd-state">
				<span class="state-glyph" aria-hidden="true">⌕</span>
				<h3 class="state-title">Nothing matches “{tab.filter}”</h3>
				<p class="state-body">
					{tab.entries.length}
					{tab.entries.length === 1 ? 'entry is' : 'entries are'} hidden by the filter.
				</p>
				<div class="state-actions">
					<button class="state-btn primary" on:click|stopPropagation={clearFilter}>
						Clear filter
					</button>
				</div>
			</div>
		{:else if entries.length === 0}
			<div class="cmd-state">
				<span class="state-glyph" aria-hidden="true">∅</span>
				<h3 class="state-title">This folder is empty</h3>
				<p class="state-body">Press <kbd>F7</kbd> to create a directory here.</p>
				{#if !atRoot}
					<div class="state-actions">
						<button class="state-btn" on:click|stopPropagation={() => goTo(parentPath)}>
							Go up
						</button>
					</div>
				{/if}
			</div>
		{:else}
			{#if !atRoot}
				<!-- Classic commander affordance: walking up should not require
				     knowing that Backspace does it. -->
				<div
					class="cmd-row parent"
					role="option"
					aria-selected="false"
					tabindex="-1"
					title={`Go up to ${parentPath}`}
					on:click|stopPropagation={() => goTo(parentPath)}
					on:keydown={(ev) => ev.key === 'Enter' && goTo(parentPath)}
				>
					<span class="icon" aria-hidden="true">↰</span>
					<span class="name">..</span>
					<span class="size"></span>
					<span class="mtime">up</span>
				</div>
			{/if}
			{#each entries as e (e.name)}
				<!--
					Rows are `option`s inside the listbox above, which is the element
					that holds focus and `aria-activedescendant`. Keyboard handling
					belongs there and on the page's key router — a per-row keydown
					would be unreachable, since options are never focused directly.
				-->
				<!-- svelte-ignore a11y-click-events-have-key-events -->
				<div
					id={`${paneId}-row-${hashName(e.name)}`}
					class="cmd-row {entryClass(e)}"
					class:cursor={tab?.cursor === e.name}
					class:selected={tab?.selection.has(e.name)}
					data-name={e.name}
					role="option"
					aria-selected={tab?.selection.has(e.name) ?? false}
					tabindex="-1"
					title={`${entryKindLabel(e)} — ${e.name}\n${e.mtime}${
						e.kind === 'dir' ? '' : ` — ${fmtBytes(e.size)}`
					}`}
					on:click={(ev) => onRowClick(ev, e)}
					on:dblclick={() => onRowDblClick(e)}
				>
					<span class="icon" aria-hidden="true">{entryIcon(e)}</span>
					<span class="name">{e.name}{e.kind === 'dir' ? '/' : ''}</span>
					<span class="size">{e.kind === 'dir' ? '—' : fmtBytes(e.size)}</span>
					<span class="mtime">{fmtMtime(e.mtime)}</span>
				</div>
			{/each}
		{/if}
	</div>

	<!-- Per-pane footer: the counts belong next to the list they describe -->
	<footer class="cmd-pane-foot">
		<span class="foot-counts">
			<span class="n dir">{stats.dirs}</span> dirs
			<span class="dot" aria-hidden="true">·</span>
			<span class="n">{stats.files}</span> files
		</span>
		{#if stats.filtered > 0}
			<span class="foot-filtered">{stats.filtered} hidden</span>
		{/if}
		{#if stats.selected > 0}
			<span class="foot-sel">
				{stats.selected} selected · {fmtBytes(stats.selectedBytes)}
			</span>
		{/if}
		<span class="foot-side" aria-hidden="true">{paneId === 'left' ? 'L' : 'R'}</span>
	</footer>
</section>
