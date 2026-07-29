/**
 * WebDavProvider — wraps the `webdav` npm library.
 */

import { PassThrough, Readable, Writable } from "node:stream";
import { createClient, type WebDAVClient, type FileStat } from "webdav";
import type { FsEntry, FsListing, FsStat } from "../types.js";
import {
	type FsProvider,
	type WriteStreamOptions,
	PathOutOfScopeError,
} from "./provider.js";

export interface WebDavConfig {
	baseUrl: string;
	username?: string;
	password?: string;
	token?: string; // bearer
}

function normalizePath(p: string): string {
	if (!p || p === "/") return "/";
	return p.endsWith("/") ? p.slice(0, -1) : p;
}

export class WebDavProvider implements FsProvider {
	readonly kind = "webdav" as const;
	readonly id: string;
	readonly label: string;
	private client: WebDAVClient;

	constructor(id: string, label: string, private config: WebDavConfig) {
		this.id = `webdav:${id}`;
		this.label = label;
		this.client = createClient(config.baseUrl, {
			username: config.username,
			password: config.password,
			token: config.token
				? { access_token: config.token, token_type: "Bearer" }
				: undefined,
		});
	}

	async shutdown(): Promise<void> {
		// webdav client has no explicit close hook.
	}

	async list(path: string): Promise<FsListing> {
		const p = normalizePath(path) || "/";
		const raw = (await this.client.getDirectoryContents(p)) as FileStat[];
		const entries: FsEntry[] = raw.map((r) => ({
			name: r.basename,
			kind: r.type === "directory" ? "dir" : "file",
			size: Number(r.size ?? 0),
			mtime: r.lastmod ? new Date(r.lastmod).toISOString() : new Date(0).toISOString(),
			mime: r.mime ?? undefined,
		}));
		entries.sort((a, b) => {
			if (a.kind === "dir" && b.kind !== "dir") return -1;
			if (b.kind === "dir" && a.kind !== "dir") return 1;
			return a.name.localeCompare(b.name);
		});
		const parent = p === "/" ? null : p.replace(/\/[^/]+$/, "") || "/";
		return { path: p, entries, parent };
	}

	async stat(path: string): Promise<FsStat> {
		const s = (await this.client.stat(normalizePath(path))) as FileStat;
		if (!s) throw new PathOutOfScopeError(path);
		return {
			path: normalizePath(path),
			name: s.basename,
			kind: s.type === "directory" ? "dir" : "file",
			size: Number(s.size ?? 0),
			mtime: s.lastmod ? new Date(s.lastmod).toISOString() : new Date(0).toISOString(),
			mime: s.mime ?? undefined,
		};
	}

	async readStream(path: string): Promise<Readable> {
		const s = this.client.createReadStream(normalizePath(path));
		return s as unknown as Readable;
	}

	async writeStream(path: string, opts?: WriteStreamOptions): Promise<Writable> {
		void opts;
		const pt = new PassThrough();
		const w = this.client.createWriteStream(normalizePath(path));
		pt.pipe(w as unknown as NodeJS.WritableStream);
		return pt;
	}

	async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
		await this.client.createDirectory(normalizePath(path), {
			recursive: opts?.recursive ?? false,
		});
	}

	async rm(path: string): Promise<void> {
		// WebDAV DELETE is recursive on collections by default.
		await this.client.deleteFile(normalizePath(path));
	}

	async rename(from: string, to: string): Promise<void> {
		await this.client.moveFile(normalizePath(from), normalizePath(to));
	}
}
