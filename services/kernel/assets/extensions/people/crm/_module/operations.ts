/**
 * Contact operations the dashboard reaches over both the WS RPC and HTTP.
 *
 * The dashboard calls each of these through `rpcOrCall`, so the RPC action
 * and the `/api/contacts/*` route are the same request by two roads. They
 * used to be two copies of raw SQL that bypassed CrmService: `contacts.update`
 * took 6 of the service's 13 fields on both roads (lead pipeline and social
 * handles were silently dropped), create skipped the phone/email dedup and
 * the graph mirror, and delete failed on any contact with interactions. Now
 * rpc-actions.ts exposes this map as is, routes.ts binds each entry to its
 * path, and every write goes through the service.
 */

import { HttpError, pickArgs, type Operation, type EventBus } from "@kernl/extension-sdk";
import type { CrmService } from "./service.js";
import type { Contact, Interaction, LeadStatus } from "./types.js";

const RELATIONSHIPS: ReadonlyArray<Contact["relationship"]> = ["personal", "professional", "family", "acquaintance"];
const LEAD_STATUSES: ReadonlyArray<LeadStatus> = ["", "new", "drafted", "contacted", "qualified", "won", "lost"];
const INTERACTION_TYPES: ReadonlyArray<Interaction["type"]> = ["email", "call", "meeting", "message", "social", "other"];

/** Everything the service lets a caller write on a contact. */
const CONTACT_FIELDS = {
  name: "string",
  email: "string",
  phone: "string",
  company: "string",
  relationship: "string",
  notes: "string",
  last_interaction: "string",
  lead_status: "string",
  lead_source: "string",
  instagram_handle: "string",
  linkedin_url: "string",
  x_handle: "string",
  website: "string",
} as const;

export function contactOperations(service: CrmService, events?: EventBus | null): Record<string, Operation> {
  const changed = (action: string) => { events?.emit("data.changed", { module: "crm", action }); };
  const requireId = (input: Record<string, unknown>, key = "id"): string => {
    const id = pickArgs(input, { [key]: "string" } as Record<string, "string">)[key];
    if (!id) throw new HttpError(400, `Missing ${key}`);
    return id;
  };
  /** The picked contact fields, with the enum columns checked. */
  const contactFields = (input: Record<string, unknown>) => {
    const fields: Partial<Record<keyof typeof CONTACT_FIELDS, string>> = { ...pickArgs(input, CONTACT_FIELDS) };
    // An empty relationship from a form means "not chosen", not a value.
    if (fields.relationship === "") delete fields.relationship;
    if (fields.relationship !== undefined && !RELATIONSHIPS.includes(fields.relationship as Contact["relationship"])) {
      throw new HttpError(400, `Invalid relationship. Allowed: ${RELATIONSHIPS.join(", ")}`);
    }
    if (fields.lead_status !== undefined && !LEAD_STATUSES.includes(fields.lead_status as LeadStatus)) {
      throw new HttpError(400, `Invalid lead_status. Allowed: ${LEAD_STATUSES.join(", ")}`);
    }
    return fields as Partial<Omit<Contact, "id" | "created_at" | "updated_at">>;
  };

  return {
    "contacts.list": (input) =>
      service.searchContacts(pickArgs(input, { q: "string", relationship: "string", page: "number", limit: "number" })),

    "contacts.detail": (input) => {
      const id = requireId(input);
      const contact = service.getById(id);
      if (!contact) throw new HttpError(404, "Not found");
      return { contact, interactions: service.getInteractions(id) };
    },

    "contacts.create": (input) => {
      const { name: rawName, last_interaction: _unused, ...fields } = contactFields(input);
      const name = rawName?.trim() ?? "";
      if (!name) throw new HttpError(400, "Name required");
      // The service merges into an existing contact with the same phone or
      // email instead of creating a duplicate; `id` is then that contact's.
      const contact = service.addContact({ ...fields, name });
      changed("create");
      return { ok: true, id: contact.id };
    },

    "contacts.update": (input) => {
      const id = requireId(input);
      const fields = contactFields(input);
      if (Object.keys(fields).length === 0) throw new HttpError(400, "No fields");
      if (fields.name !== undefined && !fields.name.trim()) throw new HttpError(400, "Name required");
      if (!service.updateContact(id, fields)) throw new HttpError(404, "Contact not found");
      changed("update");
      return { ok: true };
    },

    "contacts.delete": (input) => {
      if (!service.deleteContact(requireId(input))) throw new HttpError(404, "Contact not found");
      changed("delete");
      return { ok: true };
    },

    "contacts.logInteraction": (input) => {
      const contactId = requireId(input, "contact_id");
      const args = pickArgs(input, { type: "string", summary: "string", date: "string" });
      const type = (args.type || "other") as Interaction["type"];
      if (!INTERACTION_TYPES.includes(type)) {
        throw new HttpError(400, `Invalid type. Allowed: ${INTERACTION_TYPES.join(", ")}`);
      }
      const interaction = service.logInteraction({
        contact_id: contactId,
        type,
        summary: args.summary ?? "",
        date: args.date || undefined,
      });
      if (!interaction) throw new HttpError(404, "Contact not found");
      changed("log_interaction");
      return { ok: true, id: interaction.id };
    },
  };
}
