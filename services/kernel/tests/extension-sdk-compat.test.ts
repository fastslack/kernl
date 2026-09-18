import { describe, it, expect } from "bun:test";
import { sdkIncompatibility, assertSdkCompatible } from "../src/modules/extensions/sdk-compat.js";
import { SDK_MAJOR } from "../src/sdk/host.js";
import { validateManifest } from "../src/modules/extensions/schema.js";

const backend = { entry: "backend/entry.js" };

describe("extension SDK compatibility", () => {
  it("accepts a backend built for this SDK major", () => {
    expect(sdkIncompatibility({ slug: "tasks", backend, sdk: SDK_MAJOR })).toBeNull();
  });

  it("ignores extensions without a backend", () => {
    expect(sdkIncompatibility({ slug: "theme-dark", backend: undefined })).toBeNull();
  });

  it("refuses a backend that declares no SDK version", () => {
    expect(sdkIncompatibility({ slug: "tasks", backend })).toBe(
      `Extension tasks targets no SDK version; this kernel runs SDK v${SDK_MAJOR} — rebuild it`,
    );
  });

  it("refuses a backend built for another major", () => {
    expect(() => assertSdkCompatible({ slug: "tasks", backend, sdk: SDK_MAJOR + 1 })).toThrow(
      `Extension tasks targets SDK v${SDK_MAJOR + 1}; this kernel runs SDK v${SDK_MAJOR} — rebuild it`,
    );
  });

  it("lets the manifest schema carry the sdk field", () => {
    const result = validateManifest({
      $schema: "kernl://extension/v1",
      id: "com.kernl.sdk-probe",
      slug: "sdk-probe",
      name: "SDK probe",
      version: "1.0.0",
      type: "module",
      description: "probe",
      author: "Kernl",
      license: "Apache-2.0",
      category: "system",
      sdk: SDK_MAJOR,
      backend,
    });

    expect(result.ok).toBe(true);
  });
});
