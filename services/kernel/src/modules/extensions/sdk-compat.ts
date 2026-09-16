/**
 * Does an extension target the SDK this kernel speaks?
 *
 * An extension with a backend imports the kernel only through
 * `@kernl/extension-sdk` and declares the major it was built against as
 * `sdk` in its manifest. A bundle built for another major — or from before
 * the SDK existed — carries its own copies of kernel code and must be rebuilt,
 * so it is refused at install and at load rather than failing somewhere later.
 */

import { SDK_MAJOR } from "../../sdk/host.js";
import type { ExtensionManifest } from "./schema.js";

/** Why the manifest is incompatible, or null when it is fine. */
export function sdkIncompatibility(manifest: Pick<ExtensionManifest, "slug" | "backend"> & { sdk?: number }): string | null {
  if (!manifest.backend) return null;
  if (manifest.sdk === SDK_MAJOR) return null;
  const target = manifest.sdk === undefined ? "no SDK version" : `SDK v${manifest.sdk}`;
  return `Extension ${manifest.slug} targets ${target}; this kernel runs SDK v${SDK_MAJOR} — rebuild it`;
}

export function assertSdkCompatible(manifest: Pick<ExtensionManifest, "slug" | "backend"> & { sdk?: number }): void {
  const reason = sdkIncompatibility(manifest);
  if (reason) throw new Error(reason);
}
