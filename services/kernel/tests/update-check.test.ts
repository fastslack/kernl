/**
 * The update check: version ordering, and what it does with a failure.
 *
 * `checkForUpdate` takes an injectable fetch precisely so this can be tested
 * without a network, and until now nothing used it. The caching behaviour is
 * the part worth pinning: a check that caches a FAILURE as though it were an
 * answer hides a published release for six hours, and the user has no way to
 * know that is what happened.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  checkForUpdate,
  compareVersions,
  resetUpdateCache,
  githubHeaders,
  type FetchLike,
} from "../src/core/update/check.js";

/** A fetch that answers however the test says, and counts the calls. */
function fakeFetch(
  answers: { status: number; body?: unknown; throws?: boolean }[],
): FetchLike & { calls: { url: string; headers?: Record<string, string> }[] } {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  let i = 0;
  const f = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    if (a.throws) throw new Error("network down");
    return {
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      json: async () => a.body,
    };
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

beforeEach(() => {
  resetUpdateCache();
});

describe("compareVersions", () => {
  it("orders by number, field by field", () => {
    expect(compareVersions("0.2.6", "0.3.0")).toBe(-1);
    expect(compareVersions("0.3.0", "0.2.6")).toBe(1);
    expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
    // Not a string comparison: 10 is greater than 9.
    expect(compareVersions("0.2.9", "0.2.10")).toBe(-1);
  });

  it("puts a prerelease BEFORE the release it leads to", () => {
    // The rule everyone gets backwards. Wrong, it either announces an update
    // to the version you already run or hides the real one.
    expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.2.0-rc.1")).toBe(1);
    expect(compareVersions("0.2.0-rc.1", "0.2.0-rc.2")).toBe(-1);
  });

  it("tolerates a leading v and refuses to guess at nonsense", () => {
    expect(compareVersions("v0.2.6", "0.3.0")).toBe(-1);
    expect(compareVersions("not-a-version", "0.3.0")).toBe(0);
  });
});

describe("checkForUpdate", () => {
  it("identifies itself to GitHub", () => {
    // Unauthenticated api.github.com allows 60 requests an hour per IP, shared
    // by everyone behind the same NAT, and asks callers to say who they are.
    const h = githubHeaders();
    expect(h["User-Agent"]).toContain("Kernl");
    expect(h.Accept).toContain("github");
  });

  it("reports a newer release, with the page to read first", async () => {
    const fetchImpl = fakeFetch([
      { status: 200, body: { tag_name: "v99.0.0", html_url: "https://example/releases/v99" } },
    ]);
    const s = await checkForUpdate({ fetchImpl });
    expect(s.latest).toBe("99.0.0");
    expect(s.updateAvailable).toBe(true);
    expect(s.url).toBe("https://example/releases/v99");
    expect(s.checkedAt).not.toBeNull();
    expect(fetchImpl.calls[0]?.headers?.["User-Agent"]).toContain("Kernl");
  });

  it("caches a good answer instead of asking again", async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { tag_name: "v99.0.0" } }]);
    await checkForUpdate({ fetchImpl });
    await checkForUpdate({ fetchImpl });
    expect(fetchImpl.calls.length).toBe(1);
  });

  it("asks again anyway when the user clicks Check for updates", async () => {
    // A button that answers from a cache is a button that lies about having
    // checked.
    const fetchImpl = fakeFetch([{ status: 200, body: { tag_name: "v99.0.0" } }]);
    await checkForUpdate({ fetchImpl });
    await checkForUpdate({ fetchImpl, fresh: true });
    expect(fetchImpl.calls.length).toBe(2);
  });

  it("does NOT cache a network failure for six hours", async () => {
    // The regression this test exists for: one flaky moment used to hide a
    // published release until the TTL expired.
    const fetchImpl = fakeFetch([{ throws: true, status: 0 }]);
    const first = await checkForUpdate({ fetchImpl });
    expect(first.reason).toBe("offline");
    expect(first.checkedAt).toBeNull();

    // A minute has not passed, but a failure is cheap to retry and worth
    // retrying — the next caller must not be served the failure as an answer.
    await new Promise((r) => setTimeout(r, 5));
    await checkForUpdate({ fetchImpl, fresh: true });
    expect(fetchImpl.calls.length).toBe(2);
  });

  it("says rate-limited when that is what happened", async () => {
    // 403 from GitHub is not "offline", and reporting it as such sends the
    // user looking at their wifi.
    const fetchImpl = fakeFetch([{ status: 403 }]);
    const s = await checkForUpdate({ fetchImpl });
    expect(s.reason).toBe("rate-limited");
    expect(s.updateAvailable).toBe(false);
  });

  it("treats a repository with no releases as an answer, not a fault", async () => {
    const fetchImpl = fakeFetch([{ status: 404 }]);
    const s = await checkForUpdate({ fetchImpl });
    expect(s.reason).toBe("no-releases");
    expect(s.checkedAt).not.toBeNull();
  });

  it("never announces an update when the check could not answer", async () => {
    for (const answer of [{ status: 500 }, { status: 403 }, { throws: true, status: 0 }]) {
      resetUpdateCache();
      const s = await checkForUpdate({ fetchImpl: fakeFetch([answer]) });
      expect(s.updateAvailable).toBe(false);
      expect(s.latest).toBeNull();
    }
  });
});
