import { describe, it, expect } from "bun:test";
import { accountDetail, accountIdent, accountState, accountTitle, formatUntil, isClaudeConnected, modelFamily, withClaudeAccounts, type ClaudeAccount } from "./claude-accounts.js";
import type { CatalogProvider } from "./llm-connect.js";

const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();
const at = (days: number, h: number) => new Date(2026, 9, 31 + days, h, 0, 0).toISOString();
const acc = (over: Partial<ClaudeAccount> = {}): ClaudeAccount => ({
  id: "a", label: "", connected: true, primary: false, identity: null, down: false, limits: [], ...over,
});

describe("accountState", () => {
  it("is ok with no limits and ignores limits that already ended", () => {
    expect(accountState(acc(), NOW)).toEqual({ kind: "ok" });
    expect(accountState(acc({ limits: [{ model: "*", until: at(0, 9), detail: "" }] }), NOW)).toEqual({ kind: "ok" });
  });
  it("puts not connected first, then a dead session, then limits", () => {
    const limits = [{ model: "*", until: at(0, 15), detail: "" }];
    expect(accountState(acc({ connected: false, down: true, limits }), NOW).kind).toBe("disconnected");
    expect(accountState(acc({ down: true, limits }), NOW).kind).toBe("down");
    expect(accountState(acc({ limits }), NOW)).toEqual({ kind: "limited", model: null, until: at(0, 15) });
  });
  it("prefers the whole-account limit, else the model limit that ends first", () => {
    const limits = [
      { model: "claude-opus-5-5", until: at(2, 15), detail: "" },
      { model: "claude-sonnet-5", until: at(0, 18), detail: "" },
    ];
    expect(accountState(acc({ limits }), NOW)).toEqual({ kind: "limited", model: "Sonnet", until: at(0, 18) });
    const withAll = [...limits, { model: "*", until: at(1, 9), detail: "" }];
    expect(accountState(acc({ limits: withAll }), NOW)).toEqual({ kind: "limited", model: null, until: at(1, 9) });
  });
});

describe("formatUntil", () => {
  it("shows only the time for today and adds the weekday for other days", () => {
    expect(formatUntil(at(0, 15), NOW, "es")).toMatch(/^15:00$/);
    expect(formatUntil(at(2, 15), NOW, "es")).toMatch(/^\p{L}+ 15:00$/u);
  });
});

describe("labels", () => {
  it("names a model by its family", () => {
    expect(modelFamily("claude-opus-5-5")).toBe("Opus");
    expect(modelFamily("gpt-5")).toBe("gpt-5");
  });
  it("titles with the label, else the email, else leaves the numbering to the view", () => {
    const identity = { email: "me@x.com", organizationName: "Acme" };
    expect(accountTitle(acc({ label: "Trabajo", identity })).name).toBe("Trabajo");
    expect(accountTitle(acc({ identity })).name).toBe("me@x.com");
    expect(accountTitle(acc()).unnamed).toBe(true);
  });
  it("does not repeat the email already used as the title", () => {
    const identity = { email: "me@x.com", organizationName: "Acme" };
    expect(accountDetail(acc({ label: "Trabajo", identity }))).toBe("me@x.com · Acme");
    expect(accountDetail(acc({ identity }))).toBe("Acme");
  });
});

describe("withClaudeAccounts", () => {
  const prov = (slug: string) => ({ slug, name: slug, connected: true }) as CatalogProvider;
  const rows = [prov("nvidia"), prov("claude-code"), prov("ollama")];

  it("leaves the rows alone with no accounts (old kernel / 404)", () => {
    const out = withClaudeAccounts(rows, []);
    expect(out.map((l) => l.key)).toEqual(["nvidia", "claude-code", "ollama"]);
    expect(out.every((l) => l.account === null && !l.extra && !l.multi)).toBe(true);
  });
  it("one account: the Claude Code row carries it, no chip, no extra rows", () => {
    const out = withClaudeAccounts(rows, [acc({ id: "a", primary: true })]);
    expect(out.map((l) => l.key)).toEqual(["nvidia", "claude-code", "ollama"]);
    expect(out[1].account?.id).toBe("a");
    expect(out[1].multi).toBe(false);
  });
  it("2+ accounts: the others follow the Claude Code row in rotation order", () => {
    const out = withClaudeAccounts(rows, [acc({ id: "a" }), acc({ id: "b" }), acc({ id: "c" })]);
    expect(out.map((l) => l.key)).toEqual(["nvidia", "claude-code", "claude-code:b", "claude-code:c", "ollama"]);
    expect(out.filter((l) => l.extra).map((l) => l.index)).toEqual([1, 2]);
    expect(out[1].multi && out[2].multi).toBe(true);
    expect(out[1].extra).toBe(false);
  });
  it("adds nothing when Claude Code is not among the connected rows", () => {
    const out = withClaudeAccounts([prov("nvidia")], [acc({ id: "a" }), acc({ id: "b" })]);
    expect(out.map((l) => l.key)).toEqual(["nvidia"]);
  });
});

describe("accountIdent", () => {
  it("joins email and organization, and is empty without identity", () => {
    expect(accountIdent(acc({ label: "Work", identity: { email: "a@b.c", organizationName: "Org" } }))).toBe("a@b.c · Org");
    expect(accountIdent(acc({ identity: { organizationName: "Org" } }))).toBe("Org");
    expect(accountIdent(acc())).toBe("");
  });
});

describe("isClaudeConnected", () => {
  const p = (slug: string, connected: boolean) => ({ slug, connected }) as CatalogProvider;
  it("is true only for a connected claude-code entry of the catalog just fetched", () => {
    expect(isClaudeConnected([p("nvidia", true), p("claude-code", true)])).toBe(true);
    expect(isClaudeConnected([p("claude-code", false)])).toBe(false);
    expect(isClaudeConnected([])).toBe(false);
  });
});
