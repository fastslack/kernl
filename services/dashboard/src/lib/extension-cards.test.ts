/**
 * The marketplace card decides what a person is offered and at what price, so
 * its edge cases are the ones that matter: a paid item with no resolvable
 * price must never read as "Free", and a Buy button must not be live when the
 * store cannot be reached.
 */

import { describe, it, expect } from "bun:test";
import {
  isInstalledStatus,
  categoryLabel,
  fmtMoney,
  priceParts,
  priceBadge,
  fmtPrice,
  fmtRelative,
  actionForCard,
  type PricedCard,
} from "./extension-cards.js";

const card = (over: Partial<PricedCard> = {}): PricedCard => ({
  slug: "thing",
  status: "available",
  priceCents: 0,
  currency: "USD",
  priceId: null,
  updateAvailable: false,
  version: "1.0.0",
  ...over,
});

describe("isInstalledStatus", () => {
  it("covers the four states that mean it is already here", () => {
    for (const s of ["installed", "active", "disabled", "error"]) {
      expect(isInstalledStatus(s)).toBe(true);
    }
  });

  it("is false for the storefront states", () => {
    for (const s of ["for_sale", "owned", "available"]) {
      expect(isInstalledStatus(s)).toBe(false);
    }
  });
});

describe("categoryLabel", () => {
  it("humanises a slug", () => {
    expect(categoryLabel("web-intel")).toBe("Web intel");
    expect(categoryLabel("home_automation")).toBe("Home automation");
  });

  it("names the empty category", () => {
    expect(categoryLabel("")).toBe("Uncategorised");
  });
});

describe("fmtMoney", () => {
  it("says Free at zero", () => {
    expect(fmtMoney(0, "USD")).toBe("Free");
  });

  it("drops the decimals on a whole amount and keeps them otherwise", () => {
    expect(fmtMoney(1000, "USD")).not.toContain(".00");
    expect(fmtMoney(1050, "USD")).toContain("50");
  });

  it("falls back to a plain string for an unknown currency", () => {
    expect(fmtMoney(1000, "NOTACURRENCY")).toBe("NOTACURRENCY 10");
  });
});

describe("priceParts", () => {
  it("splits the symbol from the digits", () => {
    const { sym, num } = priceParts(1000, "USD");
    expect(num.startsWith("10")).toBe(true);
    expect(sym).not.toMatch(/\d/);
  });

  it("puts everything in num when there is no symbol", () => {
    expect(priceParts(0, "USD")).toEqual({ sym: "Free", num: "" });
  });
});

describe("priceBadge", () => {
  it("marks what you already own", () => {
    expect(priceBadge({ status: "owned", priceCents: 900, currency: "USD" })).toBe("✓ Owned");
  });

  it("shows the price when there is one", () => {
    expect(priceBadge({ status: "for_sale", priceCents: 900, currency: "USD" })).toContain("9");
  });

  it("never calls a paid item Free when the price is missing", () => {
    expect(priceBadge({ status: "for_sale", priceCents: 0, currency: "USD" })).toBe("PAID");
  });
});

describe("fmtPrice", () => {
  it("reads FREE with no pricing or an explicit free model", () => {
    expect(fmtPrice(null)).toBe("FREE");
    expect(fmtPrice({ pricing: { model: "free", amount_cents: 0, currency: "USD" } })).toBe("FREE");
  });

  it("marks a subscription per month", () => {
    expect(fmtPrice({ pricing: { model: "subscription", amount_cents: 900, currency: "EUR" } })).toBe("EUR 9/mo");
  });

  it("prints a one-off purchase without a suffix", () => {
    expect(fmtPrice({ pricing: { model: "one_time", amount_cents: 2500, currency: "USD" } })).toBe("USD 25");
  });
});

describe("fmtRelative", () => {
  it("says never when it has not run", () => {
    expect(fmtRelative(null)).toBe("never");
  });

  it("walks up the units", () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(fmtRelative(ago(5_000))).toBe("just now");
    expect(fmtRelative(ago(120_000))).toBe("2m ago");
    expect(fmtRelative(ago(7_200_000))).toBe("2h ago");
    expect(fmtRelative(ago(172_800_000))).toBe("2d ago");
  });
});

describe("actionForCard", () => {
  it("reports an in-flight purchase before anything else", () => {
    expect(actionForCard(card({ status: "for_sale" }), { purchase: { state: "pending" } }))
      .toEqual({ label: "Waiting for payment…", disabled: true, kind: "buy" });
    expect(actionForCard(card(), { purchase: { state: "paid" } }))
      .toEqual({ label: "Installing…", disabled: true, kind: "buy" });
  });

  it("reports an install already running", () => {
    expect(actionForCard(card(), { installing: true }))
      .toEqual({ label: "Installing…", disabled: true, kind: "get" });
  });

  it("offers the update when one is available", () => {
    expect(actionForCard(card({ updateAvailable: true, version: "2.1.0" })))
      .toEqual({ label: "Update to v2.1.0", disabled: false, kind: "update" });
  });

  it("sends a paid item with no usable price to the pricing page", () => {
    const noPriceId = actionForCard(card({ status: "for_sale", priceCents: 900, priceId: null }));
    expect(noPriceId).toEqual({ label: "See pricing", disabled: false, kind: "pricing" });

    const noAmount = actionForCard(card({ status: "for_sale", priceCents: 0, priceId: "price_1" }));
    expect(noAmount.kind).toBe("pricing");
  });

  it("offers Buy only while the store is reachable", () => {
    const vm = card({ status: "for_sale", priceCents: 900, priceId: "price_1" });
    expect(actionForCard(vm, { storeReachable: true }).disabled).toBe(false);
    expect(actionForCard(vm, { storeReachable: false }).disabled).toBe(true);
    expect(actionForCard(vm, { storeReachable: true }).label).toContain("Buy");
  });

  it("installs what you own or what is simply available", () => {
    expect(actionForCard(card({ status: "owned" })).kind).toBe("get");
    expect(actionForCard(card({ status: "available" })).kind).toBe("get");
  });

  it("falls back to Manage for anything already installed", () => {
    expect(actionForCard(card({ status: "active" })))
      .toEqual({ label: "Manage", disabled: false, kind: "manage" });
  });
});
