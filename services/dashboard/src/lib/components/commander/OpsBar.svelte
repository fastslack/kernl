<script lang="ts">
	export let onAction: (id: string) => void;
	/** Number of entries the F-keys would act on; gates the destructive ones. */
	export let targetCount = 0;
	/** True when the cursor sits on a file (View/Edit only make sense then). */
	export let hasFileCursor = false;

	interface Action {
		key: string;
		id: string;
		label: string;
		/** Marks the action as destructive so it reads red. */
		danger?: boolean;
		/** Disabled when there is nothing to act on. */
		needsTarget?: boolean;
		/** Disabled unless the cursor is on a file. */
		needsFile?: boolean;
	}

	const actions: Action[] = [
		{ key: 'F3', id: 'view', label: 'View', needsFile: true },
		{ key: 'F4', id: 'edit', label: 'Edit', needsFile: true },
		{ key: 'F5', id: 'copy', label: 'Copy', needsTarget: true },
		{ key: 'F6', id: 'move', label: 'Move', needsTarget: true },
		{ key: 'F7', id: 'mkdir', label: 'New folder' },
		{ key: 'F8', id: 'delete', label: 'Delete', danger: true, needsTarget: true },
		{ key: '⌃B', id: 'bookmark', label: 'Bookmark' },
		{ key: '⌃T', id: 'new-tab', label: 'New tab' },
		{ key: '⌃R', id: 'remotes', label: 'Remotes' },
		{ key: '⌃H', id: 'history', label: 'History' },
		{ key: ':', id: 'cmd', label: 'Command' }
	];

	function disabled(a: Action): boolean {
		if (a.needsFile) return !hasFileCursor;
		if (a.needsTarget) return targetCount === 0;
		return false;
	}

	function hint(a: Action): string {
		if (a.needsFile && !hasFileCursor) return `${a.label} — select a file first`;
		if (a.needsTarget && targetCount === 0) return `${a.label} — nothing selected`;
		if (a.needsTarget) return `${a.label} ${targetCount} item${targetCount === 1 ? '' : 's'}`;
		return a.label;
	}
</script>

<div class="cmd-opsbar" role="toolbar" aria-label="File operations">
	{#each actions as a (a.id)}
		<button
			class="fkey"
			class:danger={a.danger}
			disabled={disabled(a)}
			aria-label={hint(a)}
			title={hint(a)}
			on:click={() => onAction(a.id)}
		>
			<kbd class="key">{a.key}</kbd>
			<span class="label">{a.label}</span>
		</button>
	{/each}
</div>
