/**
 * The in-dashboard purchase state machine.
 *
 * These tests exist because the failure modes here are the ones that cost real
 * money and real trust: a transient network error must not abandon a paid
 * purchase, and a failed install must never be reported as a failed payment.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { storeMigrations } from "../src/modules/store/migrations.js";
import { CheckoutService } from "../src/modules/store/checkout-service.js";
import { advanceCheckout } from "../src/modules/store/purchase-flow.js";

const STORE = "https://store.example";

function licenseStub(opts?: { rejectSet?: boolean }) {
  const applied: string[] = [];
  return {
    applied,
    set: async (jwt: string) => {
      if (opts?.rejectSet) throw new Error("signature mismatch");
      applied.push(jwt);
      return { status: "valid" as const };
    },
    jwt: () => applied[applied.length - 1] ?? null,
  };
}

/** A store that answers by-session with `pending` until flipped to ready. */
function sessionStore(state: { ready: boolean; throws?: boolean }) {
  return (async () => {
    if (state.throws) throw new Error("ECONNREFUSED");
    if (!state.ready) {
      return new Response(JSON.stringify({ state: "pending", error: "not yet" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        state: "ready",
        sku: "pro",
        features: ["pro:tv-station"],
        granted_features: ["pro:tv-station"],
        expires_at: 9_999_999_999,
        jwt: "JWT-FROM-STORE",
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("advanceCheckout", () => {
  let db: InstanceType<typeof Database>;
  let checkouts: CheckoutService;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "store", storeMigrations);
    checkouts = new CheckoutService(db);
  });

  function open(slug = "tv-station") {
    return checkouts.create({
      sessionId: "cs_test_1",
      slug,
      priceId: "price_tv",
      checkoutUrl: "https://checkout.stripe.com/x",
    });
  }

  test("stays pending while the buyer hasn't paid", async () => {
    const row = open();
    const state = { ready: false };
    const out = await advanceCheckout(row, {
      storeUrl: STORE,
      license: licenseStub(),
      checkouts,
      install: async () => { throw new Error("must not install"); },
      fetchImpl: sessionStore(state),
    });
    expect(out.state).toBe("pending");
  });

  test("a network error while claiming keeps the purchase alive", async () => {
    const row = open();
    const out = await advanceCheckout(row, {
      storeUrl: STORE,
      license: licenseStub(),
      checkouts,
      install: async () => { throw new Error("must not install"); },
      fetchImpl: sessionStore({ ready: true, throws: true }),
    });
    // The money may already have moved — abandoning here would be the worst
    // possible behaviour.
    expect(out.state).toBe("pending");
    expect(out.error).toBe("");
  });

  test("payment → license applied → bundle installed → done", async () => {
    const row = open();
    const license = licenseStub();
    const installed: string[] = [];

    const deps = {
      storeUrl: STORE,
      license,
      checkouts,
      install: async (slug: string) => { installed.push(slug); },
      fetchImpl: sessionStore({ ready: true }),
    };

    // One advance claims + applies the license.
    const paid = await advanceCheckout(row, deps);
    expect(paid.state).toBe("done");
    expect(license.applied).toEqual(["JWT-FROM-STORE"]);
    expect(installed).toEqual(["tv-station"]);
  });

  test("a failed install reports the purchase as completed, not lost", async () => {
    const row = open();
    const out = await advanceCheckout(row, {
      storeUrl: STORE,
      license: licenseStub(),
      checkouts,
      install: async () => { throw new Error("no disk space"); },
      fetchImpl: sessionStore({ ready: true }),
    });

    expect(out.state).toBe("failed");
    expect(out.error).toContain("Purchase completed");
    expect(out.error).toContain("your license is installed");
    expect(out.error).toContain("no disk space");
    expect(out.error).toContain("Retry the install");
  });

  test("a license this kernel can't verify is terminal and says where to go", async () => {
    const row = open();
    const out = await advanceCheckout(row, {
      storeUrl: STORE,
      license: licenseStub({ rejectSet: true }),
      checkouts,
      install: async () => { throw new Error("must not install"); },
      fetchImpl: sessionStore({ ready: true }),
    });

    expect(out.state).toBe("failed");
    expect(out.error).toContain("Payment went through");
    expect(out.error).toContain("support@lifekernl.com");
  });

  test("done and failed rows are inert", async () => {
    const row = open();
    checkouts.setState(row.session_id, "done");
    const done = checkouts.get(row.session_id)!;
    const out = await advanceCheckout(done, {
      storeUrl: STORE,
      license: licenseStub(),
      checkouts,
      install: async () => { throw new Error("must not install"); },
      fetchImpl: sessionStore({ ready: true }),
    });
    expect(out.state).toBe("done");
  });

  test("an expired claim window ends the purchase", async () => {
    open();
    // Force the window shut.
    db.prepare("UPDATE store_checkouts SET claim_expires_at = ? WHERE session_id = ?")
      .run("2000-01-01T00:00:00.000Z", "cs_test_1");
    const stale = checkouts.get("cs_test_1")!;

    const out = await advanceCheckout(stale, {
      storeUrl: STORE,
      license: licenseStub(),
      checkouts,
      install: async () => { throw new Error("must not install"); },
      fetchImpl: sessionStore({ ready: true }),
    });
    expect(out.state).toBe("failed");
    expect(out.error).toContain("expired");
  });
});

describe("CheckoutService", () => {
  let db: InstanceType<typeof Database>;
  let checkouts: CheckoutService;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "store", storeMigrations);
    checkouts = new CheckoutService(db);
  });

  test("pendingForSlug lets a double-clicked Buy resume instead of double-charging", () => {
    checkouts.create({ sessionId: "cs_a", slug: "tv-station", priceId: "p", checkoutUrl: "u" });
    const found = checkouts.pendingForSlug("tv-station");
    expect(found?.session_id).toBe("cs_a");
    expect(checkouts.pendingForSlug("moneyiq")).toBeNull();
  });

  test("finished checkouts are no longer resumable", () => {
    checkouts.create({ sessionId: "cs_a", slug: "tv-station", priceId: "p", checkoutUrl: "u" });
    checkouts.setState("cs_a", "done");
    expect(checkouts.pendingForSlug("tv-station")).toBeNull();
    expect(checkouts.listOpen()).toHaveLength(0);
  });

  test("listOpen drives resume-after-reload", () => {
    checkouts.create({ sessionId: "cs_a", slug: "tv-station", priceId: "p", checkoutUrl: "u" });
    checkouts.create({ sessionId: "cs_b", slug: "sleep", priceId: "p", checkoutUrl: "u" });
    checkouts.setState("cs_b", "paid");
    expect(checkouts.listOpen().map((r) => r.session_id).sort()).toEqual(["cs_a", "cs_b"]);
  });

  test("pruneExpired only drops unpaid rows past their window", () => {
    checkouts.create({ sessionId: "cs_old", slug: "tv-station", priceId: "p", checkoutUrl: "u" });
    checkouts.create({ sessionId: "cs_paid", slug: "sleep", priceId: "p", checkoutUrl: "u" });
    db.prepare("UPDATE store_checkouts SET claim_expires_at = ?").run("2000-01-01T00:00:00.000Z");
    checkouts.setState("cs_paid", "paid");

    expect(checkouts.pruneExpired()).toBe(1);
    expect(checkouts.get("cs_old")).toBeNull();
    expect(checkouts.get("cs_paid")).not.toBeNull();
  });
});
