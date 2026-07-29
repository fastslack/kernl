/**
 * Registry of 3D agent-panel tabs contributed by extensions.
 *
 * WHICH tab / WHERE it appears travels declaratively in each extension's
 * manifest (`agentPanelTabs: [{ id, label, match, order }]`, exposed by
 * /api/manifest). Here we bind that `id` → the Svelte component that renders
 * it, because the components must be compiled into the dashboard bundle.
 *
 * For an extension to add a tab: (1) declare it in its extension.json /
 * descriptor with an `id`, and (2) register that `id` → its component here. That's all.
 */
export const panelTabComponents: Record<string, any> = {};

/** Does this contributed tab apply to the selected office/agent? */
export function tabMatches(tab: { match?: { office?: string } }, flow: { name?: string } | null): boolean {
  if (!tab.match || !tab.match.office) return true; // no match rule = every panel
  return !!flow && tab.match.office === flow.name;
}
