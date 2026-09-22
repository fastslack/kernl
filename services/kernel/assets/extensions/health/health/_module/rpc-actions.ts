/**
 * Health RPC Actions — metrics, medications, appointments via mtwRequest.
 *
 * RPC-only (the wellness page falls back to POST /api/rpc/<action>, the same
 * handlers), each one through HealthService.
 */

import { HttpError, pickArgs, rpcActionsFrom, type RpcAction } from "@kernl/extension-sdk";
import type { HealthService } from "./service.js";
import type { AppointmentStatus, MedicationFrequency, MetricType } from "./types.js";

export function healthRpcActions(service: HealthService): RpcAction[] {
  const today = () => new Date().toISOString().split("T")[0];

  return rpcActionsFrom({
    "health.metrics.list": (input) => {
      const args = pickArgs(input, { type: "string", from: "string", limit: "number" });
      return {
        metrics: service.listMetrics({
          type: (args.type || undefined) as MetricType | undefined,
          from_date: args.from || undefined,
          limit: Math.min(200, Math.max(10, args.limit ?? 50)),
        }),
      };
    },

    "health.metrics.log": (input) => {
      const args = pickArgs(input, { type: "string", unit: "string", date: "string", notes: "string" });
      // A reading is text ("120/80"); a number is taken as its string.
      const value = typeof input.value === "string" ? input.value : typeof input.value === "number" ? String(input.value) : "";
      if (!args.type || !value) throw new HttpError(400, "type and value required");
      const metric = service.logMetric({
        ...args,
        type: args.type as MetricType,
        value,
        // An empty unit takes the type's default (kg, bpm…).
        unit: args.unit || undefined,
      });
      return { ok: true, id: metric.id };
    },

    "health.medications.list": (input) => ({
      medications: service.listMedications(input.active_only !== false),
    }),

    "health.medications.create": (input) => {
      const args = pickArgs(input, { name: "string", dosage: "string", frequency: "string", start_date: "string", end_date: "string", notes: "string" });
      const name = args.name?.trim() ?? "";
      if (!name) throw new HttpError(400, "Name required");
      const med = service.addMedication({
        ...args,
        name,
        frequency: args.frequency as MedicationFrequency | undefined,
        start_date: args.start_date ?? today(),
      });
      return { ok: true, id: med.id };
    },

    "health.medications.update": (input) => {
      const id = pickArgs(input, { id: "string" }).id ?? "";
      if (!id) throw new HttpError(400, "Missing id");
      const args = pickArgs(input, { name: "string", dosage: "string", frequency: "string", start_date: "string", end_date: "string", notes: "string" });
      // Only the keys that were sent: the service spreads these over the row,
      // so an `undefined` would blank a column.
      const changes = { ...args } as Parameters<HealthService["updateMedication"]>[1];
      // An explicit null clears the end date.
      if (input.end_date === null) changes.end_date = null;
      if (input.active !== undefined) changes.active = input.active ? 1 : 0;
      if (!Object.values(changes).some((v) => v !== undefined)) throw new HttpError(400, "No fields");
      if (!service.updateMedication(id, changes)) throw new HttpError(404, "Medication not found");
      return { ok: true };
    },

    "health.appointments.list": (input) => {
      const args = pickArgs(input, { status: "string", from: "string" });
      return {
        appointments: service.listAppointments({
          status: (args.status || undefined) as AppointmentStatus | undefined,
          from_date: args.from || undefined,
        }),
      };
    },

    "health.appointments.create": (input) => {
      const args = pickArgs(input, { title: "string", date: "string", provider: "string", location: "string", notes: "string" });
      const title = args.title?.trim() ?? "";
      if (!title || !args.date) throw new HttpError(400, "title and date required");
      const apt = service.addAppointment({ ...args, title, date: args.date });
      return { ok: true, id: apt.id };
    },

    "health.summary": () => service.overview(),
  });
}
