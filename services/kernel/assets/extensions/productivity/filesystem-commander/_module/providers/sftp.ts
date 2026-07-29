/**
 * SftpProvider — connects to a remote SSH host and exposes its filesystem.
 *
 * Uses ssh2-sftp-client. One connection per provider; lazy-open + auto-close
 * after IDLE_MS of inactivity. Paths are POSIX.
 */

import { Readable, Writable, PassThrough } from "node:stream";
// ssh2-sftp-client CommonJS default export.
import SftpClientLib from "ssh2-sftp-client";
import type { FsEntry, FsListing, FsStat } from "../types.js";
import {
	type FsProvider,
	type WriteStreamOptions,
	PathOutOfScopeError,
} from "./provider.js";

export interface SftpConfig {
	host: string;
	port?: number;
	username: string;
	password?: string;
	privateKey?: string; // PEM string
	passphrase?: string;
	readyTimeout?: number;
}

const IDLE_MS = 5 * 60 * 1000;

export class SftpProvider implements FsProvider {
	readonly kind = "sftp" as const;
	readonly id: string;
	readonly label: string;
	private client: InstanceType<typeof SftpClientLib> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private connecting: Promise<InstanceType<typeof SftpClientLib>> | null = null;

	constructor(id: string, label: string, private config: SftpConfig) {
		this.id = `sftp:${id}`;
		this.label = label;
	}

	private async connect(): Promise<InstanceType<typeof SftpClientLib>> {
		if (this.client) {
			this.resetIdle();
			return this.client;
		}
		if (this.connecting) return this.connecting;
		this.connecting = (async () => {
			const c = new SftpClientLib(this.id);
			await c.connect({
				host: this.config.host,
				port: this.config.port ?? 22,
				username: this.config.username,
				password: this.config.password,
				privateKey: this.config.privateKey,
				passphrase: this.config.passphrase,
				readyTimeout: this.config.readyTimeout ?? 20000,
			});
			this.client = c;
			this.resetIdle();
			this.connecting = null;
			return c;
		})();
		return this.connecting;
	}

	private resetIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.close().catch(() => {}), IDLE_MS);
		this.idleTimer.unref?.();
	}

	private async close(): Promise<void> {
		if (!this.client) return;
		try {
			await this.client.end();
		} catch {
			// ignore
		}
		this.client = null;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	async shutdown(): Promise<void> {
		await this.close();
	}

	async list(path: string): Promise<FsListing> {
		const c = await this.connect();
		// ssh2-sftp-client's list returns FileInfo records.
		const rows = await c.list(path);
		const entries: FsEntry[] = rows.map((r) => ({
			name: r.name,
			kind:
				r.type === "d" ? "dir" : r.type === "l" ? "symlink" : r.type === "-" ? "file" : "special",
			size: Number(r.size),
			mtime: new Date(r.modifyTime).toISOString(),
			permissions: typeof r.rights === "object" && r.rights
				? `${r.rights.user ?? ""}${r.rights.group ?? ""}${r.rights.other ?? ""}`
				: undefined,
		}));
		entries.sort((a, b) => {
			if (a.kind === "dir" && b.kind !== "dir") return -1;
			if (b.kind === "dir" && a.kind !== "dir") return 1;
			return a.name.localeCompare(b.name);
		});
		const parent = path === "/" ? null : path.replace(/\/[^/]+\/?$/, "") || "/";
		return { path, entries, parent };
	}

	async stat(path: string): Promise<FsStat> {
		const c = await this.connect();
		const s = await c.stat(path);
		return {
			path,
			name: path.split("/").pop() ?? path,
			kind: s.isDirectory ? "dir" : s.isSymbolicLink ? "symlink" : "file",
			size: Number(s.size),
			mtime: new Date(s.modifyTime).toISOString(),
			atime: new Date(s.accessTime).toISOString(),
			permissions: typeof s.mode === "number" ? s.mode.toString(8) : undefined,
		};
	}

	async readStream(path: string): Promise<Readable> {
		const c = await this.connect();
		const out = new PassThrough();
		// SftpClient.get(remotePath, Writable) pipes into the Writable.
		c.get(path, out).catch((err) => out.destroy(err));
		return out;
	}

	async writeStream(path: string, opts?: WriteStreamOptions): Promise<Writable> {
		const c = await this.connect();
		if (opts?.overwrite === false) {
			try {
				await c.stat(path);
				throw new Error(`File already exists: ${path}`);
			} catch (err) {
				const msg = (err as Error).message;
				if (!/No such file/i.test(msg)) {
					if ((err as Error).message.startsWith("File already exists")) throw err;
					// other error — fall through
				}
			}
		}
		const pt = new PassThrough();
		// put(source, remotePath) returns a promise that resolves when done.
		c.put(pt, path).catch((err) => pt.destroy(err));
		return pt;
	}

	async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
		const c = await this.connect();
		await c.mkdir(path, opts?.recursive ?? false);
	}

	async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
		const c = await this.connect();
		const s = await c.stat(path).catch(() => null);
		if (!s) throw new PathOutOfScopeError(path);
		if (s.isDirectory) {
			if (!opts?.recursive) throw new Error("rmdir requires recursive: true");
			await c.rmdir(path, true);
		} else {
			await c.delete(path);
		}
	}

	async rename(from: string, to: string): Promise<void> {
		const c = await this.connect();
		await c.rename(from, to);
	}
}
