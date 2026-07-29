/**
 * Per-install receipts — local install proof + optional remote watermark.
 *
 * Every install (bundled, local, file, url, git, marketplace) generates a
 * receipt that's signed by the installing kernel's Ed25519 attestation
 * identity. Receipts persist in installed_extensions.install_receipt_json.
 *
 * Two flavors compose:
 *   - local:           always present. Signed by the installing kernel.
 *   - remote_watermark: present when downloaded via a watermarking provider.
 *                       Signed by the source kernel (or marketplace server).
 *
 * Why both:
 *   - local proves to a third party "this kernel installed this exact bundle
 *     at this time" — useful for forensic audit if the bundle later misbehaves.
 *   - watermark proves to the source "this exact download came from us, was
 *     handed to that downloader at that time" — useful for distribution
 *     forensics if a leaked bundle shows up.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { Identity } from "../../core/attestation.js";
import type { ExtensionSource } from "./types.js";

// ── Wire shapes ───────────────────────────────────────────────────────

export interface RemoteWatermark {
  /** UUID v4 issued by the serving side, unique per download event. */
  download_id: string;
  /** Identity fingerprint of the downloader (recipient kernel). */
  downloader_fp: string;
  /** Identity fingerprint of the source (serving kernel / marketplace server). */
  source_fp: string;
  /** ISO8601 timestamp of the download event. */
  ts: string;
  /**
   * Base64 Ed25519 signature by the SOURCE over
   * `download_id || downloader_fp || source_fp || ts`.
   */
  signature: string;
}

export interface InstallReceipt {
  /** Schema version. Bump when fields are added. */
  v: 1;
  /** UUID v4 — globally unique per install event. */
  install_id: string;
  /** Hex sha256 of the install_path tree (every file, sorted by relative path,
   *  excluding extension.json which contains its own integrity hash). */
  bundle_sha256: string;
  /** Hex sha256(install_id || bundle_sha256 || installed_at || identity_fp). */
  install_sha256: string;
  /** ISO8601 timestamp of the install event. */
  installed_at: string;
  /** Ed25519 fingerprint of the installing kernel. */
  kernel_identity: string;
  /** Base64 Ed25519 signature by the INSTALLING kernel over install_sha256. */
  signature: string;
  /** Where the bundle came from. Mirrors installed_extensions.source_json. */
  source: ExtensionSource;
  /** Server-side watermark when downloaded via a watermarking provider. */
  remote_watermark: RemoteWatermark | null;
}

// ── Hashers ────────────────────────────────────────────────────────────

/**
 * Canonical sha256 of a directory tree. Same algorithm as
 * extensions/bundle.ts:computeBundleSha256 but lives here too because the
 * receipt module can't depend on bundle.ts (which imports tar). Excludes
 * extension.json so the hash matches manifest.integrity.sha256 when present.
 */
export async function computeInstallPathSha256(installPath: string): Promise<string> {
  if (!existsSync(installPath)) return sha256Hex(Buffer.from(""));
  const files = await listFilesSorted(installPath);
  const digest = createHash("sha256");
  for (const rel of files) {
    if (rel === "extension.json") continue;
    const buf = await readFile(join(installPath, rel));
    const fileHash = sha256Hex(buf);
    digest.update(`${rel}\0${fileHash}\n`);
  }
  return digest.digest("hex");
}

async function listFilesSorted(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string): Promise<void> => {
    let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[] = [];
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = join(abs, e.name);
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) out.push(relative(root, child).split(sep).join("/"));
    }
  };
  // Guard against pathological inputs (root is a file, etc.)
  try {
    const st = await stat(root);
    if (st.isFile()) return [];
  } catch {
    return [];
  }
  await walk(root);
  out.sort();
  return out;
}

function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ── Builders ──────────────────────────────────────────────────────────

export interface BuildReceiptArgs {
  installedAt: string;
  bundleSha256: string;
  source: ExtensionSource;
  identity: Identity | null;
  remoteWatermark?: RemoteWatermark | null;
}

/**
 * Build + sign a per-install receipt. When `identity` is null (tests, minimal
 * deployments) the receipt is unsigned — kernel_identity reads "unsigned" and
 * signature is empty. Verification clients can reject unsigned receipts based
 * on policy.
 */
export function buildInstallReceipt(args: BuildReceiptArgs): InstallReceipt {
  const installId = randomUUID();
  const identityFp = args.identity?.serverId() ?? "unsigned";
  const installSha = sha256Hex(
    Buffer.from(`${installId}|${args.bundleSha256}|${args.installedAt}|${identityFp}`, "utf-8"),
  );
  const signature = args.identity
    ? Buffer.from(args.identity.signBytes(Buffer.from(installSha, "hex"))).toString("base64")
    : "";
  return {
    v: 1,
    install_id: installId,
    bundle_sha256: args.bundleSha256,
    install_sha256: installSha,
    installed_at: args.installedAt,
    kernel_identity: identityFp,
    signature,
    source: args.source,
    remote_watermark: args.remoteWatermark ?? null,
  };
}

// ── Watermark builders (server-side, used by the catalog download endpoint) ──

export interface BuildWatermarkArgs {
  downloaderFp: string;
  source: Identity;
}

/**
 * Build + sign a download watermark on the SERVING side. The downloader passes
 * its identity fingerprint in the request; the server stamps a UUID + ts and
 * signs. The downloader merges this into its install receipt.
 */
export function buildDownloadWatermark(args: BuildWatermarkArgs): RemoteWatermark {
  const download_id = randomUUID();
  const ts = new Date().toISOString();
  const source_fp = args.source.serverId();
  const payload = Buffer.from(
    `${download_id}|${args.downloaderFp}|${source_fp}|${ts}`,
    "utf-8",
  );
  const signature = Buffer.from(args.source.signBytes(payload)).toString("base64");
  return { download_id, downloader_fp: args.downloaderFp, source_fp, ts, signature };
}
