/**
 * Install-time enforcement for paid extensions.
 *
 * Two independent gates, both decided here as pure functions so they're easy to
 * test and reason about (the service wires them into install/enable):
 *
 *   • authenticity — a bundle carrying a signature must verify against the
 *     embedded license public key; a PAID bundle MUST carry a valid signature.
 *     Blocks tampered or forged/pirated paid bundles at install time.
 *   • entitlement  — a paid bundle only ACTIVATES when the kernel holds a
 *     matching `pro:<slug>` license; otherwise it installs but stays inactive.
 *
 * The RS256 verification itself lives in `bundle-signature.ts`; this module only
 * makes the accept/reject/activate decisions from a manifest.
 */

/** Minimal manifest shape these decisions need (structural, not the full type). */
export interface EntitlementManifest {
  slug: string;
  pricing?: { model: string } | null;
  integrity?: { sha256?: string; signature?: string } | null;
}

/** A paid extension is one whose pricing model is not "free". */
export function isPaidExtension(manifest: EntitlementManifest): boolean {
  return manifest.pricing != null && manifest.pricing.model !== "free";
}

/** The license feature flag a paid extension is gated on, e.g. `pro:trading`. */
export function requiredFeature(manifest: EntitlementManifest): string {
  return `pro:${manifest.slug}`;
}

export interface AuthenticityResult {
  ok: boolean;
  reason?: string;
}

/**
 * Decide whether a freshly-unpacked bundle is authentic enough to install.
 * `verify(sha256Hex, signatureB64)` is the RS256 check (injected for testing;
 * defaults in the service to `verifyBundleSignature`).
 */
export async function checkBundleAuthenticity(
  manifest: EntitlementManifest,
  sha256Hex: string,
  verify: (sha256Hex: string, signatureB64: string) => Promise<boolean>,
): Promise<AuthenticityResult> {
  const sig = manifest.integrity?.signature;
  if (sig) {
    const valid = await verify(sha256Hex, sig);
    return valid
      ? { ok: true }
      : { ok: false, reason: `signature verification failed for ${manifest.slug}: bundle is tampered or not signed by the vendor` };
  }
  if (isPaidExtension(manifest)) {
    return { ok: false, reason: `paid extension ${manifest.slug} is missing its vendor signature — refusing to install` };
  }
  return { ok: true };
}

/**
 * The status a freshly-installed extension should land in. `requires_activation`
 * always yields "installed"; a paid extension without its license also stays
 * "installed" (inactive) until the license is present.
 */
export function activationStatus(
  manifest: EntitlementManifest,
  licenseHas: (feature: string) => boolean,
  requiresActivation: boolean,
): "installed" | "active" {
  if (requiresActivation) return "installed";
  if (isPaidExtension(manifest) && !licenseHas(requiredFeature(manifest))) return "installed";
  return "active";
}
