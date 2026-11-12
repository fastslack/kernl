import { z } from "zod";
import { type ToolDefinition, defineTool, errorResult, structuredResult } from "@kernl/extension-sdk";
import type { CrmService } from "./service.js";
import { addIdentity, type PeopleService } from "./people.js";

export function peopleTools(people: PeopleService, crm: CrmService): ToolDefinition[] {
  /** A contact id, or the single contact a name or address points at. */
  const resolve = (contact_id?: string, who?: string): { id: string } | { error: string } => {
    if (contact_id) return crm.getById(contact_id) ? { id: contact_id } : { error: `Contact not found: ${contact_id}` };
    if (!who) return { error: "Pass contact_id or who." };
    const byAddress = crm.findExisting(who, who);
    if (byAddress) return { id: byAddress.id };
    const found = crm.find(who);
    if (found.length === 1) return { id: found[0].id };
    if (found.length === 0) return { error: `No contact matches "${who}".` };
    return { error: `"${who}" matches ${found.length} contacts: ${found.slice(0, 8).map((c) => `${c.name} (${c.id})`).join(", ")}. Pass contact_id.` };
  };

  return [
    defineTool({
      name: "kernel_crm_person_360",
      description:
        "Everything Kernl knows about one person: every email, phone and handle they are known by, " +
        "interactions, messages by channel, Gmail threads and calendar events with them, notes, event " +
        "RSVPs, current facts, their graph connections, and contacts that may be the same person.",
      schema: z.object({
        contact_id: z.string().optional(),
        who: z.string().optional().describe("A name, email or phone, when the id is not known."),
      }),
      outputSchema: z.unknown(),
      tags: ["crm", "people", "memory"],
      handler: async ({ contact_id, who }) => {
        const r = resolve(contact_id, who);
        if ("error" in r) return errorResult(r.error);
        const view = await people.person360(r.id);
        return view ? structuredResult(view) : errorResult(`Contact not found: ${r.id}`);
      },
    }),

    defineTool({
      name: "kernel_crm_add_identity",
      description:
        "Attach another email, phone or handle to a contact (a work address, a second number, a LinkedIn " +
        "profile), so mail and messages from it are recognised as theirs.",
      schema: z.object({
        contact_id: z.string(),
        kind: z.enum(["email", "phone", "linkedin", "instagram", "x", "website"]),
        value: z.string().min(1),
        source: z.string().optional(),
      }),
      outputSchema: z.unknown(),
      tags: ["crm", "people"],
      sideEffects: ["crm.identity.added:1"],
      handler: async ({ contact_id, kind, value, source }) => {
        if (!crm.getById(contact_id)) return errorResult(`Contact not found: ${contact_id}`);
        if (!addIdentity(crm.db, contact_id, kind, value, source ?? "manual")) return errorResult(`Not a valid ${kind}: ${value}`);
        const dups = people.duplicates({ contactId: contact_id, limit: 5 });
        return structuredResult({ identities: people.identities(contact_id), possible_duplicates: dups });
      },
    }),

    defineTool({
      name: "kernel_crm_duplicates",
      description:
        "Contacts that look like the same person: a shared email, phone or handle (near-certain), or the " +
        "same full name (stronger with the same company). Review, then merge or mark as different.",
      schema: z.object({
        contact_id: z.string().optional().describe("Only pairs involving this contact."),
        min_score: z.number().min(0).max(1).default(0.5),
        limit: z.number().int().positive().max(200).default(50),
      }),
      outputSchema: z.unknown(),
      tags: ["crm", "people"],
      handler: async ({ contact_id, min_score, limit }) => {
        const pairs = people.duplicates({ contactId: contact_id, limit: 1000 }).filter((p) => p.score >= min_score);
        return structuredResult({ total: pairs.length, pairs: pairs.slice(0, limit) });
      },
    }),

    defineTool({
      name: "kernel_crm_merge",
      description:
        "Merge two contacts that are the same person: `keep_id` absorbs `merge_id`. Empty fields are " +
        "filled, notes appended, and every email, interaction, message, note, event RSVP, fact and graph " +
        "connection moves to the kept contact. The absorbed contact is deleted; a snapshot of it is kept.",
      schema: z.object({
        keep_id: z.string(),
        merge_id: z.string(),
      }),
      outputSchema: z.unknown(),
      tags: ["crm", "people"],
      sideEffects: ["crm.contact.merged:1"],
      handler: async ({ keep_id, merge_id }) => {
        if (keep_id === merge_id) return errorResult("keep_id and merge_id are the same contact.");
        const r = await people.merge(keep_id, merge_id);
        if (!r) return errorResult("Both contacts must exist.");
        return structuredResult({ kept: r.kept, moved: r.moved });
      },
    }),

    defineTool({
      name: "kernel_crm_not_duplicate",
      description: "Record that two contacts are different people, so they stop showing as possible duplicates.",
      schema: z.object({ a: z.string(), b: z.string() }),
      outputSchema: z.unknown(),
      tags: ["crm", "people"],
      handler: async ({ a, b }) => {
        if (a === b) return errorResult("Same contact.");
        people.markDistinct(a, b);
        return structuredResult({ ok: true });
      },
    }),
  ];
}
