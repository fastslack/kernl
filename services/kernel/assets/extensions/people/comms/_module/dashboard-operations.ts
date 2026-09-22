/**
 * Comms operations the dashboard reaches over both the WS RPC and HTTP.
 *
 * The dashboard calls each of these through `rpcOrCall`, so the `comms.*` /
 * `emailSuggestions.*` action and its `/api/dashboard/comms/*` /
 * `/api/email-suggestions/*` route are the same request by two roads. They
 * were written twice and had drifted far apart:
 *   - `comms.update` over RPC handed every key of the request to the
 *     service, which writes `${key} = ?` — any column, any name, into SQL.
 *   - `comms.search` over RPC searched the Gmail mailbox and answered
 *     `{ results }`; the page renders the stored-communications array the
 *     route returns.
 *   - `comms.thread` read `thread_id` on both roads; the page sends `id`.
 *   - `comms.campaign` answered `{ campaign }` over RPC and the campaign's
 *     own fields over HTTP; the page reads `.campaign`.
 *   - `emailSuggestions.dismiss` over HTTP read `suggestion_id`; the
 *     dashboard sends `id`.
 * Now dashboard-rpc-actions.ts exposes these maps as is, the route files bind
 * each entry to its path, and where the shapes differed the answer carries
 * both (`{ ...comm, ok, comm }`), so neither road's reader breaks.
 */

import { HttpError, isHttpError, pickArgs, type Operation, type EventBus } from "@kernl/extension-sdk";
import type { CommsService } from "./service.js";
import type { EmailAnalysisService } from "./email-analysis-service.js";
import type { CommChannel, CommDirection, CommStatus } from "./types.js";

const CHANNELS: ReadonlyArray<CommChannel> = ["email", "whatsapp", "mattermost", "x", "instagram", "linkedin"];
const DIRECTIONS: ReadonlyArray<CommDirection> = ["inbound", "outbound"];
const STATUSES: ReadonlyArray<CommStatus> = ["draft", "ready", "sending", "sent", "failed", "archived"];

/** What a draft may be created with. */
const CREATE_FIELDS = {
  channel: "string", direction: "string", subject: "string", body: "string", body_html: "string",
  contact_id: "string", task_id: "string", account_id: "string", in_reply_to: "string",
  recipients_to: "string", recipients_cc: "string", recipients_bcc: "string",
} as const;
/** What the service lets a caller change on a draft; the references also take null. */
const UPDATE_FIELDS = {
  subject: "string", body: "string", body_html: "string", status: "string",
  recipients_to: "string", recipients_cc: "string", recipients_bcc: "string",
} as const;
const NULLABLE_UPDATE_FIELDS = ["scheduled_at", "contact_id", "task_id", "account_id"] as const;

function oneOf(value: string | undefined, allowed: ReadonlyArray<string>, key: string): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new HttpError(400, `Invalid ${key}. Allowed: ${allowed.join(", ")}`);
  }
}

/**
 * A failed write is the request's fault here (a draft with no recipients, a
 * provider that refuses): the route has always answered it 400 with the
 * error's message, and the RPC gets that message either way.
 */
async function asBadRequest<T>(fallback: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isHttpError(err)) throw err;
    throw new HttpError(400, err instanceof Error ? err.message : fallback);
  }
}

export function commsOperations(comms: CommsService, events?: EventBus | null): Record<string, Operation> {
  const changed = (action: string) => { events?.emit("data.changed", { module: "comms", action }); };
  const required = (input: Record<string, unknown>, key: string): string => {
    const value = pickArgs(input, { [key]: "string" } as Record<string, "string">)[key]?.trim() ?? "";
    if (!value) throw new HttpError(400, `Missing '${key}'`);
    return value;
  };

  return {
    "comms.create": (input) => asBadRequest("Bad request", () => {
      const fields = pickArgs(input, CREATE_FIELDS);
      oneOf(fields.channel, CHANNELS, "channel");
      oneOf(fields.direction, DIRECTIONS, "direction");
      const comm = comms.create(fields as Parameters<CommsService["create"]>[0]);
      changed("create");
      return { ...comm, ok: true, comm };
    }),

    "comms.send": (input) => asBadRequest("Send failed", async () => {
      const comm = await comms.sendEmail(required(input, "id"));
      return { ...comm, ok: true };
    }),

    "comms.update": (input) => asBadRequest("Bad request", () => {
      const id = required(input, "id");
      const changes: Record<string, unknown> = pickArgs(input, UPDATE_FIELDS);
      oneOf(changes.status as string | undefined, STATUSES, "status");
      for (const key of NULLABLE_UPDATE_FIELDS) {
        if (input[key] === null || typeof input[key] === "string") changes[key] = input[key];
      }
      const updated = comms.update(id, changes as Parameters<CommsService["update"]>[1]);
      if (!updated) throw new HttpError(400, "Cannot update (not found or not editable)");
      changed("update");
      return { ...updated, ok: true, comm: updated };
    }),

    "comms.search": (input) =>
      comms.searchStored(pickArgs(input, { q: "string", channel: "string", status: "string", direction: "string", limit: "number" })),

    // The page sends `id`; `thread_id` is what the route has always read.
    "comms.thread": (input) => {
      const { thread_id, id } = pickArgs(input, { thread_id: "string", id: "string" });
      const threadId = (thread_id || id || "").trim();
      if (!threadId) throw new HttpError(400, "Missing 'thread_id'");
      return comms.getThreadWithContactNames(threadId);
    },

    "comms.detail": (input) => {
      const detail = comms.getWithDetails(required(input, "id"));
      if (!detail) throw new HttpError(404, "Communication not found");
      return detail;
    },

    "comms.campaign": (input) => {
      const id = required(input, "id");
      const campaign = comms.getCampaign(id);
      if (!campaign) throw new HttpError(404, "Campaign not found");
      return { ...campaign, campaign, recipients: comms.getCampaignRecipients(id) };
    },
  };
}

/** `emailAnalysis` is null when the analysis service is not configured. */
export function emailSuggestionOperations(emailAnalysis: EmailAnalysisService | null): Record<string, Operation> {
  return {
    "emailSuggestions.list": (input) => {
      if (!emailAnalysis) return { available: false, suggestions: [] };
      const suggestions = emailAnalysis.getPendingSuggestions(pickArgs(input, { limit: "number" }).limit ?? 50);
      // Counts by type — cheap to compute, saves a second roundtrip
      // for the filter chips on the dashboard.
      const counts = { task: 0, reminder: 0, contact: 0, shopping: 0 };
      for (const s of suggestions) counts[s.type]++;
      return { available: true, suggestions, counts, total: suggestions.length, count: suggestions.length };
    },

    // The dashboard sends `id`; `suggestion_id` is what the route used to read.
    "emailSuggestions.dismiss": (input) => {
      if (!emailAnalysis) throw new HttpError(404, "Email analysis not available");
      const { id, suggestion_id } = pickArgs(input, { id: "string", suggestion_id: "string" });
      const target = id || suggestion_id;
      if (!target) throw new HttpError(400, "Missing 'id'");
      try {
        emailAnalysis.dismissSuggestion(target);
      } catch (err) {
        // The service's only failure is an id with no suggestion behind it.
        throw new HttpError(404, err instanceof Error ? err.message : String(err));
      }
      return { ok: true, success: true };
    },
  };
}
