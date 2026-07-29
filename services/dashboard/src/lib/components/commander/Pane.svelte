<script lang="ts">
	import type { Writable } from 'svelte/store';
	import type { CommanderTab, PaneId, PaneState } from '$lib/commander-stores.js';
	import {
		activeTab,
		closeTab,
		setActiveTab,
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

	$: tab = activeTab($store);
	$: entries = tab ? visibleEntries(tab) : [];

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n}`;
		const units = ['K', 'M', 'G', 'T'];
		let v = n / 1024;
		let i = 0;
		while (v >= 1024 && i < units.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v.toFixed(1)}${units[i]}`;
	}

	function fmtMtime(iso: string): string {
		// "YYYY-MM-DD HH:MM"
		return iso.slice(0, 16).replace('T', ' ');
	}

	const ARCHIVE_EXTS = new Set([
		'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz', 'tbz'
	]);

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

	function entryIcon(e: FsEntry): string {
		if (e.kind === 'dir') return '▸';
		if (e.kind === 'symlink') return '↗';
		if (entryClass(e) === 'archive') return '◇';
		if (entryClass(e) === 'exec') return '●';
		return ' ';
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

	function onRowClick(e: MouseEvent, entry: FsEntry): void {
		onActivate();
		if (!tab) return;
		const t = tab; // narrow
		if (e.shiftKey) {
			// Range select from cursor to this entry.
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

	function onSortClick(by: 'name' | 'size' | 'mtime'): void {
		updateActiveTab(store, (x) => ({
			...x,
			sortBy: by,
			sortDir: x.sortBy === by && x.sortDir === 'asc' ? 'desc' : 'asc'
		}));
	}
</script>

<div
	class="cmd-pane"
	class:active
	on:click={onActivate}
	on:keydown
	role="presentation"
>
	<!-- Tabs -->
	<div class="cmd-tabs">
		{#each $store.tabs as t (t.id)}
			<button
				class="cmd-tab"
				class:active={t.id === $store.activeTabId}
				on:click|stopPropagation={() => {
					onActivate();
					setActiveTab(store, t.id);
				}}
				title={`${t.providerId}:${t.path}`}
			>
				<span>{t.title || '/'}</span>
				{#if $store.tabs.length > 1}
					<span
						class="close"
						on:click|stopPropagation={() => closeTab(store, t.id)}
						role="button"
						tabindex="-1"
					>×</span>
				{/if}
			</button>
		{/each}
		<button
			class="cmd-tab new-tab"
			title="New tab (Ctrl+T)"
			on:click|stopPropagation={() => {
				onActivate();
				if (tab) createTab(store, tab.providerId, tab.path);
			}}
		>+</button>
	</div>

	<!-- Header: breadcrumb + quick filter + sort -->
	<div class="cmd-header">
		<span class="provider-pill">{tab?.providerId ?? '-'}</span>
		<span class="crumb">
			{#if tab}
				{#each crumbs(tab.path) as c, i (c.path)}
					{#if i > 0}<span class="crumb-sep">›</span>{/if}
					<span class="crumb-seg" on:click={() => goTo(c.path)} role="button" tabindex="0">{c.label}</span>
				{/each}
			{/if}
		</span>
		<span class="actions">
			<input
				class="filter"
				placeholder="filter…"
				value={tab?.filter ?? ''}
				on:input={onFilterInput}
				on:click|stopPropagation
			/>
			<button class="icon" title="Sort by name" on:click|stopPropagation={() => onSortClick('name')}>N</button>
			<button class="icon" title="Sort by size" on:click|stopPropagation={() => onSortClick('size')}>S</button>
			<button class="icon" title="Sort by modified" on:click|stopPropagation={() => onSortClick('mtime')}>M</button>
		</span>
	</div>

	<!-- File list -->
	<div class="cmd-list">
		{#if tab?.loading}
			<div class="cmd-empty">Loading…</div>
		{:else if tab?.error}
			<div class="cmd-error">⚠︎ {tab.error}</div>
		{:else if entries.length === 0}
			<div class="cmd-empty">No entries.</div>
		{:else}
			{#each entries as e (e.name)}
				<div
					class="cmd-row {entryClass(e)}"
					class:cursor={tab?.cursor === e.name}
					class:selected={tab?.selection.has(e.name)}
					on:click={(ev) => onRowClick(ev, e)}
					on:dblclick={() => onRowDblClick(e)}
					role="button"
					tabindex="-1"
				>
					<span class="icon">{entryIcon(e)}</span>
					<span class="name">{e.name}{e.kind === 'dir' ? '/' : ''}</span>
					<span class="size">{e.kind === 'dir' ? '—' : fmtBytes(e.size)}</span>
					<span class="mtime">{fmtMtime(e.mtime)}</span>
				</div>
			{/each}
		{/if}
	</div>
</div>
