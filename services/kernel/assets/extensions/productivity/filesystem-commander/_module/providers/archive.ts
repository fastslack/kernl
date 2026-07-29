/**
 * ArchiveProvider — treats a zip file as a virtual filesystem.
 *
 * Read-only in phase 3: list() + stat() + readStream() work. Writing into
 * an archive would require repacking the whole file and lives behind a
 * separate create-archive action.
 *
 * Design: one ArchiveProvider per open archive. Entries are buffered into
 * a lightweight index up-front (yauzl central directory scan). Streams are
 * opened on demand from the source zip file — no full decompression in RAM.
 *
 * Supports zip today; tar/tgz can extend the same interface later.
 */

import { Readable, Writable } from "node:stream";
import { fromBuffer, open as openZip, type ZipFile, type Entry as ZipEntry } from "yauzl";
import type { FsEntry, FsListing, FsStat } from "../types.js";
import {
	NotSupportedError,
	PathOutOfScopeError,
	type FsProvider,
	type WriteStreamOptions,
} from "./provider.js";

interface ArchiveIndexEntry {
	name: string;        // full normalized path inside archive, no leading '/'
	kind: "file" | "dir";
	size: number;
	mtime: string;
	yauzlEntry?: ZipEntry;
}

function openZipPromise(path: string): Promise<ZipFile> {
	return new Promise((resolve, reject) => {
		openZip(path, { lazyEntries: true }, (err, zf) => {
			if (err || !zf) return reject(err ?? new Error("open zip failed"));
			resolve(zf);
		});
	});
}

function normalizePath(raw: string): string {
	return raw.replace(/\/+$/g, "").replace(/^\/+/, "");
}

function dirnameIn(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
}

export class ArchiveProvider implements FsProvider {
	readonly kind = "archive" as const;
	readonly id: string;
	readonly label: string;
	private indexByPath = new Map<string, ArchiveIndexEntry>();
	private childrenByDir = new Map<string, ArchiveIndexEntry[]>();
	private zipPath: string;
	private isReady: Promise<void>;

	constructor(sessionId: string, zipPath: string, label?: string) {
		this.id = `archive:${sessionId}`;
		this.zipPath = zipPath;
		this.label = label ?? zipPath.split("/").pop() ?? "archive";
		this.isReady = this.buildIndex();
	}

	private async buildIndex(): Promise<void> {
		const zf = await openZipPromise(this.zipPath);
		await new Promise<void>((resolve, reject) => {
			zf.on("entry", (entry: ZipEntry) => {
				const name = normalizePath(entry.fileName);
				const kind: "file" | "dir" = entry.fileName.endsWith("/") ? "dir" : "file";
				const mtime = entry.getLastModDate().toISOString();
				if (name) {
					const rec: ArchiveIndexEntry = {
						name,
						kind,
						size: Number(entry.uncompressedSize),
						mtime,
						yauzlEntry: kind === "file" ? entry : undefined,
					};
					this.indexByPath.set(name, rec);
				}
				zf.readEntry();
			});
			zf.on("end", () => {
				// Synthesize implicit directory entries for any file path whose
				// ancestors weren't in the central directory.
				const toAdd: ArchiveIndexEntry[] = [];
				for (const entry of this.indexByPath.values()) {
					let dir = dirnameIn(entry.name);
					while (dir && !this.indexByPath.has(dir)) {
						toAdd.push({ name: dir, kind: "dir", size: 0, mtime: entry.mtime });
						dir = dirnameIn(dir);
					}
				}
				for (const a of toAdd) this.indexByPath.set(a.name, a);

				// Group children by immediate parent.
				for (const entry of this.indexByPath.values()) {
					const parent = dirnameIn(entry.name);
					const list = this.childrenByDir.get(parent) ?? [];
					list.push(entry);
					this.childrenByDir.set(parent, list);
				}
				// Don't close — we need the ZipFile handle alive for readStream.
				resolve();
			});
			zf.on("error", reject);
			zf.readEntry();
		});
	}

	async list(path: string): Promise<FsListing> {
		await this.isReady;
		const norm = normalizePath(path);
		if (norm && !this.indexByPath.has(norm) && !this.childrenByDir.has(norm)) {
			throw new PathOutOfScopeError(path);
		}
		const children = this.childrenByDir.get(norm) ?? [];
		const entries: FsEntry[] = children
			.slice()
			.sort((a, b) => {
				if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
				return a.name.localeCompare(b.name);
			})
			.map((c) => ({
				name: c.name.slice(c.name.lastIndexOf("/") + 1),
				kind: c.kind,
				size: c.size,
				mtime: c.mtime,
			}));
		const parent = norm ? dirnameIn(norm) : null;
		return {
			path: "/" + norm,
			entries,
			parent: parent === null ? null : parent ? "/" + parent : "/",
		};
	}

	async stat(path: string): Promise<FsStat> {
		await this.isReady;
		const norm = normalizePath(path);
		const row = this.indexByPath.get(norm);
		if (!row) throw new PathOutOfScopeError(path);
		return {
			path: "/" + row.name,
			name: row.name.slice(row.name.lastIndexOf("/") + 1),
			kind: row.kind,
			size: row.size,
			mtime: row.mtime,
		};
	}

	async readStream(path: string): Promise<Readable> {
		await this.isReady;
		const norm = normalizePath(path);
		const row = this.indexByPath.get(norm);
		if (!row || row.kind !== "file" || !row.yauzlEntry) {
			throw new PathOutOfScopeError(path);
		}
		// Open a fresh ZipFile handle for the read — yauzl streams can only
		// be read once per entry, so we re-open per call.
		const zf = await openZipPromise(this.zipPath);
		return new Promise<Readable>((resolve, reject) => {
			zf.readEntry();
			let found = false;
			zf.on("entry", (entry: ZipEntry) => {
				if (normalizePath(entry.fileName) === norm && !entry.fileName.endsWith("/")) {
					found = true;
					zf.openReadStream(entry, (err, stream) => {
						if (err || !stream) return reject(err ?? new Error("openReadStream failed"));
						// Close zip when stream done.
						stream.on("end", () => zf.close());
						stream.on("error", () => zf.close());
						resolve(stream);
					});
				} else {
					zf.readEntry();
				}
			});
			zf.on("end", () => {
				if (!found) reject(new PathOutOfScopeError(path));
				zf.close();
			});
			zf.on("error", reject);
		});
	}

	async writeStream(_path: string, _opts?: WriteStreamOptions): Promise<Writable> {
		throw new NotSupportedError("writeStream", this.kind);
	}

	async mkdir(): Promise<void> {
		throw new NotSupportedError("mkdir", this.kind);
	}

	async rm(): Promise<void> {
		throw new NotSupportedError("rm", this.kind);
	}

	async rename(): Promise<void> {
		throw new NotSupportedError("rename", this.kind);
	}
}

/** Build an ArchiveProvider from in-memory bytes (unused today; reserved). */
export async function archiveFromBuffer(sessionId: string, buffer: Buffer): Promise<ArchiveProvider> {
	// yauzl supports fromBuffer; we'd need to adapt the provider to hold the
	// buffer instead of a zipPath. Out of scope for phase 3.
	void fromBuffer;
	void buffer;
	throw new Error(`archiveFromBuffer(${sessionId}) not yet implemented`);
}
