/**
 * Goals RPC Actions — OKR management via mtwRequest.
 *
 * These have no HTTP twin. They used to be raw SQL, which skipped the
 * service's Neo4j mirror (Goal nodes, ACHIEVED_BY links to tasks), let a
 * key result be added to a goal that does not exist, and answered ok for an
 * update of an id that was not there. Now each one calls GoalsService.
 */

import { HttpError, pickArgs, rpcActionsFrom, type RpcAction } from "@kernl/extension-sdk";
import type { GoalsService } from "./service.js";
import type { Goal, GoalStatus, GoalType, KeyResult } from "./types.js";

const TYPES: ReadonlyArray<GoalType> = ["goal", "objective"];
const STATUSES: ReadonlyArray<GoalStatus> = ["active", "completed", "abandoned"];

/** A nullable reference: a string sets it, an explicit null clears it. */
const nullable = (input: Record<string, unknown>, key: string): string | null | undefined =>
  input[key] === null ? null : typeof input[key] === "string" ? input[key] as string : undefined;

export function goalsRpcActions(service: GoalsService): RpcAction[] {
  const requireId = (input: Record<string, unknown>): string => {
    const { id } = pickArgs(input, { id: "string" });
    if (!id) throw new HttpError(400, "Missing id");
    return id;
  };
  const checkEnums = (fields: { type?: string; status?: string }) => {
    if (fields.type !== undefined && !TYPES.includes(fields.type as GoalType)) {
      throw new HttpError(400, `Invalid type. Allowed: ${TYPES.join(", ")}`);
    }
    if (fields.status !== undefined && !STATUSES.includes(fields.status as GoalStatus)) {
      throw new HttpError(400, `Invalid status. Allowed: ${STATUSES.join(", ")}`);
    }
  };
  /** Drop the keys left undefined: the service spreads changes over the row. */
  const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

  return rpcActionsFrom({
    "goals.list": (input) => ({ goals: service.listWithProgress(pickArgs(input, { status: "string" }).status || undefined) }),

    "goals.detail": (input) => {
      const id = requireId(input);
      const goal = service.getGoal(id);
      if (!goal) throw new HttpError(404, "Not found");
      const children = service.listGoals({ parent_id: id })
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(({ id, title, status, type }) => ({ id, title, status, type }));
      return { goal, keyResults: service.getKeyResults(id), children };
    },

    "goals.create": (input) => {
      const args = pickArgs(input, { title: "string", description: "string", type: "string", parent_id: "string", target_date: "string" });
      const title = args.title?.trim() ?? "";
      if (!title) throw new HttpError(400, "Title required");
      checkEnums(args);
      const goal = service.createGoal({
        title,
        description: args.description,
        type: args.type as GoalType | undefined,
        parent_id: args.parent_id || undefined,
        target_date: args.target_date || undefined,
      });
      return { ok: true, id: goal.id };
    },

    "goals.update": (input) => {
      const id = requireId(input);
      const fields = pickArgs(input, { title: "string", description: "string", type: "string", status: "string" });
      checkEnums(fields);
      const changes = defined({
        ...fields,
        parent_id: nullable(input, "parent_id"),
        target_date: nullable(input, "target_date"),
      }) as Partial<Pick<Goal, "title" | "description" | "type" | "status" | "parent_id" | "target_date">>;
      if (Object.keys(changes).length === 0) throw new HttpError(400, "No fields");
      if (!service.updateGoal(id, changes)) throw new HttpError(404, "Goal not found");
      return { ok: true };
    },

    "goals.addKeyResult": (input) => {
      const args = pickArgs(input, {
        goal_id: "string", title: "string", target_value: "number", current_value: "number", unit: "string", task_id: "string",
      });
      const title = args.title?.trim() ?? "";
      if (!args.goal_id || !title) throw new HttpError(400, "goal_id and title required");
      if (!service.getGoal(args.goal_id)) throw new HttpError(404, "Goal not found");
      const kr = service.addKeyResult({ ...args, goal_id: args.goal_id, title, task_id: args.task_id || undefined });
      return { ok: true, id: kr.id };
    },

    "goals.updateKeyResult": (input) => {
      const id = requireId(input);
      const changes = defined({
        ...pickArgs(input, { title: "string", target_value: "number", current_value: "number", unit: "string" }),
        task_id: nullable(input, "task_id"),
      }) as Partial<Pick<KeyResult, "title" | "target_value" | "current_value" | "unit" | "task_id">>;
      if (Object.keys(changes).length === 0) throw new HttpError(400, "No fields");
      if (!service.updateKeyResult(id, changes)) throw new HttpError(404, "Key result not found");
      return { ok: true };
    },
  });
}
