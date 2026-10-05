import { describe, it, expect } from "bun:test";
import { get } from "svelte/store";
import {
	createAttachmentUploader, summarize, UploadAborted,
	type AttachmentTransport, type PendingAttachment,
} from "./upload.js";
import type { AttachmentMeta, AttachmentStatus } from "./types.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function meta(id: string, status: AttachmentStatus, extra: Partial<AttachmentMeta> = {}): AttachmentMeta {
	return { id, kind: "document", mime: "text/plain", filename: "a.txt", size_bytes: 3, status, derived: {}, created_at: "", ...extra };
}

/** A transport whose uploads are settled by hand and whose polls answer from a script. */
function fakeTransport() {
	const uploads: { file: File; resolve: (m: AttachmentMeta) => void; reject: (e: unknown) => void; progress: (f: number) => void; aborted: boolean }[] = [];
	const polls: Record<string, AttachmentStatus[]> = {};
	const removed: string[] = [];
	let n = 0;
	const transport: AttachmentTransport = {
		upload(file, onProgress) {
			let resolve!: (m: AttachmentMeta) => void, reject!: (e: unknown) => void;
			const promise = new Promise<AttachmentMeta>((a, b) => { resolve = a; reject = b; });
			const u = { file, resolve, reject, progress: onProgress, aborted: false };
			uploads.push(u);
			return { promise, abort: () => { u.aborted = true; reject(new UploadAborted()); } };
		},
		async get(id) {
			const next = polls[id]?.shift() ?? "processing";
			return meta(id, next, next === "failed" ? { error: "unreadable" } : {});
		},
		async remove(id) { removed.push(id); },
	};
	return { transport, uploads, polls, removed, nextId: () => `id-${++n}` };
}

const txt = (name = "a.txt") => new File(["abc"], name, { type: "text/plain" });

function states(list: PendingAttachment[]) { return list.map((p) => p.state); }

describe("createAttachmentUploader", () => {
	it("rejects bad files up front and starts the rest", () => {
		const f = fakeTransport();
		const up = createAttachmentUploader({ transport: f.transport, previews: false });
		const rejected = up.add([txt(), new File(["x"], "evil.svg", { type: "image/svg+xml" }), new File([], "empty.txt")]);
		expect(rejected.map((r) => r.reason)).toEqual(["type", "empty"]);
		expect(states(get(up))).toEqual(["uploading"]);
		expect(f.uploads.length).toBe(1);
	});

	it("caps the number of attachments", () => {
		const f = fakeTransport();
		const up = createAttachmentUploader({ transport: f.transport, previews: false, max: 2 });
		const rejected = up.add([txt("1.txt"), txt("2.txt"), txt("3.txt")]);
		expect(rejected).toEqual([{ name: "3.txt", reason: "count", cap: undefined }]);
		expect(get(up).length).toBe(2);
	});

	it("tracks progress, then polls processing until ready", async () => {
		const f = fakeTransport();
		const up = createAttachmentUploader({ transport: f.transport, previews: false, pollMs: 15, maxPollMs: 15 });
		up.add([txt()]);
		f.uploads[0].progress(0.5);
		expect(get(up)[0].progress).toBe(0.5);
		f.polls["id-1"] = ["processing", "ready"];
		f.uploads[0].resolve(meta("id-1", "processing"));
		await tick(1);
		expect(get(up)[0].state).toBe("processing");
		await tick(60);
		expect(get(up)[0].state).toBe("ready");
		expect(up.readyIds()).toEqual(["id-1"]);
		expect(summarize(get(up))).toEqual({ total: 1, ready: 1, waiting: 0, failed: 0, allReady: true });
	});

	it("an upload that answers ready needs no poll", async () => {
		const f = fakeTransport();
		const up = createAttachmentUploader({ transport: f.transport, previews: false });
		up.add([txt()]);
		f.uploads[0].resolve(meta("id-9", "ready"));
		await tick();
		expect(get(up)[0]).toMatchObject({ state: "ready", id: "id-9" });
	});

	it("marks a failed upload, and retry uploads again under the same key", async () => {
		const f = fakeTransport();
		const up = createAttachmentUploader({ transport: f.transport, previews: false });
		up.add([txt()]);
		const key = get(up)[0].key;
		f.uploads[0].reject(new Error("too big"));
		await tick();
		expect(get(up)[0]).toMatchObject({ state: "failed", error: "too big" });
		expect(summarize(get(up)).allReady).toBe(false);

		up.retry(key);
		expect(get(up)[0]).toMatchObject({ key, state: "uploading", progress: 0 });
		f.uploads[1].resolve(meta("id-2", "ready"));
		await tick();
		expect(get(up)[0].state).toBe("ready");
	});

	it("a processing failure keeps the server's reason; retry deletes that row first", async () => {
		const f = fakeTransport();
		const up = createAttachmentUploader({ transport: f.transport, previews: false, pollMs: 1 });
		up.add([txt()]);
		f.polls["id-3"] = ["failed"];
		f.uploads[0].resolve(meta("id-3", "processing"));
		await tick(20);
		expect(get(up)[0]).toMatchObject({ state: "failed", error: "unreadable" });
		up.retry(get(up)[0].key);
		expect(f.removed).toEqual(["id-3"]);
	});

	it("remove aborts an upload in flight and never surfaces it as failed", async () => {
		const f = fakeTransport();
		const up = createAttachmentUploader({ transport: f.transport, previews: false });
		up.add([txt()]);
		up.remove(get(up)[0].key);
		await tick();
		expect(f.uploads[0].aborted).toBe(true);
		expect(get(up)).toEqual([]);
		expect(f.removed).toEqual([]);
	});

	it("remove after upload DELETEs the server row and stops polling", async () => {
		const f = fakeTransport();
		let gets = 0;
		const orig = f.transport.get;
		f.transport.get = async (id) => { gets++; return orig(id); };
		const up = createAttachmentUploader({ transport: f.transport, previews: false, pollMs: 5 });
		up.add([txt()]);
		f.uploads[0].resolve(meta("id-4", "processing"));
		await tick(1);
		up.remove(get(up)[0].key);
		await tick(30);
		expect(f.removed).toEqual(["id-4"]);
		expect(gets).toBe(0);
	});

	it("clear forgets without deleting (the ids were sent); reset deletes", async () => {
		const f = fakeTransport();
		const up = createAttachmentUploader({ transport: f.transport, previews: false });
		up.add([txt("1.txt"), txt("2.txt")]);
		f.uploads[0].resolve(meta("id-5", "ready"));
		f.uploads[1].resolve(meta("id-6", "ready"));
		await tick();
		up.clear();
		expect(get(up)).toEqual([]);
		expect(f.removed).toEqual([]);

		up.add([txt()]);
		f.uploads[2].resolve(meta("id-7", "ready"));
		await tick();
		up.reset();
		expect(f.removed).toEqual(["id-7"]);
	});
});

describe("summarize", () => {
	it("counts waiting as anything not ready or failed", () => {
		const p = (state: PendingAttachment["state"]) => ({ state }) as PendingAttachment;
		expect(summarize([p("uploading"), p("processing"), p("ready"), p("failed")]))
			.toEqual({ total: 4, ready: 1, waiting: 2, failed: 1, allReady: false });
		expect(summarize([]).allReady).toBe(false);
	});
});
