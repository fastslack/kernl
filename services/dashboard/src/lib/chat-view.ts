/**
 * Pure view logic for the chat page: reading what the server stored, deciding
 * where an image comes from, labelling a provider, and breaking the transcript
 * into days.
 *
 * Extracted verbatim from `routes/chat/+page.svelte`. Everything that touched
 * component state (`appendError`, the send/stream handlers, the menu) stayed
 * behind — this module is pure and testable.
 */

import { isClaudeCodeAuthError } from './claude-code-auth.js';

/**
 * Does a stored message carry a Claude Code auth error? Checks the plain
 * content first, then the serialized content blocks. Never throws on a
 * malformed `content_blocks` payload.
 */
export function msgAuthError(m: any): boolean {
  if (isClaudeCodeAuthError(m?.content)) return true;
  try {
    const blocks = typeof m?.content_blocks === 'string' ? JSON.parse(m.content_blocks) : m?.content_blocks;
    if (!Array.isArray(blocks)) return false;
    return isClaudeCodeAuthError(blocks.map((b: any) => b?.text ?? '').join(' '));
  } catch {
    return false;
  }
}

/** The live bubble is a separate render path and needs the same affordance. */
export function streamAuthError(blocks: any[]): boolean {
  return isClaudeCodeAuthError((blocks ?? []).filter((b) => b?.type === 'text').map((b) => b?.text ?? '').join(' '));
}

/** Parse the serialized block array, tolerating junk and missing values. */
export function parseContentBlocks(raw: string | undefined): any[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/** A stored message, once unpacked. */
export interface StoredMessage {
  text: string;
  images: string[];
  documents: Array<{ filename?: string; path?: string }>;
  local: boolean;
}

/**
 * Messages are stored either as plain text or as a JSON envelope carrying
 * attachments. Anything that isn't a parseable envelope is treated as prose,
 * so an agent that happens to write a `{` never loses its message.
 */
export function parseStoredMessage(raw: string): StoredMessage {
  if (!raw || !raw.startsWith('{')) return { text: raw, images: [], documents: [], local: false };
  try {
    const p = JSON.parse(raw);
    if (typeof p !== 'object' || p === null) return { text: raw, images: [], documents: [], local: false };
    const images: string[] = Array.isArray(p.images) ? p.images : [];
    const docs: Array<{ filename?: string; path?: string }> = Array.isArray(p.documents)
      ? p.documents.map((d: any) => typeof d === 'string' ? { path: d } : { filename: d?.filename, path: d?.path })
      : [];
    return { text: typeof p.text === 'string' ? p.text : '', images, documents: docs, local: !!p._local };
  } catch {
    return { text: raw, images: [], documents: [], local: false };
  }
}

/** Where an image in the transcript is served from. */
export function imageSrc(ref: string, local: boolean): string {
  // Local echoes already hold a data: URL preview. Persisted refs are relative paths served by /api/chat/images.
  if (local || ref.startsWith('data:') || ref.startsWith('http')) return ref;
  return '/api/chat/images?path=' + encodeURIComponent(ref);
}

/** One-letter badge for a provider. */
export function providerIcon(p: string | undefined): string {
  if (!p) return 'M';
  const map: Record<string, string> = { anthropic: 'A', openai: 'O', lmstudio: 'L', ollama: 'O' };
  return map[p.toLowerCase()] || p[0]?.toUpperCase() || 'M';
}

/** Accent colour for a provider, falling back to the theme gold. */
export function providerColor(p: string | undefined): string {
  if (!p) return 'var(--gold)';
  const map: Record<string, string> = {
    anthropic: '#D4A84B', claude: '#D4A84B', 'claude-code': '#D4A84B',
    openai: '#3DD68C', lmstudio: '#8B7CF6', ollama: '#5B9BF7',
    grok: '#E0E0E0', nvidia: '#76B900',
  };
  return map[p.toLowerCase()] || 'var(--gold)';
}

/** Context-window chip: "128k ctx". Empty when there is nothing to show. */
export function fmtCtx(n?: number): string {
  if (!n || n <= 0) return '';
  if (n >= 1000) return `${Math.round(n / 1000)}k ctx`;
  return `${n} ctx`;
}

/** True when this message opens a new day in the transcript. */
export function isDateBreak(msgs: any[], idx: number): boolean {
  if (idx === 0) return true;
  const prev = new Date(msgs[idx - 1].created_at).toDateString();
  const curr = new Date(msgs[idx].created_at).toDateString();
  return prev !== curr;
}

/** The separator label: Today, Yesterday, or the full date. */
export function formatDateBreak(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
