/**
 * S3Provider — map a bucket (or a key prefix within it) to an FsProvider.
 *
 * List mode: `ListObjectsV2` with `Delimiter: "/"`; `CommonPrefixes` become
 * "directories" and `Contents` become files. S3 has no directories — paths
 * ending with "/" are treated as markers; we don't create those on mkdir
 * unless explicitly requested.
 */

import { PassThrough, Readable, Writable } from "node:stream";
import {
	S3Client,
	ListObjectsV2Command,
	GetObjectCommand,
	HeadObjectCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	CopyObjectCommand,
	PutObjectCommand,
	type ListObjectsV2CommandOutput,
	type ObjectIdentifier,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { FsEntry, FsListing, FsStat } from "../types.js";
import {
	type FsProvider,
	type WriteStreamOptions,
	PathOutOfScopeError,
	NotSupportedError,
} from "./provider.js";

export interface S3Config {
	region?: string;
	accessKeyId: string;
	secretAccessKey: string;
	endpoint?: string; // for S3-compat: MinIO, R2, B2
	bucket: string;
	forcePathStyle?: boolean;
}

function stripLeading(p: string): string {
	return p.replace(/^\/+/, "");
}

function ensureTrailing(p: string): string {
	return p.endsWith("/") ? p : p + "/";
}

export class S3Provider implements FsProvider {
	readonly kind = "s3" as const;
	readonly id: string;
	readonly label: string;
	private client: S3Client;
	private bucket: string;

	constructor(id: string, label: string, private config: S3Config) {
		this.id = `s3:${id}`;
		this.label = label;
		this.bucket = config.bucket;
		this.client = new S3Client({
			region: config.region ?? "us-east-1",
			endpoint: config.endpoint,
			forcePathStyle: config.forcePathStyle ?? !!config.endpoint,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
		});
	}

	async shutdown(): Promise<void> {
		this.client.destroy();
	}

	async list(path: string): Promise<FsListing> {
		const prefix = path === "/" || path === "" ? "" : ensureTrailing(stripLeading(path));
		const entries: FsEntry[] = [];
		let continuationToken: string | undefined = undefined;
		do {
			const out: ListObjectsV2CommandOutput = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					Delimiter: "/",
					ContinuationToken: continuationToken,
				}),
			);
			for (const cp of out.CommonPrefixes ?? []) {
				const name = (cp.Prefix ?? "").slice(prefix.length).replace(/\/$/, "");
				if (!name) continue;
				entries.push({
					name,
					kind: "dir",
					size: 0,
					mtime: new Date(0).toISOString(),
				});
			}
			for (const obj of out.Contents ?? []) {
				const name = (obj.Key ?? "").slice(prefix.length);
				if (!name || name.endsWith("/")) continue; // skip self + dir markers
				entries.push({
					name,
					kind: "file",
					size: Number(obj.Size ?? 0),
					mtime: obj.LastModified?.toISOString() ?? new Date(0).toISOString(),
				});
			}
			continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
		} while (continuationToken);
		entries.sort((a, b) => {
			if (a.kind === "dir" && b.kind !== "dir") return -1;
			if (b.kind === "dir" && a.kind !== "dir") return 1;
			return a.name.localeCompare(b.name);
		});
		const parent =
			path === "/" || path === ""
				? null
				: ("/" + stripLeading(path).replace(/\/?[^/]*\/?$/, "")).replace(/\/\/+/g, "/") || "/";
		return { path: "/" + stripLeading(path), entries, parent };
	}

	async stat(path: string): Promise<FsStat> {
		const key = stripLeading(path);
		try {
			const out = await this.client.send(
				new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
			);
			return {
				path: "/" + key,
				name: key.split("/").pop() ?? key,
				kind: "file",
				size: Number(out.ContentLength ?? 0),
				mtime: out.LastModified?.toISOString() ?? new Date(0).toISOString(),
			};
		} catch {
			// Maybe it's a "directory"; confirm via ListObjectsV2 with prefix.
			const probe = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: ensureTrailing(key),
					MaxKeys: 1,
				}),
			);
			if (probe.Contents?.length || probe.CommonPrefixes?.length) {
				return {
					path: "/" + key,
					name: key.split("/").pop() ?? key,
					kind: "dir",
					size: 0,
					mtime: new Date(0).toISOString(),
				};
			}
			throw new PathOutOfScopeError(path);
		}
	}

	async readStream(path: string): Promise<Readable> {
		const out = await this.client.send(
			new GetObjectCommand({ Bucket: this.bucket, Key: stripLeading(path) }),
		);
		if (!out.Body) throw new Error("Empty S3 response");
		return out.Body as Readable;
	}

	async writeStream(path: string, opts?: WriteStreamOptions): Promise<Writable> {
		const pt = new PassThrough();
		const upload = new Upload({
			client: this.client,
			params: {
				Bucket: this.bucket,
				Key: stripLeading(path),
				Body: pt,
			},
		});
		// Fire-and-forget; consumer awaits upstream pipeline completion.
		void opts;
		upload.done().catch((err) => pt.destroy(err));
		return pt;
	}

	async mkdir(path: string): Promise<void> {
		// Create an empty marker object.
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: ensureTrailing(stripLeading(path)),
				Body: "",
			}),
		);
	}

	async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
		const key = stripLeading(path);
		if (!opts?.recursive) {
			await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
			return;
		}
		// Recursive: list all keys under the prefix and delete in batches of 1000.
		const prefix = ensureTrailing(key);
		let continuationToken: string | undefined = undefined;
		do {
			const out: ListObjectsV2CommandOutput = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken,
				}),
			);
			const keys: ObjectIdentifier[] = (out.Contents ?? [])
				.filter((c) => !!c.Key)
				.map((c) => ({ Key: c.Key! }));
			if (keys.length) {
				await this.client.send(
					new DeleteObjectsCommand({
						Bucket: this.bucket,
						Delete: { Objects: keys },
					}),
				);
			}
			continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
		} while (continuationToken);
		// Also delete the marker itself if present.
		await this.client
			.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: prefix }))
			.catch(() => {});
	}

	async rename(from: string, to: string): Promise<void> {
		// S3 rename = copy + delete.
		const fromKey = stripLeading(from);
		const toKey = stripLeading(to);
		await this.client.send(
			new CopyObjectCommand({
				Bucket: this.bucket,
				CopySource: `/${this.bucket}/${encodeURIComponent(fromKey)}`,
				Key: toKey,
			}),
		);
		await this.client.send(
			new DeleteObjectCommand({ Bucket: this.bucket, Key: fromKey }),
		);
		// Trigger not-used warning silencer for optional import.
		void NotSupportedError;
	}
}
