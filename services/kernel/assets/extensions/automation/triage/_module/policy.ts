import { createHash } from "node:crypto";
import { REVIEW_PROMPT } from "./prompts.js";

export const POLICY_VERSION = "0.1";

/**
 * Stable hash of the review policy. Stored on every review row and used by
 * the planner to mark old reviews as due when the policy changes (model,
 * prompt, schema shape, allowed close reasons …).
 */
export function policyHash(input: {
  model: string;
  reasoningEffort?: string;
}): string {
  const payload = JSON.stringify({
    version: POLICY_VERSION,
    model: input.model,
    reasoningEffort: input.reasoningEffort ?? "",
    prompt: REVIEW_PROMPT,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
