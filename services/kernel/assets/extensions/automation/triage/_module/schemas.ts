import { z } from "zod";

export const CloseReasonSchema = z.enum([
  "implemented_on_main",
  "cannot_reproduce",
  "duplicate_or_superseded",
  "not_actionable_in_repo",
  "incoherent",
  "stale_insufficient_info",
  "none",
]);

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);

export const EvidenceSchema = z.object({
  label: z.string(),
  detail: z.string(),
  file: z.string().nullable().default(null),
  line: z.number().int().nullable().default(null),
  command: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
});

export const DecisionSchema = z.object({
  decision: z.enum(["close", "keep_open"]),
  closeReason: CloseReasonSchema,
  confidence: ConfidenceSchema,
  summary: z.string(),
  bestSolution: z.string(),
  evidence: z.array(EvidenceSchema).default([]),
  risks: z.array(z.string()).default([]),
  closeComment: z.string().default(""),
});

export type CloseReason = z.infer<typeof CloseReasonSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Decision = z.infer<typeof DecisionSchema>;

export const ALLOWED_CLOSE_REASONS: ReadonlySet<CloseReason> = new Set([
  "implemented_on_main",
  "cannot_reproduce",
  "duplicate_or_superseded",
  "not_actionable_in_repo",
  "incoherent",
  "stale_insufficient_info",
]);

export const PROTECTED_LABELS: ReadonlySet<string> = new Set([
  "security",
  "beta-blocker",
  "release-blocker",
  "maintainer",
]);

export const MAINTAINER_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);
