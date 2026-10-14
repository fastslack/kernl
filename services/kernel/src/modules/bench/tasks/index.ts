/**
 * The suite. Bump SUITE_VERSION whenever a task's prompt, world or check
 * changes meaning: runs remember the version they were scored with, and the
 * screen does not compare totals across versions.
 */

import { toolTasks } from "./tools.js";
import { agentTasks } from "./agent.js";
import { jsonTasks } from "./json.js";
import { numberTasks } from "./numbers.js";
import { languageTasks } from "./language.js";
import { contextTasks } from "./context.js";
import { safetyTasks } from "./safety.js";
import type { BenchTask } from "../types.js";

/** v2 (2026-10-13): 16 hard tasks instead of 35 easy ones — v1 put every model near 100. */
export const SUITE_VERSION = 2;

export const SUITE: readonly BenchTask[] = [
  ...toolTasks, ...agentTasks, ...jsonTasks, ...numberTasks, ...languageTasks, ...contextTasks, ...safetyTasks,
];
