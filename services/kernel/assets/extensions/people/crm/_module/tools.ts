import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { CrmService } from "./service.js";
import type { LeadStatus } from "./types.js";
import { textResult, errorResult, structuredResult } from "../../../../../src/core/helpers.js";

const LeadStatusEnum = z.enum(["", "new", "drafted", "contacted", "qualified", "won", "lost"]);

export function crmTools(service: CrmService): ToolDefinition[] {
  return [
    {
      name: "kernel_crm_add_contact",
      description:
        "Add (or merge) a contact in the Personal CRM. Idempotent by normalized phone + email — calling twice for the same person enriches the existing row instead of duplicating. Optional `lead_*` and social fields turn the contact into a lead the `/crm/leads` view picks up.",
      inputSchema: z.object({
        name: z.string().describe("Full name"),
        email: z.string().optional().describe("Email address"),
        phone: z.string().optional().describe("Phone number — any format; dedup normalizes it."),
        company: z.string().optional().describe("Company or organization"),
        relationship: z
          .enum(["personal", "professional", "family", "acquaintance"])
          .optional()
          .describe("Relationship type"),
        notes: z.string().optional().describe("Additional notes (appended on merge, never overwritten)"),
        // ── Lead pipeline ─────────
        lead_status: LeadStatusEnum.optional().describe("Pipeline stage. '' for ordinary contact, 'new' for fresh prospect."),
        lead_source: z.string().optional().describe("Origin tag (e.g. 'web-prospector')."),
        // ── Social / web surfaces ─
        instagram_handle: z.string().optional().describe("e.g. '@acme'"),
        linkedin_url: z.string().optional(),
        x_handle: z.string().optional(),
        website: z.string().optional(),
        // ── Dedup control ─────────
        dedup: z.boolean().optional().describe("Default true. Set false to force a new row (rarely needed)."),
      }),
      outputSchema: z.object({
        id: z.string(),
        name: z.string(),
        company: z.string(),
        email: z.string(),
        phone: z.string(),
        relationship: z.string(),
        lead_status: z.string(),
        lead_source: z.string(),
        instagram_handle: z.string(),
        linkedin_url: z.string(),
        x_handle: z.string(),
        website: z.string(),
        merged: z.boolean().describe("true when an existing row was enriched instead of creating a new one"),
      }),
      tags: ["crm", "contact", "add", "lead", "prospect"],
      handler: async (args) => {
        const input = args as Parameters<CrmService["addContact"]>[0];
        // Detect merge by checking if a row with this phone/email already exists.
        const existed = service.findExisting(input.phone, input.email);
        const contact = service.addContact(input);
        return structuredResult(
          {
            id: contact.id,
            name: contact.name,
            company: contact.company,
            email: contact.email,
            phone: contact.phone,
            relationship: contact.relationship,
            lead_status: contact.lead_status,
            lead_source: contact.lead_source,
            instagram_handle: contact.instagram_handle,
            linkedin_url: contact.linkedin_url,
            x_handle: contact.x_handle,
            website: contact.website,
            merged: !!existed && existed.id === contact.id,
          },
          existed && existed.id === contact.id
            ? `Merged into existing contact **${contact.name}** (${contact.id})`
            : `Contact created: **${contact.name}** (${contact.id}) · ${contact.relationship}` +
              (contact.lead_status ? ` · lead=${contact.lead_status}` : ""),
        );
      },
    },

    {
      name: "kernel_crm_find",
      description:
        "Search contacts by name, email, company, or notes. Fuzzy matching.",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
      }),
      handler: async (args) => {
        const { query } = args as { query: string };
        const contacts = service.find(query);
        if (contacts.length === 0)
          return textResult(`No contacts matching "${query}".`);

        const lines = contacts.map(
          (c) =>
            `${c.name} (${c.relationship})${c.company ? ` @ ${c.company}` : ""}${c.email ? ` — ${c.email}` : ""}\n  ID: ${c.id}`,
        );
        return textResult(
          `${contacts.length} contact(s) found:\n\n${lines.join("\n\n")}`,
        );
      },
    },

    {
      name: "kernel_crm_log_interaction",
      description:
        "Log an interaction with a contact (email, call, meeting, message, social). Updates last_interaction and Neo4j graph.",
      inputSchema: z.object({
        contact_id: z.string().describe("Contact ID"),
        type: z
          .enum(["email", "call", "meeting", "message", "social", "other"])
          .describe("Interaction type"),
        summary: z.string().describe("Brief summary of the interaction"),
        date: z.string().optional().describe("Date (YYYY-MM-DD), defaults to today"),
      }),
      handler: async (args) => {
        const input = args as {
          contact_id: string;
          type: "email" | "call" | "meeting" | "message" | "social" | "other";
          summary: string;
          date?: string;
        };
        const interaction = service.logInteraction(input);
        if (!interaction)
          return errorResult(`Contact not found: ${input.contact_id}`);
        return textResult(
          `Interaction logged:\n  Type: ${interaction.type}\n  Date: ${interaction.date}\n  Summary: ${interaction.summary}`,
        );
      },
    },

    {
      name: "kernel_crm_get_contact",
      description:
        "Get detailed info about a contact including recent interactions.",
      inputSchema: z.object({
        id: z.string().describe("Contact ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const contact = service.getById(id);
        if (!contact) return errorResult(`Contact not found: ${id}`);

        const interactions = service.getInteractions(id);
        const interLines = interactions.length > 0
          ? interactions
              .map((i) => `  [${i.date}] ${i.type}: ${i.summary}`)
              .join("\n")
          : "  (none)";

        return textResult(
          `${contact.name}\n  Email: ${contact.email || "—"}\n  Phone: ${contact.phone || "—"}\n  Company: ${contact.company || "—"}\n  Relationship: ${contact.relationship}\n  Notes: ${contact.notes || "—"}\n  Last interaction: ${contact.last_interaction || "never"}\n\nRecent interactions:\n${interLines}`,
        );
      },
    },

    {
      name: "kernel_crm_list_contacts",
      description: "List all contacts, optionally filtered by relationship type.",
      inputSchema: z.object({
        relationship: z
          .enum(["personal", "professional", "family", "acquaintance"])
          .optional()
          .describe("Filter by relationship type"),
      }),
      handler: async (args) => {
        const filters = args as {
          relationship?: "personal" | "professional" | "family" | "acquaintance";
        };
        const contacts = service.listContacts(filters);
        if (contacts.length === 0) return textResult("No contacts found.");

        const lines = contacts.map(
          (c) =>
            `${c.name} (${c.relationship})${c.company ? ` @ ${c.company}` : ""} — last: ${c.last_interaction || "never"}`,
        );
        return textResult(`${contacts.length} contact(s):\n\n${lines.join("\n")}`);
      },
    },

    // ── kernel_crm_leads ─────────────────────────────
    {
      name: "kernel_crm_leads",
      description:
        "Query the CRM lead pipeline — contacts whose `lead_status` is non-empty. " +
        "Filter by status ('new'|'contacted'|'qualified'|'won'|'lost') and/or source ('web-prospector', etc.). " +
        "Returns typed leads with their phone / email / Instagram / LinkedIn / X handles + counts per stage.",
      inputSchema: z.object({
        status: z.enum(["any", "new", "drafted", "contacted", "qualified", "won", "lost"]).default("any"),
        source: z.string().optional().describe("Lead origin tag — e.g. 'web-prospector'."),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      outputSchema: z.object({
        total: z.number().int(),
        counts_by_status: z.record(z.string(), z.number().int()),
        leads: z.array(z.object({
          id: z.string(),
          name: z.string(),
          company: z.string(),
          phone: z.string(),
          email: z.string(),
          lead_status: z.string(),
          lead_source: z.string(),
          instagram_handle: z.string(),
          linkedin_url: z.string(),
          x_handle: z.string(),
          website: z.string(),
          notes: z.string(),
          updated_at: z.string(),
        })),
      }),
      tags: ["crm", "leads", "pipeline", "prospect", "list"],
      handler: async (args) => {
        const { status, source, limit } = args as {
          status: "any" | "new" | "drafted" | "contacted" | "qualified" | "won" | "lost";
          source?: string;
          limit: number;
        };
        const leads = service.listLeads({ status, source, limit });
        const counts = service.leadCounts(source);
        const out = {
          total: leads.length,
          counts_by_status: counts as Record<string, number>,
          leads: leads.map((c) => ({
            id: c.id,
            name: c.name,
            company: c.company,
            phone: c.phone,
            email: c.email,
            lead_status: c.lead_status,
            lead_source: c.lead_source,
            instagram_handle: c.instagram_handle,
            linkedin_url: c.linkedin_url,
            x_handle: c.x_handle,
            website: c.website,
            notes: c.notes,
            updated_at: c.updated_at,
          })),
        };
        if (leads.length === 0) {
          return { ...textResult(`No leads matching status=${status}${source ? `, source=${source}` : ""}.`), structuredContent: out };
        }
        const lines = [
          `${leads.length} lead(s) (status=${status}${source ? `, source=${source}` : ""}):`,
          ...leads.map((c) => {
            const surfaces = [
              c.phone && `📞 ${c.phone}`,
              c.email && `✉ ${c.email}`,
              c.instagram_handle && `IG ${c.instagram_handle}`,
              c.linkedin_url && "LI",
              c.x_handle && `X ${c.x_handle}`,
            ].filter(Boolean).join(" · ");
            return `- [${c.lead_status}] **${c.name}** @ ${c.company || "—"}${surfaces ? ` · ${surfaces}` : ""}`;
          }),
        ];
        return { ...textResult(lines.join("\n")), structuredContent: out };
      },
    },

    // ── kernel_crm_set_lead_status ───────────────────
    {
      name: "kernel_crm_set_lead_status",
      description:
        "Move a lead through the pipeline: '' (ordinary contact), 'new', 'contacted', 'qualified', 'won', 'lost'. " +
        "Use right after `kernel_email_send` reaches a prospect → status='contacted'.",
      inputSchema: z.object({
        id: z.string().describe("Contact id."),
        status: LeadStatusEnum,
      }),
      outputSchema: z.object({
        id: z.string(),
        name: z.string(),
        lead_status: z.string(),
      }),
      tags: ["crm", "leads", "pipeline", "lifecycle"],
      handler: async (args) => {
        const { id, status } = args as { id: string; status: LeadStatus };
        const c = service.setLeadStatus(id, status);
        if (!c) return errorResult(`Contact not found: ${id}`);
        return structuredResult(
          { id: c.id, name: c.name, lead_status: c.lead_status },
          `**${c.name}** → lead_status=${c.lead_status}`,
        );
      },
    },
  ];
}
