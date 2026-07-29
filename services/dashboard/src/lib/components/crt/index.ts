/**
 * CRT primitives — reusable layout/UI building blocks for the
 * hacker-terminal aesthetic. They consume theme variables (--bg,
 * --gold, --text-1, etc.) so they reskin automatically when the user
 * activates a different theme.
 *
 * Pair with `import "$lib/styles/crt.css"` once at the page level (or
 * in +layout.svelte) to get the shared keyframes/utilities.
 */

export { default as CrtShell } from "./CrtShell.svelte";
export { default as CrtTopbar } from "./CrtTopbar.svelte";
export { default as CrtPanel } from "./CrtPanel.svelte";
export { default as CrtBreadcrumb } from "./CrtBreadcrumb.svelte";
export { default as CrtRow } from "./CrtRow.svelte";
export { default as CrtButton } from "./CrtButton.svelte";
export { default as CrtToolbar } from "./CrtToolbar.svelte";
export { default as CrtBootLines } from "./CrtBootLines.svelte";
