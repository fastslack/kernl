import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Project connector contract v1 (docs/project-connector-v1.md) — commercial
 * data only. Every object strips unknown keys: if a project ever sends more
 * than the contract (patients, clinical data), it is dropped, never stored.
 */
const Usage = z.object({
  users: z.number().int().nonnegative(),
  practitioners: z.number().int().nonnegative(),
  encounters_30d: z.number().int().nonnegative(),
  appointments_30d: z.number().int().nonnegative(),
}).strip();

const Admin = z.object({
  name: z.string(),
  email: z.string(),
  phone: z.string().optional().default(""),
}).strip();

export const InstitutionV1 = z.object({
  id: z.string(),
  name: z.string(),
  country: z.string(),
  plan: z.string(),
  created_at: z.string(),
  last_active_at: z.string().nullable().optional().default(null),
  usage: Usage,
  admin: Admin,
}).strip();

export const WaitlistEntryV1 = z.object({
  name: z.string(),
  email: z.string(),
  institution: z.string().optional().default(""),
  created_at: z.string(),
}).strip();

export const SnapshotV1Schema = z.object({
  version: z.literal("v1"),
  generated_at: z.string().optional(),
  institutions: z.array(InstitutionV1).default([]),
  waitlist: z.array(WaitlistEntryV1).default([]),
}).strip();
export type SnapshotV1 = z.infer<typeof SnapshotV1Schema>;

export const WebhookEventSchema = z.discriminatedUnion("type", [
  z.object({ event_id: z.string(), type: z.literal("institution.created"), occurred_at: z.string(), data: InstitutionV1 }).strip(),
  z.object({ event_id: z.string(), type: z.literal("waitlist.joined"), occurred_at: z.string(), data: WaitlistEntryV1 }).strip(),
  z.object({
    event_id: z.string(), type: z.literal("usage.threshold"), occurred_at: z.string(),
    data: z.object({ institution_id: z.string(), metric: z.string(), value: z.number() }).strip(),
  }).strip(),
  z.object({
    event_id: z.string(), type: z.literal("plan.changed"), occurred_at: z.string(),
    data: z.object({ institution_id: z.string(), from: z.string(), to: z.string() }).strip(),
  }).strip(),
]);
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/** `sha256=<hex>` HMAC of the raw request body. */
export function sign(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** Constant-time check of the X-Kernl-Signature header against the raw body. */
export function verifySignature(rawBody: string, header: string, secret: string): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(sign(rawBody, secret));
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function describeZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}
