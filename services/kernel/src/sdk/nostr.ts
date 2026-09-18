/**
 * @kernl/extension-sdk/nostr — Nostr identity and relay pool.
 *
 * Kept off the main entry for the same reason as `./html`: nostr-tools and the
 * @noble curves are ~85 KB that every lazily-loaded extension part would carry
 * if they sat on the barrel.
 */

export * from "./nostr-identity.js";
export * from "./nostr-relay-pool.js";
