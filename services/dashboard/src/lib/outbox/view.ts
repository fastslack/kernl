/** How a draft reads on screen: its channel, its text, its title, and the one-line glance a row and a detail share. */
import { requesterOf, cleanTitle, intentOf } from './review.js';

export type OutboxStatus = 'draft' | 'approved' | 'sending' | 'sent' | 'rejected' | 'failed';
export interface OutboxItem {
  id: string; project_id: string; flow_id: string; agent_id: string; channel: string; account_ref: string;
  payload: Record<string, unknown>; scheduled_for: string | null; status: OutboxStatus; review_note: string;
  sent_ref: string; error: string; created_at: string; sent_at?: string | null;
  preview: { title: string; body: string; meta?: Record<string, string>;
    /** A decision on the draft before approving it (where a request goes): written to payload[field]. */
    choice?: { field: string; label: string; value: string; options: Array<{ value: string; label: string; hint?: string }> } };
}
export interface OutboxProject { id: string; slug: string; name: string; offices?: Array<{ flow_id: string; name: string; active?: number | boolean }> }

export type ChannelKind = 'post' | 'mail' | 'chat';
const CHANNELS: Record<string, { label: string; kind: ChannelKind }> = {
  x_post: { label: 'Post en X', kind: 'post' },
  linkedin_post: { label: 'Post en LinkedIn', kind: 'post' },
  tiktok_post: { label: 'Video en TikTok', kind: 'post' },
  reddit_post: { label: 'Post en Reddit', kind: 'post' },
  social_post: { label: 'Post', kind: 'post' },
  web_change: { label: 'Pedido a Desarrollo', kind: 'post' },
  site_publish: { label: 'Publicar el sitio', kind: 'post' },
  email: { label: 'Mail', kind: 'mail' },
  email_campaign: { label: 'Campaña de mail', kind: 'mail' },
  whatsapp: { label: 'WhatsApp', kind: 'chat' },
};
export const channel = (c: string): { label: string; kind: ChannelKind } =>
  CHANNELS[c] ?? { label: c.replace(/_/g, ' '), kind: c.includes('mail') ? 'mail' : c.includes('whatsapp') ? 'chat' : 'post' };
export const CHANNEL_HUE: Record<ChannelKind, string> = { mail: '#FBBF24', chat: '#34D399', post: '#38BDF8' };

/** A draft whose payload carries its own text; a request with none (a publish) shows its preview instead of an empty box. */
export const hasOwnText = (it: OutboxItem) => typeof it.payload.text === 'string' || typeof it.payload.body === 'string';

/** What the draft says: its own text, else the channel's preview. */
export function bodyOf(it: OutboxItem): string {
  const own = typeof it.payload.text === 'string' ? it.payload.text : typeof it.payload.body === 'string' ? it.payload.body : '';
  return own || it.preview?.body || it.preview?.title || '';
}
const firstLine = (it: OutboxItem) => bodyOf(it).split('\n').find((l) => l.trim()) ?? '(sin texto)';

/** A mail reads by its subject, a draft with a title of its own by it, the rest by the first line of its text. */
export function rowTitle(it: OutboxItem): string {
  if (typeof it.payload.title === 'string' && it.payload.title.trim()) return it.payload.title.trim();
  return channel(it.channel).kind === 'mail' && it.preview?.title && it.preview.title !== it.channel ? it.preview.title : firstLine(it);
}

/** Who asks, what (without the requester's tag) and what approving it does. */
export function glance(it: OutboxItem, agent: string) {
  const who = requesterOf(it, agent);
  const ch = channel(it.channel);
  return { who, title: cleanTitle(rowTitle(it), who), intent: intentOf(it, ch.label, ch.kind), ch };
}

export const INTENT_LABEL: Record<string, string> = { draft: 'Al aprobar', failed: 'Al reintentar', approved: 'Al salir', sending: 'Saliendo', sent: 'Salió', rejected: 'Iba a' };

export function ago(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (Number.isNaN(m)) return '';
  const span = (n: number) => (n < 1 ? 'recién' : n < 60 ? `${n} min` : n < 1440 ? `${Math.round(n / 60)} h` : `${Math.round(n / 1440)} d`);
  if (m < 0) return `en ${span(-m)}`;
  return m < 1 ? 'recién' : `hace ${span(m)}`;
}
export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·';

/** Each project keeps its own color across the Bandeja. */
const HUES = ['#22D3EE', '#A78BFA', '#F472B6', '#34D399', '#FBBF24', '#60A5FA', '#FB923C'];
export const projectHue = (projects: Array<{ id: string }>, id: string | null | undefined) =>
  HUES[Math.max(0, projects.findIndex((p) => p.id === id)) % HUES.length];
