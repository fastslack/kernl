<script lang="ts">
	export let onAction: (id: string) => void;

	const actions: Array<{ key: string; id: string; label: string }> = [
		{ key: 'F3', id: 'view', label: 'View' },
		{ key: 'F4', id: 'edit', label: 'Edit' },
		{ key: 'F5', id: 'copy', label: 'Copy' },
		{ key: 'F6', id: 'move', label: 'Move' },
		{ key: 'F7', id: 'mkdir', label: 'MkDir' },
		{ key: 'F8', id: 'delete', label: 'Delete' },
		{ key: 'Ctrl+B', id: 'bookmark', label: 'Bookmark' },
		{ key: 'Ctrl+T', id: 'new-tab', label: 'New Tab' },
		{ key: 'Ctrl+R', id: 'remotes', label: 'Remotes' },
		{ key: ':', id: 'cmd', label: 'Command' }
	];
</script>

<div class="cmd-opsbar">
	{#each actions as a}
		<button class="fkey" on:click={() => onAction(a.id)} title={a.label}>
			<span class="key">{a.key}</span>
			<span>{a.label}</span>
		</button>
	{/each}
</div>
