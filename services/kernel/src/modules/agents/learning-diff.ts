/**
 * Which lessons a post-run cleanup retired. The executor snapshots the
 * agent's active learnings before self-grading and again after; anything that
 * was active before and is gone after fell below the confidence floor. The
 * LIVE feed shows these, so the operator sees *what* the agent stopped
 * believing, not just how many.
 */

import type { AgentLearning } from "./types.js";

export interface RetiredLearning {
  id: string;
  type: string;
  content: string;
  confidence: number;
}

export function retiredLearnings(
  before: ReadonlyArray<Pick<AgentLearning, "id" | "type" | "content" | "confidence">>,
  after: ReadonlyArray<Pick<AgentLearning, "id">>,
): RetiredLearning[] {
  const still = new Set(after.map((l) => l.id));
  return before
    .filter((l) => !still.has(l.id))
    .map((l) => ({ id: l.id, type: l.type, content: l.content, confidence: l.confidence }));
}
