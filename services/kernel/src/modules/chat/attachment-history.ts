/**
 * Chat episodes and attachments: the stored envelope and the per-request
 * conversion of history into LLM messages.
 *
 * A user message that carries attachments is stored as a JSON envelope in
 * `chat_messages.content`: `{ text, attachments: [ids] }`. Older rows used
 * `{ text, images: [paths], documents: [{path, filename}] }` with the files
 * under data/chat-images; those are still read (as text, like before).
 *
 * The history is converted once into plain messages plus a list of the
 * attachment-bearing user turns and their age; `materializeMessages` then
 * turns those into content blocks for one particular model (its caps), so a
 * fallback chain rebuilds them per link.
 */

import type { ChatMessage, ContentBlock } from "../../core/llm/chat-types.js";
import { TEXT_ONLY_CAPS } from "../../core/llm/input-caps.js";
import { buildRequestAttachmentBlocks, hasNativeBlocks, type AttachmentCaps, type BuildOptions } from "../attachments/blocks.js";
import type { AttachmentRecord } from "../attachments/types.js";

export interface ChatEnvelope {
  text: string;
  /** Attachment ids (attachments module). */
  attachments: string[];
  /** Legacy: paths under data/chat-images. */
  images: string[];
  /** Legacy: documents under data/chat-images. */
  documents: Array<{ path: string; filename: string }>;
}

/** Parse a stored user message. Null when it is plain text, not an envelope. */
export function parseEnvelope(content: string): ChatEnvelope | null {
  if (!content.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const attachments = strings(p.attachments);
  const images = strings(p.images);
  const documents = Array.isArray(p.documents)
    ? p.documents.filter((d): d is { path: string; filename: string } => !!d && typeof d === "object" && typeof (d as { path?: unknown }).path === "string")
    : [];
  // A user who typed JSON is not an envelope: one needs text plus something attached.
  if (typeof p.text !== "string" || (attachments.length === 0 && images.length === 0 && documents.length === 0 && !("documents" in p))) return null;
  return { text: p.text, attachments, images, documents };
}

/** The content column for a user message with attachments (legacy fields only when present). */
export function encodeEnvelope(env: { text: string; attachments?: string[]; images?: string[]; documents?: Array<{ path: string; filename: string }> }): string {
  const out: Record<string, unknown> = { text: env.text };
  if (env.attachments?.length) out.attachments = env.attachments;
  if (env.images?.length) out.images = env.images;
  if (env.documents?.length) out.documents = env.documents;
  return JSON.stringify(out);
}

/** A user turn whose attachments become blocks at request time. */
export interface AttachmentSlot {
  /** Index into the message list. */
  index: number;
  text: string;
  records: AttachmentRecord[];
  /** 0 = the current turn. */
  turnAge: number;
}

export interface PreparedHistory {
  messages: ChatMessage[];
  slots: AttachmentSlot[];
}

/**
 * Stored rows → LLM messages. User turns with attachment ids leave a slot
 * (their content is filled per model by `materializeMessages`); legacy
 * envelopes become their text, as they always did. Turn age counts the user
 * turns that came after.
 */
export function prepareHistory(
  rows: ReadonlyArray<{ role: "user" | "assistant" | "system"; content: string }>,
  getRecords: (ids: string[]) => AttachmentRecord[],
): PreparedHistory {
  const messages: ChatMessage[] = [];
  const pending: Array<Omit<AttachmentSlot, "turnAge"> & { userOrdinal: number }> = [];
  let userCount = 0;
  for (const row of rows) {
    const env = row.role === "user" ? parseEnvelope(row.content) : null;
    if (row.role === "user") userCount++;
    if (env && env.attachments.length > 0) {
      const records = getRecords(env.attachments);
      if (records.length > 0) {
        pending.push({ index: messages.length, text: env.text, records, userOrdinal: userCount });
        messages.push({ role: "user", content: env.text });
        continue;
      }
    }
    messages.push({ role: row.role, content: env ? env.text : row.content });
  }
  const slots = pending.map(({ userOrdinal, ...s }) => ({ ...s, turnAge: userCount - userOrdinal }));
  return { messages, slots };
}

export interface MaterializeOptions extends BuildOptions {
  /** Past turns go as text whatever the caps: for a provider that only takes
   *  blocks in the current prompt and carries history as a transcript. */
  historyAsText?: boolean;
}

/** The slot messages for one model, ready to drop into a message list. */
export interface FilledSlots {
  byIndex: Map<number, ChatMessage>;
  /** Whether any image or document block went out — a text-only retry could help. */
  native: boolean;
}

/**
 * Fill every slot for a model with `caps`: attachment blocks first, the
 * user's text last (skipped when empty — providers refuse empty text blocks).
 */
export function fillSlots(slots: readonly AttachmentSlot[], caps: AttachmentCaps, opts: MaterializeOptions = {}): FilledSlots {
  const byIndex = new Map<number, ChatMessage>();
  let native = false;
  const nativeSlots = opts.historyAsText ? slots.filter((s) => s.turnAge === 0) : slots;
  const textSlots = opts.historyAsText ? slots.filter((s) => s.turnAge > 0) : [];
  const fill = (group: readonly AttachmentSlot[], groupCaps: AttachmentCaps) => {
    if (group.length === 0) return;
    const blocks = buildRequestAttachmentBlocks(group.map((s) => ({ records: s.records, turnAge: s.turnAge })), groupCaps, opts);
    group.forEach((slot, i) => {
      const content: ContentBlock[] = [...blocks[i]];
      if (slot.text) content.push({ type: "text", text: slot.text });
      if (hasNativeBlocks(content)) native = true;
      byIndex.set(slot.index, { role: "user", content });
    });
  };
  fill(nativeSlots, caps);
  fill(textSlots, TEXT_ONLY_CAPS);
  return { byIndex, native };
}

/** A copy of `messages` with the filled slots in place. */
export function applySlots(messages: readonly ChatMessage[], filled: FilledSlots): ChatMessage[] {
  return messages.map((m, i) => filled.byIndex.get(i) ?? m);
}

/** `fillSlots` + `applySlots` in one go. */
export function materializeMessages(
  messages: readonly ChatMessage[],
  slots: readonly AttachmentSlot[],
  caps: AttachmentCaps,
  opts: MaterializeOptions = {},
): { messages: ChatMessage[]; native: boolean } {
  const filled = fillSlots(slots, caps, opts);
  return { messages: applySlots(messages, filled), native: filled.native };
}
