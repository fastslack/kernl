import { describe, it, expect } from "bun:test";
import { FETCHER_HANDLER, newCountFrom, pickFetcher, runStillGoing } from "./mail-fetch.js";

describe("pickFetcher", () => {
  const agents = [
    { id: "a1", name: "Email Triage", builtin_handler: "comms:email-triage" },
    { id: "a2", name: "IMAP Fetcher", builtin_handler: FETCHER_HANDLER },
  ];

  it("finds the fetcher by its handler, not its name", () => {
    // Operators rename agents; the handler is what the comms extension registers.
    expect(pickFetcher(agents)).toBe("a2");
    expect(pickFetcher([{ id: "x", name: "IMAP Fetcher", builtin_handler: "" }])).toBeNull();
  });

  it("accepts the list wrapped in { agents }", () => {
    expect(pickFetcher({ agents })).toBe("a2");
  });

  it("answers null for anything that is not a list of agents", () => {
    expect(pickFetcher(null)).toBeNull();
    expect(pickFetcher({ error: "Unauthorized" })).toBeNull();
    expect(pickFetcher([null, 3, "x"])).toBeNull();
  });
});

describe("runStillGoing", () => {
  it("waits on unfinished runs only", () => {
    expect(runStillGoing("running")).toBe(true);
    expect(runStillGoing("pending")).toBe(true);
    expect(runStillGoing("completed")).toBe(false);
    expect(runStillGoing("failed")).toBe(false);
    expect(runStillGoing(undefined)).toBe(false);
  });
});

describe("newCountFrom", () => {
  it("reads the count off the fetcher's summary", () => {
    // Verbatim shape of comms:inbox-fetch's return value.
    expect(newCountFrom("Inbox fetch — 3 new from 2 account(s)\na@b: +3 new (40 on wire)")).toBe(3);
    expect(newCountFrom("Inbox fetch — 0 new from 1 account(s)\na@b: +0 new (40 on wire)")).toBe(0);
  });

  it("does not guess when the run said something else", () => {
    expect(newCountFrom("No IMAP/Gmail accounts configured — nothing to fetch.")).toBeNull();
    expect(newCountFrom("")).toBeNull();
  });
});
