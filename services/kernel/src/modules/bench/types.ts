/**
 * Model Bench — shared types.
 *
 * A task is a prompt plus a deterministic check. Tool tasks also carry a fake
 * world (see world.ts) the model works on, rebuilt for every attempt, so a
 * benchmark never touches the operator's real data.
 */

import type { World, FakeTool } from "./world.js";

export type Category = "tools" | "agent" | "json" | "numbers" | "language" | "context" | "safety";

export const CATEGORIES: readonly Category[] = ["tools", "agent", "json", "numbers", "language", "context", "safety"];

/** Share of the total each category carries. Sums to 1. */
export const CATEGORY_WEIGHTS: Record<Category, number> = {
  tools: 0.25, agent: 0.2, json: 0.2, numbers: 0.1, language: 0.1, context: 0.1, safety: 0.05,
};

/** What one attempt produced, as the check sees it. */
export interface AttemptOutput {
  /** The model's final text. */
  text: string;
  /** Every tool call, in order, with the arguments the model sent. */
  calls: Array<{ name: string; input: Record<string, unknown> }>;
  /** The fake world after the attempt (tool tasks only). */
  world: World | null;
  /** Loop iterations used (tool tasks only). */
  iterations: number;
}

export interface CheckResult {
  /** 0..1 — partial credit allowed. */
  score: number;
  /** One line a person can read: what passed and what did not. */
  detail: string;
  /** The output could not be used at all (unparseable JSON, unknown tool…). */
  invalid?: string;
}

export interface BenchTask {
  /** "<category>/<slug>", stable across suite versions while the task means the same. */
  id: string;
  category: Category;
  /** Short title for the screen. */
  title: string;
  /** Tasks the model can only do by calling tools; skipped for providers without a tool loop. */
  needsTools: boolean;
  system: string;
  prompt: string;
  /** Tool names from world.ts this task offers. */
  tools?: string[];
  /** Seeds the world for this task on top of the base world. */
  seed?: (w: World) => void;
  maxTokens?: number;
  /** Tool-loop iteration cap. */
  maxIterations?: number;
  /** Per-attempt wall-clock limit. */
  timeoutMs?: number;
  check(out: AttemptOutput): CheckResult;
}

export type { World, FakeTool };
