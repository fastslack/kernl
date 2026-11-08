import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeAccountDir,
  clearClaudeLimits,
  getClaudeModelLimit,
  isClaudeModelLimited,
  pickClaudeRoute,
  rememberClaudeAccountDown,
  rememberClaudeLimit,
  setClaudeAccountResolver,
  setClaudePrimaryTokenProbe,
} from "../src/sdk/index.js";

const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5-1";
const NOW = Date.UTC(2026, 9, 31, 12);
const HOUR = 60 * 60 * 1000;

let xdg: string;
let savedXdg: string | undefined;

function connect(id: string) {
  const dir = claudeAccountDir(id, { XDG_CONFIG_HOME: xdg });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), "{}");
}

const hit = (limitType: string, resetsAt?: number) => ({ kind: "rate_limit" as const, limitType, resetsAt, detail: "x" });

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "claude-picker-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  setClaudePrimaryTokenProbe(() => false);
  setClaudeAccountResolver(() => [{ id: "A", label: "a" }, { id: "B", label: "b" }]);
  connect("A");
  connect("B");
  clearClaudeLimits();
});

afterEach(() => {
  clearClaudeLimits();
  setClaudeAccountResolver(null);
  setClaudePrimaryTokenProbe(null);
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(xdg, { recursive: true, force: true });
});

describe("pickClaudeRoute", () => {
  test("nothing limited: primary, requested model", () => {
    expect(pickClaudeRoute(OPUS, NOW)).toEqual({ accountId: "A", model: OPUS });
  });

  test("five_hour on A: B takes over", () => {
    rememberClaudeLimit(OPUS, hit("five_hour", NOW + HOUR), NOW, "A");
    expect(pickClaudeRoute(OPUS, NOW)).toEqual({ accountId: "B", model: OPUS });
  });

  test("five_hour on both: Fable is not blocked by the account-wide limit", () => {
    rememberClaudeLimit(OPUS, hit("five_hour", NOW + HOUR), NOW, "A");
    rememberClaudeLimit(OPUS, hit("five_hour", NOW + HOUR), NOW, "B");
    expect(pickClaudeRoute(OPUS, NOW)).toEqual({ accountId: "A", model: FABLE });
  });

  test("seven_day_opus on A only is model-specific", () => {
    rememberClaudeLimit(OPUS, hit("seven_day_opus", NOW + HOUR), NOW, "A");
    expect(pickClaudeRoute(OPUS, NOW)).toEqual({ accountId: "B", model: OPUS });
    expect(isClaudeModelLimited("claude-sonnet-5-5", NOW, "A")).toBe(false);
    expect(isClaudeModelLimited(OPUS, NOW, "A")).toBe(true);
  });

  test("an account whose session failed sits out until its TTL ends", () => {
    rememberClaudeLimit(OPUS, hit("five_hour", NOW + 2 * HOUR), NOW, "A");
    rememberClaudeAccountDown("B", NOW, HOUR);
    expect(pickClaudeRoute(OPUS, NOW)).toEqual({ accountId: "A", model: FABLE });
    expect(pickClaudeRoute(OPUS, NOW + HOUR)).toEqual({ accountId: "B", model: OPUS });
  });

  test("a limit lifts: back to the primary", () => {
    rememberClaudeLimit(OPUS, hit("five_hour", NOW + 1000), NOW, "A");
    expect(pickClaudeRoute(OPUS, NOW)?.accountId).toBe("B");
    expect(pickClaudeRoute(OPUS, NOW + 1001)?.accountId).toBe("A");
  });

  test("everything limited: null, and the no-account view reports the earliest reset", () => {
    for (const acc of ["A", "B"]) {
      rememberClaudeLimit(OPUS, hit("five_hour", NOW + (acc === "A" ? 2 : 1) * HOUR), NOW, acc);
      rememberClaudeLimit(FABLE, hit("seven_day_fable", NOW + 3 * HOUR), NOW, acc);
    }
    expect(pickClaudeRoute(OPUS, NOW)).toBeNull();
    const l = getClaudeModelLimit(OPUS, NOW);
    expect(l?.blockedUntil).toBe(NOW + HOUR);
  });

  test("limited on one account only: no-account view is null", () => {
    rememberClaudeLimit(OPUS, hit("five_hour", NOW + HOUR), NOW, "A");
    expect(getClaudeModelLimit(OPUS, NOW)).toBeNull();
    expect(getClaudeModelLimit(OPUS, NOW, "A")?.blockedUntil).toBe(NOW + HOUR);
  });

  test("hit without resetsAt blocks one hour on that account only", () => {
    rememberClaudeLimit(OPUS, { kind: "rate_limit", detail: "x" }, NOW, "A");
    expect(getClaudeModelLimit(OPUS, NOW, "A")?.blockedUntil).toBe(NOW + HOUR);
    expect(isClaudeModelLimited(OPUS, NOW, "B")).toBe(false);
  });

  test("disconnected accounts are skipped; unknown ids are ignored", () => {
    rmSync(claudeAccountDir("B", { XDG_CONFIG_HOME: xdg }), { recursive: true, force: true });
    rememberClaudeLimit(OPUS, hit("five_hour", NOW + HOUR), NOW, "A");
    rememberClaudeLimit(OPUS, hit("five_hour", NOW + HOUR), NOW, "ghost");
    expect(pickClaudeRoute(OPUS, NOW)).toEqual({ accountId: "A", model: FABLE });
    expect(getClaudeModelLimit(OPUS, NOW)?.blockedUntil).toBe(NOW + HOUR);
  });

  test("a hit seen while running a Fable model is stored under that model", () => {
    rememberClaudeLimit(FABLE, hit("seven_day", NOW + HOUR), NOW, "A");
    expect(isClaudeModelLimited(FABLE, NOW, "A")).toBe(true);
    expect(isClaudeModelLimited(OPUS, NOW, "A")).toBe(false);
  });

  test("a hit with no limitType is per model: another model on the account stays free", () => {
    rememberClaudeLimit(OPUS, { kind: "rate_limit", detail: "x", resetsAt: NOW + HOUR }, NOW, "A");
    expect(isClaudeModelLimited(OPUS, NOW, "A")).toBe(true);
    expect(isClaudeModelLimited("claude-sonnet-5-5", NOW, "A")).toBe(false);
  });

  test("the fallback is tried on the second account", () => {
    rememberClaudeLimit(OPUS, hit("five_hour", NOW + HOUR), NOW, "A");
    rememberClaudeLimit(OPUS, hit("five_hour", NOW + HOUR), NOW, "B");
    rememberClaudeLimit(FABLE, hit("seven_day_fable", NOW + HOUR), NOW, "A");
    expect(pickClaudeRoute(OPUS, NOW)).toEqual({ accountId: "B", model: FABLE });
  });
});
