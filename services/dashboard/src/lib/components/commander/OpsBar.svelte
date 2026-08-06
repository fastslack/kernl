<script lang="ts">
	export let onAction: (id: string) => void;
	/** Number of entries the F-keys would act on; gates the destructive ones. */
	export let targetCount = 0;
	/** True when the cursor sits on a file (View/Edit only make sense then). */
	export let hasFileCursor = false;
	/** True when any entry is under the cursor — rename works on dirs too. */
	export let hasCursor = false;
	/** False when the active pane's directory is read-only. */
	export let activeWritable = true;
	/** False when the *other* pane — the copy/move destination — is read-only. */
	export let passiveWritable = true;

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
		/** Disabled unless some entry is under the cursor. */
		needsCursor?: boolean;
		/** Writes into the active pane — blocked when it is read-only. */
		writesHere?: boolean;
		/** Writes into the other pane — blocked when *that* one is read-only. */
		writesThere?: boolean;
	}

	const actions: Action[] = [
		{ key: 'F2', id: 'rename', label: 'Rename', needsCursor: true, writesHere: true },
		{ key: 'F3', id: 'view', label: 'View', needsFile: true },
		{ key: 'F4', id: 'edit', label: 'Edit', needsFile: true, writesHere: true },
		{ key: 'F5', id: 'copy', label: 'Copy', needsTarget: true, writesThere: true },
		// Move deletes from the source too, so it needs both sides writable.
		{ key: 'F6', id: 'move', label: 'Move', needsTarget: true, writesHere: true, writesThere: true },
		{ key: 'F7', id: 'mkdir', label: 'New folder', writesHere: true },
		{ key: 'F8', id: 'delete', label: 'Delete', danger: true, needsTarget: true, writesHere: true },
		{ key: '⌃B', id: 'bookmark', label: 'Bookmark' },
		{ key: '⌃T', id: 'new-tab', label: 'New tab' },
		{ key: '⌃R', id: 'remotes', label: 'Remotes' },
		{ key: '⌃H', id: 'history', label: 'History' },
		{ key: ':', id: 'cmd', label: 'Command' }
	];

	function disabled(a: Action): boolean {
		if (a.writesHere && !activeWritable) return true;
		if (a.writesThere && !passiveWritable) return true;
		if (a.needsFile) return !hasFileCursor;
		if (a.needsCursor) return !hasCursor;
		if (a.needsTarget) return targetCount === 0;
		return false;
	}

	function hint(a: Action): string {
		// Read-only reasons come first: they explain a block the user cannot
		// resolve by selecting something, which every other hint implies.
		if (a.writesHere && !activeWritable) return `${a.label} — this location is read-only`;
		if (a.writesThere && !passiveWritable) return `${a.label} — the other pane is read-only`;
		if (a.needsFile && !hasFileCursor) return `${a.label} — select a file first`;
		if (a.needsCursor && !hasCursor) return `${a.label} — no entry under the cursor`;
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
