// services/kernel/tests/edition-schema.test.ts
import { describe, it, expect } from "bun:test";
import { validateManifest } from "../src/modules/extensions/schema.js";

const base = {
  $schema: "kernl://extension/v1",
  id: "com.example.crm",
  slug: "crm-x",
  name: "CRM X",
  version: "1.0.0",
  type: "module",
  description: "d",
  author: "a",
  license: "MIT",
  category: "people",
  backend: { entry: "backend/index.js" },
};

describe("manifest audience", () => {
  it("is optional", () => {
    const r = validateManifest(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.audience).toBeUndefined();
  });

  it("accepts personal, business, or both", () => {
    for (const audience of [["personal"], ["business"], ["personal", "business"]]) {
      const r = validateManifest({ ...base, audience });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.manifest.audience).toEqual(audience as ("personal" | "business")[]);
    }
  });

  it("rejects an unknown audience instead of treating it as both", () => {
    const r = validateManifest({ ...base, audience: ["corporate"] });
    expect(r.ok).toBe(false);
  });

  it("rejects duplicates", () => {
    const r = validateManifest({ ...base, audience: ["business", "business"] });
    expect(r.ok).toBe(false);
  });
});
