import { describe, it, expect } from "bun:test";
import {
	classifyFile, checkFile, formatBytes, formatDuration, docTypeLabel, derivedText,
	ACCEPT_ATTR, UUID_V4_RE, uploadUrl, attachmentFrameUrl,
} from "./files.js";
import { ATTACHMENT_CAPS } from "./types.js";

const MB = 1024 * 1024;

describe("classifyFile", () => {
	it("goes by a known extension, whatever the browser says the type is", () => {
		expect(classifyFile("notes.md", "")).toBe("document");
		expect(classifyFile("data.csv", "application/vnd.ms-excel")).toBe("document");
		expect(classifyFile("clip.MOV", "video/quicktime")).toBe("video");
		expect(classifyFile("photo.JPG", "image/jpeg")).toBe("image");
	});

	it("refuses an unknown extension even when the type looks fine", () => {
		expect(classifyFile("archive.zip", "application/zip")).toBeNull();
		expect(classifyFile("sheet.xlsx", "application/pdf")).toBeNull();
	});

	it("falls back to the MIME type for a name without extension (a paste)", () => {
		expect(classifyFile("", "image/png")).toBe("image");
		expect(classifyFile("blob", "application/pdf")).toBe("document");
		expect(classifyFile("blob", "text/plain; charset=utf-8")).toBe("document");
		expect(classifyFile("", "application/octet-stream")).toBeNull();
	});

	it("never accepts SVG", () => {
		expect(classifyFile("logo.svg", "image/svg+xml")).toBeNull();
		expect(classifyFile("", "image/svg+xml")).toBeNull();
	});

	it("the picker's accept list covers every kind and no svg", () => {
		for (const ext of [".jpg", ".png", ".pdf", ".docx", ".json", ".mp4", ".webm"]) expect(ACCEPT_ATTR).toContain(ext);
		expect(ACCEPT_ATTR).not.toContain("svg");
	});
});

describe("checkFile", () => {
	it("applies the cap of the file's own kind", () => {
		expect(checkFile({ name: "a.png", type: "image/png", size: 19 * MB })).toEqual({ ok: true, kind: "image" });
		expect(checkFile({ name: "a.png", type: "image/png", size: 21 * MB })).toEqual({ ok: false, reason: "size", kind: "image", cap: ATTACHMENT_CAPS.image });
		expect(checkFile({ name: "a.pdf", type: "application/pdf", size: 25 * MB }).ok).toBe(true);
		expect(checkFile({ name: "a.mp4", type: "video/mp4", size: 99 * MB }).ok).toBe(true);
		expect(checkFile({ name: "a.mp4", type: "video/mp4", size: 101 * MB }).ok).toBe(false);
	});

	it("reports type before size, and refuses empty files", () => {
		expect(checkFile({ name: "x.exe", type: "", size: 500 * MB })).toEqual({ ok: false, reason: "type" });
		expect(checkFile({ name: "x.txt", type: "text/plain", size: 0 })).toEqual({ ok: false, reason: "empty" });
	});
});

describe("formatting", () => {
	it("formats sizes compactly", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(1.5 * MB)).toBe("1.5 MB");
		expect(formatBytes(20 * MB)).toBe("20 MB");
	});

	it("formats durations as m:ss", () => {
		expect(formatDuration(0)).toBe("0:00");
		expect(formatDuration(75)).toBe("1:15");
		expect(formatDuration(179.6)).toBe("3:00");
	});

	it("labels documents by extension, then by MIME subtype", () => {
		expect(docTypeLabel({ filename: "informe.pdf", mime: "application/pdf" })).toBe("PDF");
		expect(docTypeLabel({ filename: "README", mime: "text/markdown" })).toBe("MARKD");
	});
});

describe("derivedText", () => {
	it("picks the field the model read for each kind", () => {
		expect(derivedText({ kind: "video", derived: { transcript: "[00:01] hola", text: "x" } })).toBe("[00:01] hola");
		expect(derivedText({ kind: "image", derived: { description: " a cat " } })).toBe("a cat");
		expect(derivedText({ kind: "document", derived: { text: "body" } })).toBe("body");
	});

	it("is null when nothing was extracted", () => {
		expect(derivedText({ kind: "document", derived: {} })).toBeNull();
		expect(derivedText({ kind: "video", derived: { transcript: "  " } })).toBeNull();
	});
});

describe("urls", () => {
	it("encodes the filename into the upload query", () => {
		expect(uploadUrl("mi informe #2.pdf")).toBe("/api/attachments?filename=mi%20informe%20%232.pdf");
	});

	it("builds frame urls by index", () => {
		expect(attachmentFrameUrl("abc", 3)).toBe("/api/attachments/abc/frames/3");
	});

	it("matches only uuid v4", () => {
		expect(UUID_V4_RE.test("3f2b8c1e-9a4d-4c7e-8b1a-2d3e4f5a6b7c")).toBe(true);
		expect(UUID_V4_RE.test("3f2b8c1e-9a4d-1c7e-8b1a-2d3e4f5a6b7c")).toBe(false);
		expect(UUID_V4_RE.test("../etc/passwd")).toBe(false);
	});
});
