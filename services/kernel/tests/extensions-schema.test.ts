import { describe, it, expect } from "vitest";
import {
  validateManifest,
  checkTypeConsistency,
} from "../src/modules/extensions/schema.js";

const baseValid = {
  $schema: "kernl://extension/v1",
  id: "com.example.weather",
  slug: "weather",
  name: "Weather Pro",
  version: "1.2.3",
  type: "module",
  description: "Advanced weather panels for Kernl.",
  author: "Example Corp",
  license: "MIT",
  category: "utility",
  backend: { entry: "backend/index.js" },
};

describe("extension manifest validator", () => {
  it("accepts a minimal valid module manifest", () => {
    const r = validateManifest(baseValid);
    expect(r.ok).toBe(true);
  });

  it("rejects bad semver", () => {
    const r = validateManifest({ ...baseValid, version: "not-a-version" });
    expect(r.ok).toBe(false);
  });

  it("rejects non-DNS id", () => {
    const r = validateManifest({ ...baseValid, id: "no-dots" });
    expect(r.ok).toBe(false);
  });

  it("rejects wrong $schema", () => {
    const r = validateManifest({ ...baseValid, $schema: "v0" });
    expect(r.ok).toBe(false);
  });

  it("rejects paid pricing without amount", () => {
    const r = validateManifest({
      ...baseValid,
      pricing: { amount_cents: 0, currency: "EUR", model: "one-time" },
    });
    expect(r.ok).toBe(false);
  });

  it("accepts free pricing with zero amount", () => {
    const r = validateManifest({
      ...baseValid,
      pricing: { amount_cents: 0, currency: "EUR", model: "free" },
    });
    expect(r.ok).toBe(true);
  });

  it("accepts module:{name} permission", () => {
    const r = validateManifest({
      ...baseValid,
      permissions: ["network", "module:trading", "read:contacts"],
    });
    expect(r.ok).toBe(true);
  });

  it("type=module without backend fails type-consistency", () => {
    const noBackend = { ...baseValid };
    delete (noBackend as { backend?: unknown }).backend;
    const r = validateManifest(noBackend);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const errs = checkTypeConsistency(r.manifest);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0]).toContain("type=module");
    }
  });

  it("type=theme without theme block fails type-consistency", () => {
    const r = validateManifest({
      ...baseValid,
      type: "theme",
      backend: undefined,
    });
    if (r.ok) {
      const errs = checkTypeConsistency(r.manifest);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0]).toContain("type=theme");
    }
  });

  it("accepts full-featured manifest", () => {
    const r = validateManifest({
      ...baseValid,
      tags: ["weather", "dashboard"],
      kernel_min: "1.0.0",
      dependencies: ["com.example.base"],
      frontend: {
        nav: { group: "dashboard", label: "Weather", icon: "🌦️", order: 50 },
        descriptor: "frontend/descriptor.json",
      },
      permissions: ["network", "read:events"],
      pricing: { amount_cents: 999, currency: "EUR", model: "one-time", sku: "WEATHER-PRO" },
      integrity: {
        sha256: "a".repeat(64),
      },
    });
    expect(r.ok).toBe(true);
  });
});
