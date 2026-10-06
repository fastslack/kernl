/**
 * Replays a stored episode into the 3D chat panel's bubbles, so reopening the
 * panel continues the conversation instead of starting a blank one.
 *
 * Assistant turns from the streaming path keep their rich trace in
 * `content_blocks` (text, tool_use, tool_result); each tool_result is folded
 * into its tool_use the way the live stream does. Anything without blocks
 * falls back to the plain `content`. A user turn's attachments ride along
 * in `attachments` (only when it has any), metas or bare ids for the strip.
 */
import { parseContentBlocks, parseStoredMessage, storedAttachments } from './chat-view.js';
import type { AttachmentMeta } from './attachments/types.js';

export type HistoryBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      result?: string;
      is_error?: boolean;
    };

export type HistoryMessage = {
  role: 'user' | 'assistant';
  blocks: HistoryBlock[];
  attachments?: Array<AttachmentMeta | string>;
};

type StoredRow = { role: string; content?: string; content_blocks?: string; attachments?: AttachmentMeta[] };

export function storedToDisplay(rows: StoredRow[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const row of rows) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    const raw = parseContentBlocks(row.content_blocks);
    const blocks: HistoryBlock[] = [];
    for (const b of raw) {
      if (b?.type === 'text' && typeof b.text === 'string') {
        const last = blocks[blocks.length - 1];
        if (last?.type === 'text') last.text += b.text;
        else blocks.push({ type: 'text', text: b.text });
      } else if (b?.type === 'tool_use') {
        blocks.push({ type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input ?? {} });
      } else if (b?.type === 'tool_result') {
        const use = blocks.find((x) => x.type === 'tool_use' && x.id === b.tool_use_id);
        if (use && use.type === 'tool_use') {
          use.result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          use.is_error = !!b.is_error;
        }
      }
    }
    const attachments = storedAttachments(row);
    if (!blocks.length) {
      const text = parseStoredMessage(row.content ?? '').text;
      // An attachments-only message has no text and is still a turn.
      if (text) blocks.push({ type: 'text', text });
      else if (!attachments.length) continue;
    }
    out.push(attachments.length ? { role: row.role, blocks, attachments } : { role: row.role, blocks });
  }
  return out;
}
