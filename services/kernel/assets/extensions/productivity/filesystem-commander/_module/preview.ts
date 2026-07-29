/**
 * Preview endpoint helpers.
 *
 * Returns a "kind" + appropriate payload for a given file path:
 *   - image / video / pdf: caller streams raw bytes with proper MIME.
 *   - text: returns decoded content up to maxPreviewBytes, flagged truncated.
 *   - binary: returns a hex dump (offset + hex columns + ascii) up to a cap.
 *   - too-large: returns metadata only.
 */

import { extname, basename } from "node:path";
import type { FsProvider } from "./providers/provider.js";

export interface PreviewResult {
	kind: "image" | "video" | "audio" | "pdf" | "text" | "hex" | "too-large" | "unsupported";
	mime: string;
	size: number;
	name: string;
	/** Decoded content for text; hex dump for hex. */
	content?: string;
	truncated?: boolean;
	/** Offset → hex line map, only for hex kind. */
	hex?: Array<{ offset: string; hex: string; ascii: string }>;
	/** True if the client should request a direct raw stream via ?raw=1. */
	streamable?: boolean;
}

const EXT_MIME: Record<string, string> = {
	// Images
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	ico: "image/x-icon",
	heic: "image/heic",
	// Video
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	m4v: "video/mp4",
	// Audio
	mp3: "audio/mpeg",
	ogg: "audio/ogg",
	wav: "audio/wav",
	flac: "audio/flac",
	m4a: "audio/mp4",
	// Docs
	pdf: "application/pdf",
	// Text
	txt: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	json: "application/json",
	yaml: "text/yaml",
	yml: "text/yaml",
	toml: "text/toml",
	xml: "application/xml",
	html: "text/html",
	htm: "text/html",
	css: "text/css",
	js: "text/javascript",
	mjs: "text/javascript",
	cjs: "text/javascript",
	ts: "text/typescript",
	tsx: "text/typescript",
	jsx: "text/javascript",
	py: "text/x-python",
	rb: "text/x-ruby",
	go: "text/x-go",
	rs: "text/x-rust",
	c: "text/x-c",
	h: "text/x-c",
	cpp: "text/x-c++",
	java: "text/x-java",
	kt: "text/x-kotlin",
	swift: "text/x-swift",
	sh: "text/x-shellscript",
	bash: "text/x-shellscript",
	zsh: "text/x-shellscript",
	conf: "text/plain",
	ini: "text/plain",
	log: "text/plain",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	sql: "text/x-sql",
	dockerfile: "text/plain",
	env: "text/plain",
};

function classifyMime(mime: string): PreviewResult["kind"] {
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("video/")) return "video";
	if (mime.startsWith("audio/")) return "audio";
	if (mime === "application/pdf") return "pdf";
	if (mime.startsWith("text/") || mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
	if (mime === "application/json" || mime === "application/xml") return "text";
	return "unsupported";
}

export function guessMime(path: string): string {
	const name = basename(path).toLowerCase();
	if (name === "makefile") return "text/x-makefile";
	if (name === "dockerfile") return "text/plain";
	const ext = extname(path).slice(1).toLowerCase();
	return EXT_MIME[ext] ?? "application/octet-stream";
}

/**
 * Returns the metadata + a content payload appropriate to the file kind.
 * Callers decide whether to stream raw (for image/video/pdf) or embed the
 * returned `content` / `hex` data (for text / binary).
 */
export async function buildPreview(
	provider: FsProvider,
	path: string,
	opts: { maxTextBytes: number; maxHexBytes: number },
): Promise<PreviewResult> {
	const stat = await provider.stat(path);
	const mime = guessMime(path);
	const kind = classifyMime(mime);
	const name = basename(path);

	if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf") {
		return { kind, mime, size: stat.size, name, streamable: true };
	}

	if (kind === "text") {
		if (stat.size > opts.maxTextBytes) {
			// Still return first chunk so the user can peek at the head.
			const buf = await readFirstBytes(provider, path, opts.maxTextBytes);
			return {
				kind: "text",
				mime,
				size: stat.size,
				name,
				content: buf.toString("utf-8"),
				truncated: true,
			};
		}
		const buf = await readFirstBytes(provider, path, stat.size);
		return {
			kind: "text",
			mime,
			size: stat.size,
			name,
			content: buf.toString("utf-8"),
			truncated: false,
		};
	}

	// Unsupported extension → attempt hex dump when reasonably small.
	if (stat.size === 0) {
		return { kind: "text", mime: "text/plain", size: 0, name, content: "" };
	}
	if (stat.size > opts.maxHexBytes) {
		return { kind: "too-large", mime, size: stat.size, name };
	}
	const buf = await readFirstBytes(provider, path, stat.size);
	return {
		kind: "hex",
		mime,
		size: stat.size,
		name,
		hex: toHexDump(buf),
	};
}

async function readFirstBytes(
	provider: FsProvider,
	path: string,
	max: number,
): Promise<Buffer> {
	const stream = await provider.readStream(path, { start: 0, end: Math.max(0, max - 1) });
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		chunks.push(chunk);
		total += chunk.length;
		if (total >= max) break;
	}
	return Buffer.concat(chunks).subarray(0, max);
}

function toHexDump(buf: Buffer): Array<{ offset: string; hex: string; ascii: string }> {
	const lines: Array<{ offset: string; hex: string; ascii: string }> = [];
	for (let off = 0; off < buf.length; off += 16) {
		const slice = buf.subarray(off, Math.min(off + 16, buf.length));
		const hex = [...slice]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join(" ")
			.padEnd(47, " ");
		const ascii = [...slice]
			.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
			.join("");
		lines.push({
			offset: off.toString(16).padStart(8, "0"),
			hex,
			ascii,
		});
	}
	return lines;
}
