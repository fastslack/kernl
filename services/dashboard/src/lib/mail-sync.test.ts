import { describe, it, expect } from "bun:test";
import { bannerFor, isAuthError, summarize, nextPollMs, type AccountSync, type FetchStatus } from "./mail-sync.js";
import enDict from "./i18n/mail-sync.en.js";
import esDict from "./i18n/mail-sync.es.js";

const T = "2026-10-02T12:00:00.000Z";
const imap = (stored: number, fetch: FetchStatus | null, id = "i1"): AccountSync =>
  ({ account_id: id, email: `${id}@vps.org`, label: id, provider: "imap_smtp", stored, fetch });

describe("bannerFor", () => {
  it("says 'waiting' before the fetcher ever reached the account", () => {
    expect(bannerFor(imap(0, null))?.kind).toBe("waiting");
  });

  it("says 'connecting' until the server listed the messages", () => {
    expect(bannerFor(imap(0, { state: "fetching", started_at: T }))?.kind).toBe("connecting");
  });

  it("shows download progress on the first pass", () => {
    expect(bannerFor(imap(3, { state: "fetching", started_at: T, on_wire: 20, done: 5 }))).toEqual(
      { kind: "downloading", tone: "progress", percent: 25 },
    );
  });

  it("stays silent on a routine re-check of a mailbox that already has mail", () => {
    expect(bannerFor(imap(12, { state: "fetching", started_at: T, last_success_at: T, on_wire: 20, done: 1 }))).toBeNull();
  });

  it("keeps an empty mailbox 'empty' during a routine re-check, not 'downloading'", () => {
    expect(bannerFor(imap(0, { state: "fetching", started_at: T, last_success_at: T, finished_at: T }))?.kind).toBe("empty");
    expect(summarize([imap(0, { state: "fetching", started_at: T, last_success_at: T }, "z")]).pending).toEqual([]);
  });

  it("reports errors even when some mail is already stored", () => {
    expect(bannerFor(imap(12, { state: "error", started_at: T, error: "AUTHENTICATIONFAILED" }))?.kind).toBe("error");
  });

  it("tells an empty server inbox from a pending download", () => {
    expect(bannerFor(imap(0, { state: "ok", started_at: T, finished_at: T, last_success_at: T }))?.kind).toBe("empty");
    expect(bannerFor(imap(4, { state: "ok", started_at: T, finished_at: T, last_success_at: T }))).toBeNull();
  });

  it("covers Gmail accounts with nothing synced yet", () => {
    expect(bannerFor({ ...imap(0, null), provider: "gmail" })?.kind).toBe("gmail_waiting");
    expect(bannerFor({ ...imap(5, null), provider: "gmail" })).toBeNull();
  });
});

describe("isAuthError", () => {
  it("spots credential failures", () => {
    expect(isAuthError("AUTHENTICATIONFAILED Authentication failed.")).toBe(true);
    expect(isAuthError("Invalid credentials (Failure)")).toBe(true);
    expect(isAuthError("connect ETIMEDOUT")).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe("summarize / nextPollMs", () => {
  const accounts = [
    imap(0, null, "a"),
    imap(2, { state: "fetching", started_at: T, on_wire: 20, done: 2 }, "b"),
    imap(0, { state: "error", started_at: T, error: "auth failed" }, "c"),
    imap(9, { state: "ok", started_at: T, last_success_at: T }, "d"),
    { ...imap(30, null, "g"), provider: "gmail" },
  ];

  it("splits IMAP accounts into pending, failing and ready", () => {
    const s = summarize(accounts);
    expect(s.pending.map((a) => a.account_id)).toEqual(["a", "b"]);
    expect(s.failing.map((a) => a.account_id)).toEqual(["c"]);
    expect(s.ready).toBe(1);
  });

  it("polls fast only while something is downloading", () => {
    expect(nextPollMs(accounts)).toBe(4000);
    expect(nextPollMs([accounts[3]])).toBe(60000);
  });
});

describe("mail-sync strings", () => {
  const en: Record<string, string> = enDict;
  const es: Record<string, string> = esDict;

  it("en and es define the same keys, none empty", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    expect([...Object.values(en), ...Object.values(es)].filter((v) => v.trim() === "")).toEqual([]);
  });

  it("every banner kind has a title", () => {
    for (const k of ["waiting", "connecting", "downloading", "error", "empty"]) expect(en[`mailsync.${k}.title`]).toBeDefined();
    expect(en["mailsync.gmail.title"]).toBeDefined();
  });

  it("es keeps every placeholder en uses", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of Object.keys(en)) expect(ph(es[k])).toEqual(ph(en[k]));
  });
});
