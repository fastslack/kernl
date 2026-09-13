/**
 * RemoteProvider — fetches a catalog from a remote kernel/marketplace and
 * downloads watermarked .kernl bundles via /api/marketplace/catalog/download.
 *
 * Wire model:
 *   - GET  {baseUrl}/api/marketplace/catalog?... → list of CatalogItem JSON
 *   - GET  {baseUrl}/api/marketplace/catalog/item/:slug → single CatalogItem
 *   - GET  {baseUrl}/api/marketplace/catalog/download/:slug?downloader_fp=fp
 *           → application/x-kernl+gzip + X-MTW-Watermark header (base64 JSON)
 *
 * Discovered items get `origin.directory` cleared (the source isn't local) and
 * gain a synthetic `origin.directory` only AFTER the consumer has invoked
 * downloadBundle(). The CatalogRegistry's install() path reads a fresh
 * download every time install is called (no on-disk cache).
 */

import { writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { log } from "../../../core/logger.js";
import { guardedFetch } from "../../../core/url-guard.js";
import type {
  CatalogFilter,
  CatalogItem,
  CatalogProvider,
} from "./types.js";
import type { RemoteWatermark } from "../../extensions/receipt.js";
import { bundleFileName } from "../../extensions/bundle.js";

export interface RemoteProviderOptions {
  /** Stable id for this provider (e.g. "remote:purma.community"). */
  name: string;
  /** Human-readable label for the dashboard. */
  label: string;
  /** Base URL (no trailing slash) of the remote kernel/marketplace. */
  baseUrl: string;
  /** Bearer token for the remote kernel's HTTP API. */
  bearerToken?: string;
  /** Local kernel's identity fingerprint — sent as `downloader_fp` so the
   *  remote can sign a watermark bound to us. */
  downloaderFp: string;
}

export interface DownloadedBundle {
  /** Path to the .kernl on disk (caller is responsible for cleanup). */
  bundlePath: string;
  /** Watermark issued by the remote. The CatalogRegistry forwards this into
   *  installFromBundle(opts.remoteWatermark) so it lands in the install receipt. */
  watermark: RemoteWatermark | null;
  /** SHA256 of the watermarked bundle reported by the server (X-MTW-Bundle-Sha256). */
  bundleSha256: string | null;
}

export class RemoteProvider implements CatalogProvider {
  readonly name: string;
  readonly label: string;

  constructor(private readonly opts: RemoteProviderOptions) {
    this.name = opts.name;
    this.label = opts.label;
  }

  async list(filter?: CatalogFilter): Promise<CatalogItem[]> {
    const url = new URL("/api/marketplace/catalog", this.opts.baseUrl);
    if (filter?.type) url.searchParams.set("type", filter.type);
    if (filter?.category) url.searchParams.set("category", filter.category);
    if (filter?.query) url.searchParams.set("q", filter.query);
    if (filter?.limit) url.searchParams.set("limit", String(filter.limit));

    const data = await this.fetchJson<{ items: CatalogItem[] }>(url.toString());
    if (!data || !Array.isArray(data.items)) return [];
    // Mark every item with our provider so the dashboard can group by source.
    return data.items.map((i) => ({
      ...i,
      origin: { ...i.origin, provider: this.name, directory: undefined },
    }));
  }

  async get(idOrSlug: string): Promise<CatalogItem | null> {
    const url = new URL(
      `/api/marketplace/catalog/item/${encodeURIComponent(idOrSlug)}`,
      this.opts.baseUrl,
    );
    const data = await this.fetchJson<{ item: CatalogItem }>(url.toString());
    if (!data || !data.item) return null;
    return {
      ...data.item,
      origin: { ...data.item.origin, provider: this.name, directory: undefined },
    };
  }

  /**
   * Download a single bundle, persisting it to a freshly-created temp file.
   * The caller MUST clean up the file (or the parent dir) after use.
   * Returns the watermark from the X-MTW-Watermark header so it can be folded
   * into the install receipt.
   */
  async downloadBundle(slug: string): Promise<DownloadedBundle> {
    const url = new URL(
      `/api/marketplace/catalog/download/${encodeURIComponent(slug)}`,
      this.opts.baseUrl,
    );
    url.searchParams.set("downloader_fp", this.opts.downloaderFp);

    const headers: Record<string, string> = {};
    if (this.opts.bearerToken) headers.Authorization = `Bearer ${this.opts.bearerToken}`;

    const res = await guardedFetch(url.toString(), { headers });
    if (!res.ok) {
      throw new Error(`RemoteProvider ${this.name}: download ${slug} failed: HTTP ${res.status}`);
    }

    const watermarkB64 = res.headers.get("x-mtw-watermark");
    const bundleSha256 = res.headers.get("x-mtw-bundle-sha256");
    let watermark: RemoteWatermark | null = null;
    if (watermarkB64) {
      try {
        watermark = JSON.parse(Buffer.from(watermarkB64, "base64").toString("utf-8")) as RemoteWatermark;
      } catch (err) {
        log.warn(`RemoteProvider ${this.name}: failed to parse watermark header: ${err}`);
      }
    }

    const stagingDir = join(tmpdir(), `mtw-remote-dl-${randomBytes(4).toString("hex")}`);
    await mkdir(stagingDir, { recursive: true });
    const bundlePath = join(stagingDir, bundleFileName(slug));
    const bytes = new Uint8Array(await res.arrayBuffer());
    await writeFile(bundlePath, bytes);

    return { bundlePath, watermark, bundleSha256 };
  }

  /** Best-effort cleanup of the directory holding a downloaded bundle. */
  static async cleanupBundle(bundlePath: string): Promise<void> {
    try {
      const dir = dirname(bundlePath);
      if (dir.startsWith(tmpdir())) {
        await rm(dir, { recursive: true, force: true });
      }
    } catch {
      // best-effort
    }
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async fetchJson<T>(url: string): Promise<T | null> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.opts.bearerToken) headers.Authorization = `Bearer ${this.opts.bearerToken}`;
    try {
      const res = await guardedFetch(url, { headers });
      if (!res.ok) {
        log.warn(`RemoteProvider ${this.name}: ${url} → HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      log.warn(`RemoteProvider ${this.name}: fetch ${url} failed: ${err}`);
      return null;
    }
  }
}
