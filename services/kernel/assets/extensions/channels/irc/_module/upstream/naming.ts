/**
 * Translation between upstream targets and the local buffers that mirror them.
 *
 * The protocol requires a channel name to start with '#' (or '&'), so the
 * network cannot be a prefix: `dalnet/#argentina` is not a name any client can
 * JOIN. The suffix form is used instead, which is also what soju does:
 *
 *   dalnet  + #argentina  ->  #argentina/dalnet
 *   dalnet  + Pepe        ->  Pepe/dalnet          (a query)
 *
 * Upstream channel names may themselves contain '/', so parsing always splits
 * on the LAST separator.
 */

export const NETWORK_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export interface LocalTarget {
  network: string;
  /** Target as the upstream network knows it, prefix included. */
  target: string;
  isChannel: boolean;
}

/** True if `slug` is usable as a network suffix. */
export function isNetworkSlug(slug: string): boolean {
  return NETWORK_SLUG.test(slug);
}

/** Normalise arbitrary user input into a network slug ("DALnet" -> "dalnet"). */
export function toNetworkSlug(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

/** Map an upstream target to its local buffer name. Empty string if invalid. */
export function toLocalTarget(network: string, target: string): string {
  if (!isNetworkSlug(network) || !target) return "";
  return `${target}/${network}`;
}

/**
 * Parse a local buffer name back into its upstream parts, or null when the
 * name is a native Kernl target (no network suffix).
 */
export function parseLocalTarget(local: string): LocalTarget | null {
  if (!local) return null;
  const cut = local.lastIndexOf("/");
  if (cut <= 0 || cut === local.length - 1) return null;
  const network = local.slice(cut + 1);
  const target = local.slice(0, cut);
  if (!isNetworkSlug(network) || !target) return null;
  // A bare prefix ("#/dalnet") is not a channel anyone can be in.
  if ((target === "#" || target === "&") ) return null;
  return { network, target, isChannel: isChannelName(target) };
}

/** True for a target the upstream treats as a channel rather than a nick. */
export function isChannelName(target: string): boolean {
  return target.startsWith("#") || target.startsWith("&");
}

/**
 * Local nick shown for an upstream user. Nicks are namespaced the same way so
 * two networks can both have a "Pepe" without colliding in the local server.
 */
export function toLocalNick(network: string, nick: string): string {
  if (!isNetworkSlug(network) || !nick) return "";
  return `${nick}/${network}`;
}
