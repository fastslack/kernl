import { z } from "zod";
import { type ToolDefinition, defineTool, textResult, errorResult } from "@kernl/extension-sdk";
import type { GoalsService } from "./service.js";

export function goalsTools(service: GoalsService): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_goals_create",
      description: "Create a goal or objective. Supports hierarchy via parent_id and optional target date.",
      schema: z.object({
        title: z.string().describe("Goal title"),
        description: z.string().optional(),
        type: z.enum(["goal", "objective"]).optional().describe("Type (default: goal)"),
        parent_id: z.string().optional().describe("Parent goal ID for sub-goals"),
        target_date: z.string().optional().describe("Target completion date (YYYY-MM-DD)"),
      }),
      handler: async (input) => {
        const goal = service.createGoal(input);
        return textResult(
          `Goal created:\n  ID: ${goal.id}\n  Title: ${goal.title}\n  Type: ${goal.type}\n  Target: ${goal.target_date || "none"}`,
        );
      },
    }),

    defineTool({
      name: "kernel_goals_list",
      description: "List goals with optional filters by status, type, or parent.",
      schema: z.object({
        status: z.enum(["active", "completed", "abandoned"]).optional(),
        type: z.enum(["goal", "objective"]).optional(),
        parent_id: z.string().optional().describe("Filter by parent goal (empty string for top-level only)"),
      }),
      handler: async (filters) => {
        const goals = service.listGoals(filters);
        if (goals.length === 0) return textResult("No goals found.");

        const lines = goals.map(
          (g) => `[${g.status.toUpperCase()}] ${g.title} (${g.type})${g.target_date ? ` — due ${g.target_date}` : ""}\n  ID: ${g.id}`,
        );
        return textResult(`${goals.length} goal(s):\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_goals_update",
      description: "Update a goal's title, description, status, type, or target date.",
      schema: z.object({
        id: z.string().describe("Goal ID"),
        title: z.string().optional(),
        description: z.string().optional(),
        type: z.enum(["goal", "objective"]).optional(),
        status: z.enum(["active", "completed", "abandoned"]).optional(),
        parent_id: z.string().optional(),
        target_date: z.string().optional(),
      }),
      handler: async ({ id, ...changes }) => {
        const goal = service.updateGoal(id, changes);
        if (!goal) return errorResult(`Goal not found: ${id}`);
        return textResult(`Goal "${goal.title}" updated. Status: ${goal.status}`);
      },
    }),

    defineTool({
      name: "kernel_goals_add_key_result",
      description: "Add a key result to a goal. Tracks measurable progress toward the goal.",
      schema: z.object({
        goal_id: z.string().describe("Goal ID"),
        title: z.string().describe("Key result description"),
        target_value: z.number().optional().describe("Target value (default: 100)"),
        current_value: z.number().optional().describe("Current value (default: 0)"),
        unit: z.string().optional().describe("Unit of measurement (default: %)"),
        task_id: z.string().optional().describe("Link to a task that achieves this KR"),
      }),
      handler: async (input) => {
        const kr = service.addKeyResult(input);
        return textResult(
          `Key result added:\n  ID: ${kr.id}\n  Title: ${kr.title}\n  Progress: ${kr.current_value}/${kr.target_value} ${kr.unit}`,
        );
      },
    }),

    defineTool({
      name: "kernel_goals_update_key_result",
      description: "Update a key result's progress or details.",
      schema: z.object({
        id: z.string().describe("Key result ID"),
        title: z.string().optional(),
        target_value: z.number().optional(),
        current_value: z.number().optional(),
        unit: z.string().optional(),
        task_id: z.string().optional(),
      }),
      handler: async ({ id, ...changes }) => {
        const kr = service.updateKeyResult(id, changes);
        if (!kr) return errorResult(`Key result not found: ${id}`);
        const pct = kr.target_value > 0 ? Math.round((kr.current_value / kr.target_value) * 100) : 0;
        return textResult(
          `Key result updated:\n  ${kr.title}\n  Progress: ${kr.current_value}/${kr.target_value} ${kr.unit} (${pct}%)`,
        );
      },
    }),

    defineTool({
      name: "kernel_goals_link_task",
      description: "Link a task to a goal in the knowledge graph (Neo4j). Shows which tasks contribute to which goals.",
      schema: z.object({
        goal_id: z.string().describe("Goal ID"),
        task_id: z.string().describe("Task ID"),
      }),
      handler: async ({ goal_id, task_id }) => {
        service.linkTask(goal_id, task_id);
        return textResult(`Task ${task_id} linked to goal ${goal_id}.`);
      },
    }),

    defineTool({
      name: "kernel_goals_progress",
      description: "View a goal's progress including all key results and overall completion percentage.",
      schema: z.object({
        goal_id: z.string().describe("Goal ID"),
      }),
      handler: async ({ goal_id }) => {
        const result = service.progress(goal_id);
        if (!result) return errorResult(`Goal not found: ${goal_id}`);

        const { goal, key_results, overall_percentage } = result;
        let output = `# ${goal.title}\nStatus: ${goal.status} | Progress: ${overall_percentage}%`;
        if (goal.target_date) output += ` | Target: ${goal.target_date}`;

        if (key_results.length > 0) {
          output += "\n\nKey Results:";
          for (const kr of key_results) {
            const pct = kr.target_value > 0 ? Math.round((kr.current_value / kr.target_value) * 100) : 0;
            output += `\n  [${pct}%] ${kr.title} — ${kr.current_value}/${kr.target_value} ${kr.unit}`;
            if (kr.task_id) output += ` (task: ${kr.task_id})`;
          }
        } else {
          output += "\n\nNo key results defined yet.";
        }

        return textResult(output);
      },
    }),
  ];
}
