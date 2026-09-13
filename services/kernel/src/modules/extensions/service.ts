/**
 * ExtensionService — CRUD + lifecycle for installed_extensions.
 *
 * Install/uninstall orchestration delegates to type-specific handlers in
 * installer.ts. This service owns the DB and the on-disk layout (one
 * directory per extension under config.dataPath/extensions/{slug}/).
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpSync, existsSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { Identity } from "../../core/attestation.js";
import { newId, isoNow } from "../../core/helpers.js";
import { isNewer } from "../../core/semver.js";
import { log } from "../../core/logger.js";
import { isPathInside, renameWithRetry } from "../../core/fs-paths.js";
import type {
  ExtensionSource,
  ExtensionStatus,
  ExtensionType,
  InstalledExtension,
} from "./types.js";
import type { ExtensionManifest } from "./schema.js";
import { peekManifest, unpackBundle } from "./bundle.js";
import { ensureExtensionPackages, needsPackageInstall } from "./ensure-packages.js";
import { verifyBundleSignature } from "./bundle-signature.js";
import {
  checkBundleAuthenticity,
  activationStatus,
  isPaidExtension,
  requiredFeature,
} from "./entitlement.js";
import {
  dispatchInstall,
  dispatchUninstall,
  installComposableExtras,
  type InstallerDeps,
} from "./installer.js";
import {
  buildInstallReceipt,
  computeInstallPathSha256,
  type InstallReceipt,
  type RemoteWatermark,
} from "./receipt.js";

export interface ExtensionServiceOptions {
  /** Root directory where extensions are extracted, e.g. data/extensions. */
  extensionsDir: string;
  /** Dependencies passed through to type-specific installer handlers. */
  installerDeps: InstallerDeps;
  /** Kernel attestation identity used to sign install receipts. Optional —
   *  when null, receipts are stored unsigned (kernel_identity='unsigned'). */
  identity?: Identity | null;
  /** Whether the kernel holds a given license feature (e.g. `pro:trading`).
   *  Defaults to always-false, so paid extensions install but stay inactive. */
  licenseHas?: (feature: string) => boolean;
  /** RS256 bundle-signature verifier. Injected in tests; defaults to the real
   *  check against the embedded LICENSE_PUBLIC_KEY. */
  verifyBundleSig?: (sha256Hex: string, signatureB64: string) => Promise<boolean>;
  /** Platform whose file-locking rules apply. Injected in tests. */
  platform?: NodeJS.Platform;
  /** Directory move used for swaps and trash. Injected in tests to simulate a
   *  Windows lock; defaults to `renameWithRetry`. */
  renameDir?: (from: string, to: string) => Promise<void>;
  /** Recursive delete. Injected in tests; defaults to `rm -rf`. */
  removeDir?: (dir: string) => Promise<void>;
}

/** Error codes Windows returns while a file in the folder is open or mapped. */
const LOCK_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

function isLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return !!code && LOCK_CODES.has(code);
}

/** Thrown by a second update of the same extension while the first runs. */
export class ExtensionBusyError extends Error {
  constructor(slug: string) {
    super(`An install or update of ${slug} is already running — try again when it finishes.`);
    this.name = "ExtensionBusyError";
  }
}

export class ExtensionService {
  constructor(
    private readonly db: SqliteDb,
    private opts: ExtensionServiceOptions,
  ) {}

  /**
   * Upgrade installer dependencies after construction. Used when dependent
   * subsystems (skillRegistry, agentsFacade) come online AFTER this service
   * was already initialized by the module-registry batch.
   */
  setInstallerDeps(deps: InstallerDeps): void {
    this.opts = { ...this.opts, installerDeps: deps };
  }

  /** Late-bind the attestation identity for receipt signing. */
  setIdentity(identity: Identity | null): void {
    this.opts = { ...this.opts, identity };
  }

  /** Public so /api/extensions can tell the UI *why* a paid row is inactive. */
  hasLicense(feature: string): boolean {
    return this.opts.licenseHas?.(feature) ?? false;
  }

  /** Writable root where extensions are materialized — `<data>/extensions`. */
  get extensionsDir(): string {
    return this.opts.extensionsDir;
  }

  private verifySignature(sha256Hex: string, signatureB64: string): Promise<boolean> {
    return (this.opts.verifyBundleSig ?? verifyBundleSignature)(sha256Hex, signatureB64);
  }

  // ── Folder swaps that survive Windows locks ─────────────────────────

  /** Slugs with an install or update in flight — see `withSlugLock`. */
  private readonly busy = new Set<string>();

  private get platform(): NodeJS.Platform {
    return this.opts.platform ?? process.platform;
  }

  private moveDir(from: string, to: string): Promise<void> {
    return this.opts.renameDir
      ? this.opts.renameDir(from, to)
      : renameWithRetry(from, to, { platform: this.platform });
  }

  private deleteDir(dir: string): Promise<void> {
    return this.opts.removeDir
      ? this.opts.removeDir(dir)
      : rm(dir, { recursive: true, force: true });
  }

  /**
   * Run `fn` holding the slug's lock. The store cron, the store's update
   * button and kernel_extensions_update all end here; two of them swapping the
   * same folder at once is how a backup gets restored over a finished update.
   */
  private async withSlugLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(slug)) throw new ExtensionBusyError(slug);
    this.busy.add(slug);
    try {
      return await fn();
    } finally {
      this.busy.delete(slug);
    }
  }

  /** `<extensionsDir>/.trash` — folders that could not be deleted in place. */
  private get trashDir(): string {
    return join(this.opts.extensionsDir, ".trash");
  }

  /**
   * Move `from` to `to`. Windows will not rename a folder while a file in it
   * is open or mapped, so on a lock the module holding it is shut down and the
   * move tried once more. Returns false when it still cannot move — win32 only;
   * POSIX has no such lock, so a failure there is a real error and throws.
   */
  private async tryMoveDir(from: string, to: string, slug: string): Promise<boolean> {
    try {
      await this.moveDir(from, to);
      return true;
    } catch (err) {
      if (this.platform !== "win32" || !isLockError(err)) throw err;
    }
    await this.opts.installerDeps.moduleRegistry?.unregisterModule(`ext:${slug}`).catch(() => false);
    try {
      await this.moveDir(from, to);
      return true;
    } catch (err) {
      if (!isLockError(err)) throw err;
      log.warn(`Extension ${slug}: ${from} is held by a running process — installing beside it`);
      return false;
    }
  }

  /**
   * A folder for a new copy of `slug` that nothing else uses — for when the
   * usual `<extensionsDir>/<slug>` is still held by the process.
   */
  private sideDir(slug: string, version: string): string {
    const safeVersion = version.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(this.opts.extensionsDir, `${slug}@${safeVersion}-${newId().slice(0, 8)}`);
  }

  /**
   * Delete a folder the extension no longer uses. When Windows refuses — a
   * native addon stays mapped until the process exits — move it into the
   * trash, or failing even that record it, so the next boot's purgeTrash()
   * finishes the job. Never throws: whatever it follows already succeeded.
   */
  private async discardDir(dir: string): Promise<void> {
    try {
      await this.deleteDir(dir);
      if (!existsSync(dir)) return;
    } catch (err) {
      log.warn(`Extensions: could not delete ${dir} now — ${err instanceof Error ? err.message : err}`);
    }
    try {
      await mkdir(this.trashDir, { recursive: true });
      await this.moveDir(dir, join(this.trashDir, `${basename(dir)}-${newId()}`));
      return;
    } catch { /* still held — record it below */ }
    try {
      const pending = await this.readPending();
      if (!pending.includes(dir)) pending.push(dir);
      await this.writePending(pending);
      log.warn(`Extensions: ${dir} is still in use — it will be removed on the next start`);
    } catch (err) {
      log.warn(`Extensions: could not schedule removal of ${dir} — ${err instanceof Error ? err.message : err}`);
    }
  }

  private async readPending(): Promise<string[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.trashDir, "pending.json"), "utf-8"));
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
    } catch {
      return [];
    }
  }

  private async writePending(list: string[]): Promise<void> {
    await mkdir(this.trashDir, { recursive: true });
    await writeFile(join(this.trashDir, "pending.json"), JSON.stringify(list, null, 2), "utf-8");
  }

  /**
   * Delete what discardDir() had to leave behind. Runs at boot, before any
   * extension loads, so nothing holds those folders any more. Only folders
   * inside the extensions dir that no installed row points at are touched.
   */
  async purgeTrash(): Promise<void> {
    if (!existsSync(this.trashDir)) return;
    let entries: string[] = [];
    try {
      entries = await readdir(this.trashDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "pending.json") continue;
      await this.deleteDir(join(this.trashDir, name)).catch(() => {});
    }
    const inUse = new Set(this.list().map((r) => r.install_path));
    const stillPending: string[] = [];
    for (const dir of await this.readPending()) {
      if (!isPathInside(this.opts.extensionsDir, dir, { allowRoot: false }) || inUse.has(dir)) continue;
      try {
        await this.deleteDir(dir);
        if (existsSync(dir)) stillPending.push(dir);
      } catch {
        stillPending.push(dir);
      }
    }
    await this.writePending(stillPending).catch(() => {});
  }

  // ── Reads ───────────────────────────────────────────────────────────

  list(filters?: { type?: ExtensionType; status?: ExtensionStatus }): InstalledExtension[] {
    const clauses: string[] = [];
    const params: Array<string> = [];
    if (filters?.type) {
      clauses.push("type = ?");
      params.push(filters.type);
    }
    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM installed_extensions ${where} ORDER BY installed_at DESC`,
      )
      .all(...params) as InstalledExtension[];
    return rows;
  }

  get(id: string): InstalledExtension | null {
    const row = this.db
      .prepare("SELECT * FROM installed_extensions WHERE id = ?")
      .get(id) as InstalledExtension | undefined;
    return row ?? null;
  }

  getBySlug(slug: string): InstalledExtension | null {
    const row = this.db
      .prepare("SELECT * FROM installed_extensions WHERE slug = ?")
      .get(slug) as InstalledExtension | undefined;
    return row ?? null;
  }

  parseManifest(row: InstalledExtension): ExtensionManifest {
    return JSON.parse(row.manifest_json) as ExtensionManifest;
  }

  // ── Install ─────────────────────────────────────────────────────────

  /**
   * Install from a .kernl bundle on disk. Orchestrates: peek manifest →
   * check conflicts → extract to dest dir → persist row → dispatch
   * type-specific handler. Any failure rolls back the extracted dir and
   * leaves the DB untouched.
   */
  async installFromBundle(
    bundlePath: string,
    source: ExtensionSource,
    opts?: { remoteWatermark?: RemoteWatermark | null },
  ): Promise<InstalledExtension> {
    const preview = await peekManifest(bundlePath);
    return this.withSlugLock(preview.slug, () => this.applyInstall(bundlePath, source, preview, opts));
  }

  private async applyInstall(
    bundlePath: string,
    source: ExtensionSource,
    preview: ExtensionManifest,
    opts?: { remoteWatermark?: RemoteWatermark | null },
  ): Promise<InstalledExtension> {
    const existing = this.get(preview.id) ?? this.getBySlug(preview.slug);
    if (existing) {
      throw new Error(
        `Extension already installed: id=${existing.id}, slug=${existing.slug}. ` +
          `Use update() to upgrade.`,
      );
    }

    let installPath = join(this.opts.extensionsDir, preview.slug);
    await mkdir(this.opts.extensionsDir, { recursive: true });

    // A folder with this name and no row is what an uninstall leaves when
    // Windows would not let go of it. Extracting over it would mix two
    // versions' files, so it is moved out of the way — or, still held, the
    // install goes beside it.
    if (existsSync(installPath)) {
      const aside = join(this.trashDir, `${preview.slug}-${newId()}`);
      await mkdir(this.trashDir, { recursive: true });
      if (await this.tryMoveDir(installPath, aside, preview.slug)) {
        await this.discardDir(aside);
      } else {
        installPath = this.sideDir(preview.slug, preview.version);
      }
    }

    const unpacked = await unpackBundle(bundlePath, installPath, true);
    const { manifest } = unpacked;

    // Authenticity: a signed bundle must verify against the embedded license
    // public key; a PAID bundle must carry a valid signature. Blocks tampered
    // or forged/pirated paid bundles before they touch the registry.
    const auth = await checkBundleAuthenticity(
      manifest,
      unpacked.computedSha256,
      (s, g) => this.verifySignature(s, g),
    );
    if (!auth.ok) {
      await rm(installPath, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Refusing to install ${manifest.slug}: ${auth.reason}`);
    }

    const now = isoNow();
    const row: InstalledExtension = {
      id: manifest.id,
      slug: manifest.slug,
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      status: "installed",
      manifest_json: JSON.stringify(manifest),
      source_json: JSON.stringify(source),
      install_path: installPath,
      granted_permissions_json: JSON.stringify(manifest.permissions ?? []),
      settings_json: "{}",
      error: "",
      installed_at: now,
      updated_at: now,
      last_loaded_at: null,
      install_receipt_json: "{}",
    };

    try {
      this.insertRow(row);
      await dispatchInstall(manifest, installPath, this.opts.installerDeps);
      const finalStatus = this.postInstallStatus(manifest, installPath);
      this.setStatus(row.id, finalStatus);
      row.status = finalStatus;
      await this.finalizeReceipt(row, source, opts?.remoteWatermark ?? null);
      return row;
    } catch (err) {
      await rm(installPath, { recursive: true, force: true }).catch(() => {});
      this.db.prepare("DELETE FROM installed_extensions WHERE id = ?").run(row.id);
      throw err;
    }
  }

  /**
   * Upgrade an already-installed extension from a newer .kernl bundle.
   * Mirrors installFromBundle's peek → auth → apply → receipt flow, but
   * operates on an EXISTING row instead of creating a new one, and preserves
   * user state (settings, id, installed_at) across the swap.
   *
   * Where the new copy goes:
   *   · a copy in the writable extensions dir is swapped in place — moved
   *     aside to a `.bak-<uuid>` sibling first;
   *   · a built-in extension still pointing at the shipped bundle (Program
   *     Files, /opt, inside a signed .app) is never written into: the update
   *     lands in `<extensionsDir>/<slug>` and the row follows it;
   *   · on Windows, a folder the running process will not release is left
   *     alone — the update installs beside it and the old folder is discarded
   *     (at the next start, at the latest).
   *
   * If unpack, authenticity, dispatchInstall or the receipt step throws, the
   * backup is restored (files + DB row, install_path included) and the error
   * re-thrown. Only one install/update per slug runs at a time; a second
   * caller gets ExtensionBusyError instead of racing the first.
   */
  async update(
    bundlePath: string,
    source: ExtensionSource,
    opts?: { force?: boolean; remoteWatermark?: RemoteWatermark | null },
  ): Promise<{ extension: InstalledExtension; from: string; to: string }> {
    const preview = await peekManifest(bundlePath);

    const found = this.get(preview.id) ?? this.getBySlug(preview.slug);
    if (!found) {
      throw new Error(`Extension not installed: ${preview.slug}. Use install instead.`);
    }

    return this.withSlugLock(found.slug, () => this.applyUpdate(bundlePath, source, preview, opts));
  }

  private async applyUpdate(
    bundlePath: string,
    source: ExtensionSource,
    preview: ExtensionManifest,
    opts?: { force?: boolean; remoteWatermark?: RemoteWatermark | null },
  ): Promise<{ extension: InstalledExtension; from: string; to: string }> {
    // Re-read under the lock: an update that finished while this one waited
    // for its bundle has already moved the row on.
    const existing = this.get(preview.id) ?? this.getBySlug(preview.slug);
    if (!existing) {
      throw new Error(`Extension not installed: ${preview.slug}. Use install instead.`);
    }

    if (!opts?.force && !isNewer(preview.version, existing.version)) {
      throw new Error(
        `${existing.slug} is already at ${existing.version} (bundle is ${preview.version}); nothing to update.`,
      );
    }

    // Re-check entitlement against the INCOMING manifest — a license that
    // covered v1 may no longer be relevant if v2 changed pricing, and a
    // license-less kernel must never apply an update it can't run.
    if (isPaidExtension(preview) && !this.hasLicense(requiredFeature(preview))) {
      throw new Error(
        `${existing.slug} update requires an active ${requiredFeature(preview)} license.`,
      );
    }

    const prevRow: InstalledExtension = { ...existing };
    const slugDir = join(this.opts.extensionsDir, existing.slug);
    const inDataDir = isPathInside(this.opts.extensionsDir, existing.install_path, { allowRoot: false });

    // In the data dir the live copy is what gets replaced. A built-in still
    // pointing at the shipped bundle is never written into — that copy is
    // read-only and the boot re-seed owns it — so the update goes to the
    // slug's data-dir folder, where only a stale leftover could be in the way.
    let targetDir = inDataDir ? existing.install_path : slugDir;
    await mkdir(this.opts.extensionsDir, { recursive: true });

    let backupDir: string | null = null; // where the previous copy was moved to
    let restoreTo: string | null = null; // where it goes back on rollback
    let heldDir: string | null = null; // a folder Windows would not release

    if (existsSync(targetDir)) {
      const aside = `${targetDir}.bak-${newId()}`;
      if (await this.tryMoveDir(targetDir, aside, existing.slug)) {
        backupDir = aside;
        restoreTo = targetDir;
      } else {
        heldDir = targetDir;
        targetDir = this.sideDir(existing.slug, preview.version);
      }
    }

    try {
      const unpacked = await unpackBundle(bundlePath, targetDir, true);
      const { manifest } = unpacked;

      const auth = await checkBundleAuthenticity(
        manifest,
        unpacked.computedSha256,
        (s, g) => this.verifySignature(s, g),
      );
      if (!auth.ok) {
        throw new Error(`Refusing to update ${manifest.slug}: ${auth.reason}`);
      }

      await dispatchInstall(manifest, targetDir, this.opts.installerDeps);

      const now = isoNow();
      const updatedRow: InstalledExtension = {
        ...existing,
        version: manifest.version,
        name: manifest.name,
        manifest_json: JSON.stringify(manifest),
        type: manifest.type,
        install_path: targetDir,
        updated_at: now,
      };
      this.db
        .prepare(
          `UPDATE installed_extensions
              SET version = ?, name = ?, manifest_json = ?, type = ?, install_path = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          updatedRow.version,
          updatedRow.name,
          updatedRow.manifest_json,
          updatedRow.type,
          updatedRow.install_path,
          updatedRow.updated_at,
          updatedRow.id,
        );

      await this.finalizeReceipt(updatedRow, source, opts?.remoteWatermark ?? null);

      if (backupDir) await this.discardDir(backupDir);
      if (heldDir) await this.discardDir(heldDir);

      return { extension: updatedRow, from: prevRow.version, to: manifest.version };
    } catch (err) {
      await this.deleteDir(targetDir).catch(() => {});
      if (backupDir && restoreTo) {
        const from = backupDir;
        const to = restoreTo;
        await this.moveDir(from, to).catch((restoreErr) => {
          log.error(
            `Extension ${existing.slug}: update failed AND the previous copy could not be restored ` +
              `from ${from} to ${to} — ${restoreErr instanceof Error ? restoreErr.message : restoreErr}`,
          );
        });
      }
      this.db
        .prepare(
          `UPDATE installed_extensions
              SET version = ?, name = ?, manifest_json = ?, type = ?, install_path = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          prevRow.version,
          prevRow.name,
          prevRow.manifest_json,
          prevRow.type,
          prevRow.install_path,
          prevRow.updated_at,
          prevRow.id,
        );
      throw err;
    }
  }

  /**
   * Install from an already-extracted directory (no tarball). Used for
   * bundled/core extensions that ship inside the source tree.
   */
  async installFromDirectory(
    sourceDir: string,
    source: ExtensionSource = { type: "local", path: sourceDir },
    opts?: { remoteWatermark?: RemoteWatermark | null },
  ): Promise<InstalledExtension> {
    // We re-use the bundle reader for consistency: it validates + checks
    // type-consistency. The install_path is the source directory itself.
    const { readManifest } = await import("./bundle.js");
    const manifest = await readManifest(sourceDir);

    const existing = this.get(manifest.id) ?? this.getBySlug(manifest.slug);
    if (existing) throw new Error(`Extension already installed: ${manifest.id}`);

    const now = isoNow();
    const row: InstalledExtension = {
      id: manifest.id,
      slug: manifest.slug,
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      status: "installed",
      manifest_json: JSON.stringify(manifest),
      source_json: JSON.stringify(source),
      install_path: sourceDir,
      granted_permissions_json: JSON.stringify(manifest.permissions ?? []),
      settings_json: "{}",
      error: "",
      installed_at: now,
      updated_at: now,
      last_loaded_at: null,
      install_receipt_json: "{}",
    };

    this.insertRow(row);
    try {
      await dispatchInstall(manifest, sourceDir, this.opts.installerDeps);
      const finalStatus = this.postInstallStatus(manifest, sourceDir);
      this.setStatus(row.id, finalStatus);
      row.status = finalStatus;
      await this.finalizeReceipt(row, source, opts?.remoteWatermark ?? null);
      return row;
    } catch (err) {
      this.db.prepare("DELETE FROM installed_extensions WHERE id = ?").run(row.id);
      throw err;
    }
  }

  /**
   * Install from an in-memory ExtensionManifest with no on-disk source. The
   * manifest is staged into a fresh subdir of `extensionsDir/<slug>/` so
   * downstream consumers (loader, brand logo route, etc.) still find a real
   * install_path. Used by remote catalog providers that ship just a manifest.
   *
   * If the manifest declares any backend.entry / agents / skills / flows
   * paths, those files MUST already exist on disk under `<extensionsDir>/<slug>/`
   * — this method does not fetch remote assets.
   */
  async installFromManifest(
    manifest: ExtensionManifest,
    source: ExtensionSource,
    opts?: { remoteWatermark?: RemoteWatermark | null; copyFromDir?: string | null },
  ): Promise<InstalledExtension> {
    const existing = this.get(manifest.id) ?? this.getBySlug(manifest.slug);
    if (existing) throw new Error(`Extension already installed: ${manifest.id}`);

    const installPath = join(this.opts.extensionsDir, manifest.slug);
    await mkdir(installPath, { recursive: true });
    // When the catalog item came from a directory we don't own (git clone,
    // legacy assets/skills SKILL.md), copy the source files alongside the
    // synthesized extension.json so consumers like SkillBodyResolver can
    // read SKILL.md without going back to the origin directory (which may
    // be wiped on repo-unsubscribe).
    if (opts?.copyFromDir) {
      await copyDirRecursive(opts.copyFromDir, installPath);
    }
    await writeFile(
      join(installPath, "extension.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    const now = isoNow();
    const row: InstalledExtension = {
      id: manifest.id,
      slug: manifest.slug,
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      status: "installed",
      manifest_json: JSON.stringify(manifest),
      source_json: JSON.stringify(source),
      install_path: installPath,
      granted_permissions_json: JSON.stringify(manifest.permissions ?? []),
      settings_json: "{}",
      error: "",
      installed_at: now,
      updated_at: now,
      last_loaded_at: null,
      install_receipt_json: "{}",
    };

    this.insertRow(row);
    try {
      await dispatchInstall(manifest, installPath, this.opts.installerDeps);
      const finalStatus = this.postInstallStatus(manifest, installPath);
      this.setStatus(row.id, finalStatus);
      row.status = finalStatus;
      await this.finalizeReceipt(row, source, opts?.remoteWatermark ?? null);
      return row;
    } catch (err) {
      this.db.prepare("DELETE FROM installed_extensions WHERE id = ?").run(row.id);
      throw err;
    }
  }

  /**
   * Re-read the manifest at `sourceDir` and overwrite the row's manifest_json.
   * Status/settings are preserved. Used by the in-tree extension seeder to
   * propagate edits to `assets/extensions/<slug>/extension.json` without
   * requiring a DB wipe. Returns true if anything changed.
   *
   * `install_path` is only rewritten when the row still points at the shipped
   * bundle. An extension that needed packages was copied into the writable
   * extensions dir by `ensureExtensionPackages`, and its node_modules live
   * there; pointing it back at the read-only bundle — where nothing resolves —
   * broke it on the next boot. That is what made enabling Cinema (or anything
   * else declaring an on-demand SDK) work until the first restart and then
   * land in `error` on a native install.
   *
   * Keeping the path pinned would trade that bug for a quieter one: a kernel
   * upgrade ships new extension code in the bundle, and a materialized copy
   * would keep running last version's forever. So when the shipped version
   * moves, the code is re-copied over the materialized dir — everything except
   * the node_modules and the synthesized package.json that make it work.
   */
  async refreshFromDirectory(id: string, sourceDir: string): Promise<boolean> {
    const row = this.mustGet(id);
    const { readManifest } = await import("./bundle.js");
    const manifest = await readManifest(sourceDir);
    const newManifestJson = JSON.stringify(manifest);
    // isPathInside, not a string prefix: on Windows the two sides can differ
    // in separator or drive-letter case and still be the same folder.
    const materialized =
      !!row.install_path &&
      isPathInside(this.opts.extensionsDir, row.install_path, { allowRoot: false });
    const nextPath = materialized ? row.install_path : sourceDir;

    // A materialized copy NEWER than what the kernel ships is an update applied
    // from the store. Refreshing it from the bundle would quietly put the old
    // version back on every boot, so the bundle only wins when it is newer.
    if (materialized && isNewer(row.version, manifest.version)) {
      return false;
    }

    if (materialized && isNewer(manifest.version, row.version)) {
      try {
        cpSync(sourceDir, nextPath, {
          recursive: true,
          force: true,
          filter: (src) => {
            const rel = relative(sourceDir, src);
            if (!rel) return true;
            const head = rel.split(sep)[0];
            return head !== "node_modules" && head !== "package.json" && head !== ".bun-cache";
          },
        });
        log.info(
          `Extension ${row.slug}: refreshed materialized copy to ${manifest.version} (was ${row.version})`,
        );
      } catch (err) {
        // Non-fatal: the extension keeps running the version it has, which is
        // strictly better than a half-copied directory.
        log.warn(
          `Extension ${row.slug}: could not refresh materialized copy — ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (row.manifest_json === newManifestJson && row.install_path === nextPath) {
      return false;
    }
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE installed_extensions
            SET manifest_json = ?, install_path = ?, version = ?, type = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(newManifestJson, nextPath, manifest.version, manifest.type, now, id);
    return true;
  }

  /**
   * Point a row at a new directory. Used after `ensureExtensionPackages`
   * materializes an extension out of the read-only bundle so its node_modules
   * can live beside it — the loader imports from `install_path`, so it has to
   * follow or the extension resolves nothing on the next boot.
   */
  setInstallPath(id: string, installPath: string): void {
    this.db
      .prepare("UPDATE installed_extensions SET install_path = ?, updated_at = ? WHERE id = ?")
      .run(installPath, isoNow(), id);
  }

  /**
   * Rows sitting in `installed` *only* because their declared packages are not
   * on disk — the on-demand SDKs the native payload leaves out.
   *
   * Everything else that produces an `installed` row is excluded on purpose:
   * `requires_activation` is an explicit "ask me first", a paid extension
   * without its license is not ours to unlock, and `disabled` is a user
   * decision this must never walk back.
   */
  pendingPackageInstalls(): InstalledExtension[] {
    return this.list({ status: "installed" }).filter((row) => {
      if (!row.install_path) return false;
      let manifest: ExtensionManifest;
      try {
        manifest = this.parseManifest(row);
      } catch {
        return false;
      }
      if ((manifest as ExtensionManifest & { requires_activation?: boolean }).requires_activation) {
        return false;
      }
      if (isPaidExtension(manifest) && !this.hasLicense(requiredFeature(manifest))) return false;
      return needsPackageInstall(manifest, row.install_path);
    });
  }

  /**
   * Promote a row parked in `installed` to `active` when whatever was blocking
   * it is gone — its packages resolve now, or its license showed up.
   *
   * This is the other half of the on-demand package story. An extension whose
   * SDKs are not in the payload is installed-but-inactive on first boot; the
   * background provisioner fetches them without touching the status, because
   * flipping it mid-boot would advertise a feature whose backend routes were
   * already registered (or rather, not) for this process. Promotion therefore
   * happens here, at the next boot, before anything is loaded — so the
   * extension comes up wired exactly like one that was never blocked.
   *
   * Deliberately narrow: only `installed` rows are considered, so a `disabled`
   * extension (a user decision) and an `error` one (needs a look) are left
   * alone. Returns true if the row was promoted.
   */
  promoteIfUnblocked(id: string): boolean {
    const row = this.get(id);
    if (!row || row.status !== "installed" || !row.install_path) return false;
    const manifest = this.parseManifest(row);
    // An explicit requires_activation is a standing "ask me first" — never
    // overridden by this, no matter what resolves.
    if ((manifest as ExtensionManifest & { requires_activation?: boolean }).requires_activation) {
      return false;
    }
    if (this.postInstallStatus(manifest, row.install_path) !== "active") return false;
    this.setStatus(id, "active");
    log.info(`Extension promoted to active (no longer blocked): ${row.slug}`);
    return true;
  }

  // ── Enable / disable / uninstall ───────────────────────────────────

  async enable(id: string): Promise<void> {
    const row = this.mustGet(id);
    const manifest = JSON.parse(row.manifest_json) as ExtensionManifest;
    if (isPaidExtension(manifest) && !this.hasLicense(requiredFeature(manifest))) {
      throw new Error(
        `${row.slug} requires a Pro license (${requiredFeature(manifest)}). ` +
          `Add your license at /settings/license, then enable it.`,
      );
    }
    // Fetch anything the backend imports that is not already resolvable. The
    // heavy SDKs are left out of the payload deliberately — this is where they
    // arrive, for the people who actually use them. Runs BEFORE the status
    // flips: enabling an extension whose dependencies are missing yields
    // something that reads as installed and throws on first use, so a failure
    // here has to keep it disabled and say why.
    if (row.install_path) {
      const result = await ensureExtensionPackages({
        manifest,
        slug: row.slug,
        installPath: row.install_path,
        extensionsDir: this.opts.extensionsDir,
      });
      // Materializing out of the read-only bundle moves the extension; the
      // loader imports from install_path, so it has to follow.
      if (result.installPath !== row.install_path) {
        this.db
          .prepare("UPDATE installed_extensions SET install_path = ? WHERE id = ?")
          .run(result.installPath, id);
        row.install_path = result.installPath;
      }
    }

    this.setStatus(id, "active");
    log.info(`Extension enabled: ${row.slug} (${row.type})`);

    // Materialize any office / agents / flows the extension ships. Enabling is
    // the moment a PAID extension is unlocked (license checked above), and the
    // builtin-seed path never runs the composable-extras hook — so this is
    // where a seeded paid office (e.g. the DevOps Office) actually comes to
    // life. Idempotent (facade upserts key on slug) and best-effort: a failure
    // here must not leave the extension stuck disabled.
    try {
      await installComposableExtras(manifest, row.install_path, this.opts.installerDeps);
    } catch (err) {
      log.warn(
        `enable ${row.slug}: office/agents materialization failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async disable(id: string): Promise<void> {
    const row = this.mustGet(id);
    this.setStatus(id, "disabled");
    log.info(`Extension disabled: ${row.slug} (${row.type})`);
  }

  async uninstall(id: string, opts?: { force?: boolean }): Promise<void> {
    const row = this.mustGet(id);
    const manifest = this.parseManifest(row);

    // Refuse if any other extension declares this one as a dependency, unless
    // the caller explicitly opted into a forced teardown. Returning an actionable
    // error (with the offending slugs) is more useful than silently orphaning
    // dependents and letting them fail at next boot.
    if (!opts?.force) {
      const dependents = this.findDependents(row);
      if (dependents.length > 0) {
        const names = dependents.map((d) => d.slug).join(", ");
        throw new Error(
          `Cannot uninstall ${row.slug}: required by ${dependents.length} extension(s): ${names}. ` +
            `Uninstall or disable them first, or retry with force=true.`,
        );
      }
    }

    await this.withSlugLock(row.slug, async () => {
      // Best-effort type-specific teardown, then delete of dir + row.
      try {
        await dispatchUninstall(manifest, row.install_path, this.opts.installerDeps);
      } catch (err) {
        log.warn(`Uninstall hook failed for ${row.slug}: ${err}`);
      }

      // Only a copy in the data dir is the extension's own to delete. A
      // built-in still pointing at the shipped bundle lives in the app's
      // read-only folder (Program Files, /opt, the .app, /app/assets in
      // Docker) — deleting that would strip files out of the installation.
      // What Windows will not release is removed at the next start instead of
      // being left for a reinstall to extract over.
      if (row.install_path && isPathInside(this.opts.extensionsDir, row.install_path, { allowRoot: false })) {
        await this.discardDir(row.install_path);
      }
      this.db.prepare("DELETE FROM installed_extensions WHERE id = ?").run(id);
      log.info(`Extension uninstalled: ${row.slug}`);
    });
  }

  /**
   * Return every installed extension whose manifest.dependencies includes
   * this row's id or slug. Used to block premature uninstall.
   */
  findDependents(row: InstalledExtension): InstalledExtension[] {
    const all = this.list();
    return all.filter((other) => {
      if (other.id === row.id) return false;
      const deps = this.parseManifest(other).dependencies ?? [];
      return deps.includes(row.id) || deps.includes(row.slug);
    });
  }

  // ── Status helpers ──────────────────────────────────────────────────

  setStatus(id: string, status: ExtensionStatus, error = ""): void {
    this.db
      .prepare(
        `UPDATE installed_extensions
         SET status = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, error, isoNow(), id);
  }

  /**
   * Record why an extension is still parked, without moving it out of
   * `installed`. `setStatus` would work, but it is the wrong verb here: the
   * extension is not in `error`, it is waiting — the row just needs to carry
   * the reason so the UI can say what is missing instead of showing a feature
   * that silently does not exist.
   */
  setProvisionError(id: string, error: string): void {
    this.db
      .prepare(`UPDATE installed_extensions SET error = ?, updated_at = ? WHERE id = ?`)
      .run(error.slice(0, 500), isoNow(), id);
  }

  markLoaded(id: string): void {
    this.db
      .prepare("UPDATE installed_extensions SET last_loaded_at = ? WHERE id = ?")
      .run(isoNow(), id);
  }

  // ── Internal ────────────────────────────────────────────────────────

  private mustGet(id: string): InstalledExtension {
    const row = this.get(id);
    if (!row) throw new Error(`Extension not found: ${id}`);
    return row;
  }

  private insertRow(row: InstalledExtension): void {
    this.db
      .prepare(
        `INSERT INTO installed_extensions
           (id, slug, name, version, type, status, manifest_json, source_json,
            install_path, granted_permissions_json, settings_json, error,
            installed_at, updated_at, last_loaded_at, install_receipt_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.slug,
        row.name,
        row.version,
        row.type,
        row.status,
        row.manifest_json,
        row.source_json,
        row.install_path,
        row.granted_permissions_json,
        row.settings_json,
        row.error,
        row.installed_at,
        row.updated_at,
        row.last_loaded_at,
        row.install_receipt_json,
      );
  }

  /**
   * Decide the post-install status for a manifest. When the manifest declares
   * `requires_activation: true`, leave the extension at 'installed' (idle)
   * instead of 'active' — the user has to consciously activate via
   * kernel_extensions_activate or the dashboard.
   */
  private postInstallStatus(manifest: ExtensionManifest, installPath = ""): ExtensionStatus {
    // An extension whose packages are not on disk yet has to wait to be asked
    // for, exactly like one that declares requires_activation. Activating it on
    // sight means the loader imports it at boot, fails on the missing package,
    // and files it under `error` — which is how a fresh install came up showing
    // ten broken extensions that were only ever waiting for someone to enable
    // them. Derived rather than another manifest flag: the condition is simply
    // whether the packages are there.
    const requiresActivation =
      !!(manifest as ExtensionManifest & { requires_activation?: boolean }).requires_activation ||
      needsPackageInstall(manifest, installPath);
    // Paid extensions install but stay inactive until their `pro:<slug>` license
    // is present. Free extensions activate as before.
    return activationStatus(manifest, (f) => this.hasLicense(f), requiresActivation);
  }

  /**
   * Build + persist the install receipt for a freshly-installed row. Computes
   * bundle_sha256 from install_path. Safe-no-throws — receipt failures don't
   * block the install (receipt is best-effort audit, not gating).
   */
  private async finalizeReceipt(
    row: InstalledExtension,
    source: ExtensionSource,
    remoteWatermark: RemoteWatermark | null,
  ): Promise<InstallReceipt | null> {
    try {
      const bundleSha = await computeInstallPathSha256(row.install_path);
      const receipt = buildInstallReceipt({
        installedAt: row.installed_at,
        bundleSha256: bundleSha,
        source,
        identity: this.opts.identity ?? null,
        remoteWatermark,
      });
      const json = JSON.stringify(receipt);
      this.db
        .prepare("UPDATE installed_extensions SET install_receipt_json = ? WHERE id = ?")
        .run(json, row.id);
      row.install_receipt_json = json;
      return receipt;
    } catch (err) {
      log.warn(`Receipt generation failed for ${row.slug}: ${err}`);
      return null;
    }
  }

  /** Read + parse the receipt for an installed extension. Returns null when
   *  the row predates v3 of the migration or the JSON is corrupt. */
  getReceipt(id: string): InstallReceipt | null {
    const row = this.get(id);
    if (!row || !row.install_receipt_json || row.install_receipt_json === "{}") return null;
    try {
      return JSON.parse(row.install_receipt_json) as InstallReceipt;
    } catch {
      return null;
    }
  }

  // Re-exports for use by loader / tools / tests.
  newInstallId(): string {
    return newId();
  }
}

/**
 * Recursive directory copy. Used by installFromManifest when the catalog
 * registry pre-fetched a source dir we don't own (git clone, etc.) and we
 * want the install_path to be self-contained going forward.
 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  const { readdir, copyFile } = await import("node:fs/promises");
  await mkdir(dest, { recursive: true });
  let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[] = [];
  try { entries = await readdir(src, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) await copyDirRecursive(s, d);
    else if (e.isFile()) await copyFile(s, d);
  }
}
