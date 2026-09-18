<script lang="ts" context="module">
	export type IconName =
		| 'plus' | 'users' | 'activity' | 'eye' | 'help' | 'search' | 'lock' | 'inbox' | 'star'
		| 'chev-r' | 'chev-d' | 'pencil' | 'x' | 'play' | 'check' | 'spark' | 'fit' | 'minus'
		| 'branch' | 'trash' | 'download' | 'info' | 'alert' | 'panel' | 'shield' | 'more' | 'move';

	// One-stroke, 24px grid. Keep in step with the mockup (spec §6).
	const PATHS: Record<IconName, string> = {
		plus: '<path d="M12 5v14M5 12h14"/>',
		users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
		activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
		eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
		help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
		search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
		lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
		inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/>',
		star: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9Z"/>',
		'chev-r': '<path d="m9 18 6-6-6-6"/>',
		'chev-d': '<path d="m6 9 6 6 6-6"/>',
		pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
		x: '<path d="M18 6 6 18M6 6l12 12"/>',
		play: '<path d="M7 4v16l13-8Z"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		spark: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2Z"/>',
		fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
		minus: '<path d="M5 12h14"/>',
		branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
		trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
		download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
		info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
		alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4M12 17h.01"/>',
		panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
		shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
		more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
		move: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
	};
</script>

<script lang="ts">
	export let name: IconName;
	export let size = 16;
	/** Accessible name. Empty means decorative. */
	export let label = '';
	export let filled = false;
</script>

<svg
	class="k-svg-icon"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill={filled ? 'currentColor' : 'none'}
	stroke={filled ? 'none' : 'currentColor'}
	stroke-width="1.75"
	stroke-linecap="round"
	stroke-linejoin="round"
	role={label ? 'img' : undefined}
	aria-label={label || undefined}
	aria-hidden={label ? undefined : 'true'}
>{@html PATHS[name]}</svg>

<style>
	.k-svg-icon { flex: none; display: block; }
</style>
