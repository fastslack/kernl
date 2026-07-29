export type LeadStatus =
  | ""              // not a lead — ordinary CRM contact
  | "new"           // captured by prospector, awaiting copywriting
  | "drafted"       // copywriter wrote outreach drafts (in workspace), not yet sent
  | "contacted"     // first outreach actually sent
  | "qualified"     // responded, meets ICP
  | "won"           // converted
  | "lost";         // declined / unreachable / out of fit

export interface Contact {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  relationship: "personal" | "professional" | "family" | "acquaintance";
  notes: string;
  last_interaction: string | null;
  // ── Lead pipeline (v2) ─────────────────────────────────
  /** '' for ordinary contacts; named stage for leads. */
  lead_status: LeadStatus;
  /** Free-text origin (e.g. 'web-prospector', 'linkedin-export'). */
  lead_source: string;
  /** Social / web surfaces — empty string when unknown. */
  instagram_handle: string;
  linkedin_url: string;
  x_handle: string;
  website: string;
  created_at: string;
  updated_at: string;
}

export interface Interaction {
  id: string;
  contact_id: string;
  type: "email" | "call" | "meeting" | "message" | "social" | "other";
  summary: string;
  date: string;
  created_at: string;
}
