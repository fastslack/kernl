/**
 * Licensed-store HTTP client.
 *
 * Talks to the Kernl download store (default https://issuer.lifekernl.com):
 *   • GET  /store/catalog             — what paid extensions exist, with prices
 *   • GET  /store/download?slug=…     — the signed .kernlext, gated by the license
 *                                       JWT sent as `Authorization: Bearer …`
 *   • POST /api/checkout/create       — open a Stripe Checkout for a price
 *   • GET  /api/license/by-session    — claim the license a checkout minted
 *
 * Pure over an injectable `fetch` so it's unit-testable without a network.
 */

import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface StoreCatalogItem {
  slug: string;
  name: string;
  feature: string; // pro:<slug>
  version: string;
  /** "extension" (.kernlext) or "office" (blueprint JSON). Default extension. */
  type?: "extension" | "office";
  /** Card copy — the kernel has no local manifest until the item is installed. */
  description?: string;
  icon?: string;
  category?: string;
  /** ExtensionManifest.type this item installs as. Default "module". */
  ext_type?: string;
  /** Stripe price ID to open a checkout with. Null when not for sale yet. */
  price_id?: string | null;
  /** Amount in cents. Null when the store couldn't resolve it from Stripe. */
  price_cents?: number | null;
  currency?: string;
  kind?: "one_time" | "subscription";
}

/** The All-Access upsell block returned alongside the catalog. */
export interface StoreAllAccess {
  monthly: { price_id: string; price_cents: number | null; currency: string; interval: string | null } | null;
  yearly: { price_id: string; price_cents: number | null; currency: string; interval: string | null } | null;
}

export interface StoreCatalog {
  items: StoreCatalogItem[];
  allAccess: StoreAllAccess | null;
}

type FetchLike = typeof fetch;

function base(storeUrl: string): string {
  return storeUrl.replace(/\/+$/, "");
}

export async function fetchStoreCatalog(storeUrl: string, fetchImpl: FetchLike = fetch): Promise<StoreCatalogItem[]> {
  return (await fetchStoreCatalogFull(storeUrl, fetchImpl)).items;
}

/** Same request as `fetchStoreCatalog`, keeping the All-Access block. */
export async function fetchStoreCatalogFull(
  storeUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<StoreCatalog> {
  const res = await fetchImpl(`${base(storeUrl)}/store/catalog`);
  if (!res.ok) throw new Error(`store catalog request failed: HTTP ${res.status}`);
  const data = (await res.json()) as { items?: StoreCatalogItem[]; all_access?: StoreAllAccess };
  return {
    items: Array.isArray(data.items) ? data.items : [],
    allAccess: data.all_access ?? null,
  };
}

/**
 * Open a Stripe Checkout session for `priceId`. Returns the hosted URL the user
 * completes payment on, plus the session id — which is what we later exchange
 * for the license via `fetchLicenseBySession`.
 */
export async function createStoreCheckout(args: {
  storeUrl: string;
  priceId: string;
  email?: string;
  fetchImpl?: FetchLike;
}): Promise<{ id: string; url: string }> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base(args.storeUrl)}/api/checkout/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ price_id: args.priceId, ...(args.email ? { email: args.email } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `checkout creation failed: HTTP ${res.status}`);
  if (!body.id || !body.url) throw new Error("store returned no checkout session");
  return { id: body.id, url: body.url };
}

export interface SessionLicense {
  state: "ready";
  sku: string;
  features: string[];
  /** The features this particular purchase granted. */
  granted_features: string[];
  expires_at: number;
  jwt: string;
}

/**
 * Ask the store for the license minted by a completed checkout.
 *
 * Returns null while the purchase is still pending (Stripe hasn't fired the
 * webhook yet, or the user hasn't paid) — that's the normal case for the first
 * few polls, not an error. Throws only on a genuine failure.
 */
export async function fetchLicenseBySession(args: {
  storeUrl: string;
  sessionId: string;
  fetchImpl?: FetchLike;
}): Promise<SessionLicense | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = `${base(args.storeUrl)}/api/license/by-session?session_id=${encodeURIComponent(args.sessionId)}`;
  const res = await fetchImpl(url);
  if (res.status === 404) return null; // still pending
  const body = (await res.json().catch(() => ({}))) as Partial<SessionLicense> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `license lookup failed: HTTP ${res.status}`);
  if (!body.jwt) throw new Error("store returned no license");
  return body as SessionLicense;
}

/** Authenticated GET against the store's download endpoint. Throws the store's
 *  own error message on 401/403/404. Shared by the bundle + text downloaders. */
async function storeGet(args: { storeUrl: string; slug: string; licenseJwt: string; fetchImpl: FetchLike }): Promise<Response> {
  const url = `${base(args.storeUrl)}/store/download?slug=${encodeURIComponent(args.slug)}`;
  const res = await args.fetchImpl(url, { headers: { Authorization: `Bearer ${args.licenseJwt}` } });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  return res;
}

/** Download an office blueprint (JSON) as text, authenticated with the license. */
export async function downloadStoreText(args: {
  storeUrl: string;
  slug: string;
  licenseJwt: string;
  fetchImpl?: FetchLike;
}): Promise<string> {
  const res = await storeGet({ ...args, fetchImpl: args.fetchImpl ?? fetch });
  return res.text();
}

export interface DownloadedBundle {
  path: string;
  bytes: number;
  downloadUrl: string;
}

/**
 * Download a bundle for `slug`, authenticating with the license JWT. Writes it
 * to a fresh temp file and returns the path. Throws with the store's own error
 * message on 401 (no/invalid license) or 403 (license lacks the feature).
 */
export async function downloadStoreBundle(args: {
  storeUrl: string;
  slug: string;
  licenseJwt: string;
  fetchImpl?: FetchLike;
}): Promise<DownloadedBundle> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const downloadUrl = `${base(args.storeUrl)}/store/download?slug=${encodeURIComponent(args.slug)}`;
  const res = await storeGet({ storeUrl: args.storeUrl, slug: args.slug, licenseJwt: args.licenseJwt, fetchImpl });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const dir = await mkdtemp(join(tmpdir(), "kernl-store-"));
  const path = join(dir, `${args.slug}.kernlext`);
  await writeFile(path, bytes);
  return { path, bytes: bytes.byteLength, downloadUrl };
}
