/**
 * FsProvider — uniform interface every filesystem backend implements.
 *
 * Providers: `local`, `sftp:<id>`, `s3:<id>`, `webdav:<id>`, `archive:<sid>`.
 *
 * Streams let cross-provider copy/move work without buffering full files
 * (see `../ops.ts`). Providers that can't stream a given operation throw
 * a `NotSupportedError`.
 */

import type { Readable, Writable } from "node:stream";
import type { FsListing, FsStat } from "../types.js";

export class NotSupportedError extends Error {
  constructor(op: string, providerKind: string) {
    super(`${providerKind} provider does not support ${op}`);
    this.name = "NotSupportedError";
  }
}

export class PathOutOfScopeError extends Error {
  constructor(path: string) {
    super(`Path out of allowed scope: ${path}`);
    this.name = "PathOutOfScopeError";
  }
}

export interface WriteStreamOptions {
  overwrite?: boolean;
  /** Expected total bytes — some providers (S3 multipart) can optimize. */
  expectedSize?: number;
}

export interface FsProvider {
  readonly id: string;
  readonly kind: "local" | "sftp" | "s3" | "webdav" | "archive";
  readonly label: string;

  list(path: string): Promise<FsListing>;
  stat(path: string): Promise<FsStat>;

  readStream(
    path: string,
    range?: { start: number; end?: number },
  ): Promise<Readable>;

  writeStream(path: string, opts?: WriteStreamOptions): Promise<Writable>;

  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;

  /** Optional cleanup (close pool connections, etc.). */
  shutdown?(): Promise<void>;
}
