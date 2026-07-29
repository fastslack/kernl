/**
 * Page → WebSocket channel mapping.
 * Defines which channels each page needs subscribed.
 * The layout subscribes/unsubscribes channels on navigation.
 */

export const PAGE_CHANNELS: Record<string, string[]> = {
  // Always subscribed (via layout)
  '/': ['dashboard', 'life', 'agents'],

  // Home needs everything for the overview
  '/home': ['dashboard', 'life', 'comms', 'house', 'finance', 'health', 'analytics', 'agents', 'calendar', 'agenda'],

  // People
  '/crm': ['dashboard', 'analytics', 'comms'],
  '/comms': ['comms'],

  // Work
  '/tasks': ['dashboard'],
  '/issues': ['issues'],
  '/planner': ['dashboard', 'calendar'],
  '/automations': ['calendar', 'systemAgenda', 'agenda'],

  // Finance
  '/finance': ['finance', 'dashboard'],

  // Wellness
  '/wellness': ['health', 'training', 'nutrition'],
  '/health': ['health'],
  '/training': ['training'],

  // Content
  '/news': ['dashboard'],
  '/life': ['life'],
  '/files': ['dashboard'],
  '/notes': ['notes'],

  // System
  '/agents': ['agents'],
  '/agents-flow': ['agents.flow', 'agents'],
  '/architecture': ['agents.flow'],
  '/house': ['house'],
};

/** Get channels for a given path */
export function getChannelsForPage(path: string): string[] {
  // Exact match
  if (PAGE_CHANNELS[path]) return PAGE_CHANNELS[path];
  // Prefix match (e.g. /comms/campaign/123 → /comms)
  for (const [prefix, channels] of Object.entries(PAGE_CHANNELS)) {
    if (path.startsWith(prefix + '/')) return channels;
  }
  // Default: dashboard
  return ['dashboard'];
}
