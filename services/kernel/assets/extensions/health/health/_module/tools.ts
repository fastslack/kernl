import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { HealthService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";

export function healthTools(service: HealthService): ToolDefinition[] {
  return [
    {
      name: "kernel_health_log_metric",
      description: "Log a health metric (weight, blood pressure, heart rate, sleep, steps, etc). Units auto-detected by type.",
      inputSchema: z.object({
        type: z.enum(["weight", "blood_pressure", "heart_rate", "temperature", "blood_sugar", "sleep_hours", "steps", "oxygen", "custom"])
          .describe("Metric type"),
        value: z.string().describe("Value (e.g. '72.5' for weight, '120/80' for blood pressure)"),
        unit: z.string().optional().describe("Unit (auto-detected: kg, mmHg, bpm, etc)"),
        date: z.string().optional().describe("Date (YYYY-MM-DD, default: today)"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const metric = service.logMetric(args as any);
        return textResult(`Metric logged:\n  ${metric.type}: ${metric.value} ${metric.unit} (${metric.date})`);
      },
    },

    {
      name: "kernel_health_list_metrics",
      description: "List health metrics with optional filters by type and date range.",
      inputSchema: z.object({
        type: z.enum(["weight", "blood_pressure", "heart_rate", "temperature", "blood_sugar", "sleep_hours", "steps", "oxygen", "custom"]).optional(),
        from_date: z.string().optional(), to_date: z.string().optional(),
        limit: z.number().optional(),
      }),
      handler: async (args) => {
        const metrics = service.listMetrics(args as any);
        if (metrics.length === 0) return textResult("No metrics found.");
        const lines = metrics.map(m => `${m.date} ${m.type}: ${m.value} ${m.unit}${m.notes ? ` — ${m.notes}` : ""}`);
        return textResult(`${metrics.length} metric(s):\n\n${lines.join("\n")}`);
      },
    },

    {
      name: "kernel_health_add_medication",
      description: "Add a medication to track. Supports dosage, frequency, and active status.",
      inputSchema: z.object({
        name: z.string().describe("Medication name"),
        dosage: z.string().optional().describe("Dosage (e.g. '10mg', '500mg 2x')"),
        frequency: z.enum(["as_needed", "daily", "twice_daily", "weekly", "monthly"]).optional(),
        start_date: z.string().describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().optional(), notes: z.string().optional(),
      }),
      handler: async (args) => {
        const med = service.addMedication(args as any);
        return textResult(`Medication added:\n  ID: ${med.id}\n  Name: ${med.name}\n  Dosage: ${med.dosage || "n/a"}\n  Frequency: ${med.frequency}`);
      },
    },

    {
      name: "kernel_health_list_medications",
      description: "List medications. By default shows only active ones.",
      inputSchema: z.object({
        all: z.boolean().optional().describe("Include inactive medications (default: false)"),
      }),
      handler: async (args) => {
        const { all } = args as { all?: boolean };
        const meds = service.listMedications(!all);
        if (meds.length === 0) return textResult("No medications found.");
        const lines = meds.map(m => `${m.active ? "[ACTIVE]" : "[STOPPED]"} ${m.name} — ${m.dosage || "n/a"} (${m.frequency})\n  Since: ${m.start_date}${m.end_date ? ` → ${m.end_date}` : ""} | ID: ${m.id}`);
        return textResult(`${meds.length} medication(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_health_update_medication",
      description: "Update a medication (dosage, frequency, active status, etc).",
      inputSchema: z.object({
        id: z.string().describe("Medication ID"),
        name: z.string().optional(), dosage: z.string().optional(),
        frequency: z.enum(["as_needed", "daily", "twice_daily", "weekly", "monthly"]).optional(),
        end_date: z.string().optional(), active: z.boolean().optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as any;
        if (changes.active !== undefined) changes.active = changes.active ? 1 : 0;
        const med = service.updateMedication(id, changes);
        if (!med) return errorResult(`Medication not found: ${id}`);
        return textResult(`Medication "${med.name}" updated.`);
      },
    },

    {
      name: "kernel_health_add_appointment",
      description: "Schedule a health appointment (doctor, dentist, therapy, etc).",
      inputSchema: z.object({
        title: z.string().describe("Appointment title"),
        provider: z.string().optional().describe("Doctor/provider name"),
        location: z.string().optional(),
        date: z.string().describe("Date and time (ISO 8601)"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const apt = service.addAppointment(args as any);
        return textResult(`Appointment scheduled:\n  ID: ${apt.id}\n  Title: ${apt.title}\n  Date: ${apt.date}\n  Provider: ${apt.provider || "n/a"}`);
      },
    },

    {
      name: "kernel_health_list_appointments",
      description: "List health appointments with optional filters.",
      inputSchema: z.object({
        status: z.enum(["scheduled", "completed", "cancelled"]).optional(),
        from_date: z.string().optional(), to_date: z.string().optional(),
      }),
      handler: async (args) => {
        const apts = service.listAppointments(args as any);
        if (apts.length === 0) return textResult("No appointments found.");
        const lines = apts.map(a => `[${a.status.toUpperCase()}] ${a.date} — ${a.title}${a.provider ? ` (${a.provider})` : ""}${a.location ? ` @ ${a.location}` : ""}\n  ID: ${a.id}`);
        return textResult(`${apts.length} appointment(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_health_update_appointment",
      description: "Update a health appointment (reschedule, complete, cancel).",
      inputSchema: z.object({
        id: z.string().describe("Appointment ID"),
        title: z.string().optional(), provider: z.string().optional(),
        location: z.string().optional(), date: z.string().optional(),
        status: z.enum(["scheduled", "completed", "cancelled"]).optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as any;
        const apt = service.updateAppointment(id, changes);
        if (!apt) return errorResult(`Appointment not found: ${id}`);
        return textResult(`Appointment "${apt.title}" updated. Status: ${apt.status}`);
      },
    },

    {
      name: "kernel_health_summary",
      description: "Health overview: active medications, upcoming appointments, recent metrics.",
      inputSchema: z.object({}),
      handler: async () => {
        const s = service.summary();
        let output = `Active medications: ${s.active_medications}\nUpcoming appointments: ${s.upcoming_appointments}`;
        if (s.latest_weight) output += `\nLatest weight: ${s.latest_weight.value} ${s.latest_weight.unit} (${s.latest_weight.date})`;
        if (s.recent_metrics.length > 0) {
          output += "\n\nRecent metrics:";
          for (const m of s.recent_metrics) {
            output += `\n  ${m.type}: ${m.value} ${m.unit} (${m.date})`;
          }
        }
        return textResult(output);
      },
    },
  ];
}
