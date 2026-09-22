import { z } from "zod";
import { type ToolDefinition, defineTool, textResult, errorResult } from "@kernl/extension-sdk";
import type { TimeTrackingService } from "./service.js";

function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function timeTrackingTools(service: TimeTrackingService): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_time_start",
      description: "Start a time tracking timer. Automatically stops any running timer. Optionally link to a task.",
      schema: z.object({
        task_id: z.string().optional().describe("Link to a task ID"),
        description: z.string().optional().describe("What are you working on"),
        tags: z.string().optional().describe("Comma-separated tags"),
      }),
      handler: async (input) => {
        const entry = service.start(input);
        return textResult(
          `Timer started:\n  ID: ${entry.id}\n  Description: ${entry.description || "(none)"}\n  Started: ${entry.start_time}${entry.task_id ? `\n  Task: ${entry.task_id}` : ""}`,
        );
      },
    }),

    defineTool({
      name: "kernel_time_stop",
      description: "Stop the running timer (or a specific timer by ID). Calculates duration automatically.",
      schema: z.object({
        id: z.string().optional().describe("Timer ID (omit to stop the currently running timer)"),
      }),
      handler: async ({ id }) => {
        const entry = service.stop(id);
        if (!entry) return errorResult("No running timer found.");
        if (!entry.end_time) return textResult("Timer was already stopped.");

        return textResult(
          `Timer stopped:\n  Description: ${entry.description || "(none)"}\n  Duration: ${fmtDuration(entry.duration_minutes ?? 0)}\n  ${entry.start_time} → ${entry.end_time}`,
        );
      },
    }),

    defineTool({
      name: "kernel_time_log",
      description: "Manually log a time entry with start and end times (for past work).",
      schema: z.object({
        task_id: z.string().optional().describe("Link to a task ID"),
        description: z.string().optional().describe("What was done"),
        start_time: z.string().describe("Start time (ISO 8601)"),
        end_time: z.string().describe("End time (ISO 8601)"),
        tags: z.string().optional().describe("Comma-separated tags"),
      }),
      handler: async (input) => {
        const entry = service.log(input);
        return textResult(
          `Time logged:\n  ID: ${entry.id}\n  Duration: ${fmtDuration(entry.duration_minutes ?? 0)}\n  Description: ${entry.description || "(none)"}`,
        );
      },
    }),

    defineTool({
      name: "kernel_time_list",
      description: "List time entries with optional filters by task, date range, or tag.",
      schema: z.object({
        task_id: z.string().optional().describe("Filter by task"),
        from_date: z.string().optional().describe("Start date (ISO 8601)"),
        to_date: z.string().optional().describe("End date (ISO 8601)"),
        tag: z.string().optional().describe("Filter by tag"),
        limit: z.number().optional().describe("Max results (default: all)"),
      }),
      handler: async (filters) => {
        const entries = service.list(filters);
        if (entries.length === 0) return textResult("No time entries found.");

        const lines = entries.map((e) => {
          const dur = e.duration_minutes != null ? fmtDuration(e.duration_minutes) : "running...";
          return `${e.start_time.split("T")[0]} ${dur} — ${e.description || "(no description)"}${e.task_id ? ` [task: ${e.task_id}]` : ""}\n  ID: ${e.id}`;
        });
        return textResult(`${entries.length} entry(ies):\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_time_report",
      description: "Time tracking report: total hours, breakdown by task, tag, and day.",
      schema: z.object({
        from_date: z.string().optional().describe("Start date"),
        to_date: z.string().optional().describe("End date"),
        task_id: z.string().optional().describe("Filter by task"),
      }),
      handler: async (filters) => {
        const r = service.report(filters);
        if (r.entries_count === 0) return textResult("No time entries in this period.");

        const taskLines = r.by_task.slice(0, 10).map(
          (t) => `  ${t.task_id ?? "(no task)"}: ${fmtDuration(t.minutes)} (${t.count} entries)`,
        );
        const tagLines = r.by_tag.slice(0, 10).map(
          (t) => `  ${t.tag}: ${fmtDuration(t.minutes)}`,
        );
        const dayLines = r.by_day.map(
          (d) => `  ${d.date}: ${fmtDuration(d.minutes)}`,
        );

        let output = `Total: ${fmtDuration(r.total_minutes)} (${r.entries_count} entries)`;
        if (taskLines.length) output += `\n\nBy task:\n${taskLines.join("\n")}`;
        if (tagLines.length) output += `\n\nBy tag:\n${tagLines.join("\n")}`;
        if (dayLines.length) output += `\n\nBy day:\n${dayLines.join("\n")}`;

        return textResult(output);
      },
    }),
  ];
}
