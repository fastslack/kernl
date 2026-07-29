/**
 * Licensed-store HTTP client.
 *
 * Talks to the Kernl download store (default https://issuer.lifekernl.com):
 *   • GET /store/catalog          — what paid extensions exist
 *   • GET /store/download?slug=…  — the signed .kernlext, gated by the license
 *                                   JWT sent as `Authorization: Bearer …`
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
}

type FetchLike = typeof fetch;

function base(storeUrl: string): string {
  return storeUrl.replace(/\/+$/, "");
}

export async function fetchStoreCatalog(storeUrl: string, fetchImpl: FetchLike = fetch): Promise<StoreCatalogItem[]> {
  const res = await fetchImpl(`${base(storeUrl)}/store/catalog`);
  if (!res.ok) throw new Error(`store catalog request failed: HTTP ${res.status}`);
  const data = (await res.json()) as { items?: StoreCatalogItem[] };
  return Array.isArray(data.items) ? data.items : [];
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
