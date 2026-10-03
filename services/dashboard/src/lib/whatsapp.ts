/**
 * WhatsApp linking client (Task 8) — talks to the Task 7 dashboard
 * operations (`channels.whatsapp.*`) over `rpcOrCall` (WS first, HTTP
 * fallback, same pattern the settings page already uses for every other
 * channel action) and exposes the mtwRequest live channels
 * (`whatsapp:status`, `whatsapp:qr`, `whatsapp:pairing`) as a single
 * subscription for `WhatsAppCard`.
 */
import { rpcOrCall, wsSubscribeChannels, wsUnsubscribeChannels, wsIsConnected } from './ws.js';
import { ensureStore, wsConnected } from './stores.js';

export interface WaStatus {
  bridge_connected: boolean;
  state: string; // idle | linking | connected | disconnected | logged_out | unknown
  mode?: string;
  jid?: string;
  reason?: string;
  qr?: string;
  pairing_code?: string;
  pairing_expires_at?: number;
  phoneNumber?: string;
  /** `process.platform` of the kernel (`win32` has no bridge). */
  platform?: string;
}

export interface ChatItem {
  jid: string;
  name: string;
  is_group: boolean;
  last_ts: number;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  code?: string;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

async function jpost<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: jsonHeaders, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/**
 * Reject the input outright if it contains anything other than digits,
 * spaces, or `+ - ( ) .` — a stray letter is a typo, not something to
 * silently drop. Only once that charset check passes does it strip the
 * punctuation and check the shape: country code first, no leading 0, 8-15
 * digits.
 *
 * Same rule as the kernel's `normalizePhone`
 * (services/kernel/assets/extensions/channels/whatsapp/_module/whatsapp-provider.ts)
 * and `normalizeWhatsAppPhone` (dashboard operations module); keep the three
 * in step.
 */
const PHONE_ALLOWED_CHARS = /^[0-9\s+\-().]*$/;
export function normalizePhone(raw: string): string | null {
  const s = String(raw ?? '');
  if (!PHONE_ALLOWED_CHARS.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  return /^[1-9][0-9]{7,14}$/.test(digits) ? digits : null;
}

/**
 * The whatsapp-bridge sends `pairing_expires_at`/`expires_at` as Unix
 * SECONDS (bridge `session.go`: `time.Now().Add(pairingTTL).Unix()`;
 * protocol.md says "Unix timestamp (seconds)" explicitly) and nothing
 * upstream of the dashboard converts it. The card compares it against
 * `Date.now()`, which is milliseconds — so every code looked expired the
 * instant it arrived unless this normalizes it once, here, for every road
 * the value can take: the `channels.whatsapp.status` read (WS or HTTP) and
 * the `whatsapp:pairing` live push. Heuristic: a seconds-scale timestamp
 * today is ~1.7e9; a millisecond-scale one is ~1.7e12 — anything under 1e12
 * is seconds.
 */
export function toEpochMs(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return raw < 1e12 ? raw * 1000 : raw;
}

export async function waStatus(): Promise<WaStatus> {
  const s = await rpcOrCall<WaStatus>('channels.whatsapp.status', {}, () => jget('/api/channels/whatsapp/status'));
  if (typeof s.pairing_expires_at === 'number') s.pairing_expires_at = toEpochMs(s.pairing_expires_at);
  return s;
}

export function waLink(mode: 'qr' | 'phone', phone?: string): Promise<ActionResult> {
  const args: Record<string, unknown> = { mode };
  if (phone) args.phone = phone;
  return rpcOrCall<ActionResult>('channels.whatsapp.link', args, () => jpost('/api/channels/whatsapp/link', args));
}

export function waCancel(): Promise<ActionResult> {
  return rpcOrCall<ActionResult>('channels.whatsapp.link_cancel', {}, () => jpost('/api/channels/whatsapp/link/cancel'));
}

export function waChats(limit = 50): Promise<{ ok: boolean; items: ChatItem[]; error?: string }> {
  return rpcOrCall('channels.whatsapp.chats', { limit }, () => jget(`/api/channels/whatsapp/chats?limit=${limit}`));
}

export function waLogout(): Promise<ActionResult> {
  return rpcOrCall<ActionResult>('channels.whatsapp.logout', {}, () => jpost('/api/channels/whatsapp/logout'));
}

export interface WaConfig {
  schema: Array<Record<string, unknown>>;
  config: Record<string, unknown>;
}

/** Current `channels.schema` for id "whatsapp" (allowedNumbers, defaultChat…). */
export async function waLoadConfig(): Promise<WaConfig> {
  const data = await rpcOrCall<{ schema?: Array<Record<string, unknown>>; config?: Record<string, unknown> }>(
    'channels.schema',
    { id: 'whatsapp' },
    () => jget('/api/channels/schema?id=whatsapp'),
  );
  return { schema: data.schema ?? [], config: data.config ?? {} };
}

/**
 * Adds or removes one allowlist entry on a stored `allowedNumbers` CSV and
 * returns the resulting list (trimmed, no blanks, no duplicates).
 */
export function editAllowedCsv(csv: unknown, op: 'add' | 'remove', entry: string): string[] {
  const list = (typeof csv === 'string' ? csv : '').split(',').map((s) => s.trim()).filter(Boolean);
  const unique = [...new Set(list)];
  if (op === 'remove') return unique.filter((n) => n !== entry);
  return unique.includes(entry) ? unique : [...unique, entry];
}

/**
 * Read-modify-write of `allowedNumbers` against the stored config, never the
 * card's local copy: the kernel fills the linked number in on its own right
 * after linking, and a stale local list would erase it.
 */
export async function waEditAllowed(op: 'add' | 'remove', entry: string): Promise<string[]> {
  const current = await waLoadConfig();
  const list = editAllowedCsv(current.config.allowedNumbers, op, entry);
  const config = { ...current.config, allowedNumbers: list.join(',') };
  await rpcOrCall('channels.config.save', { id: 'whatsapp', config }, () =>
    jpost('/api/channels/config', { id: 'whatsapp', config }),
  );
  return list;
}

/** Merges `patch` into the stored WhatsApp config and saves it (also pushes into the running provider — see Task 7). */
export async function waSaveConfig(patch: Record<string, unknown>): Promise<void> {
  const current = await waLoadConfig();
  const config = { ...current.config, ...patch };
  await rpcOrCall('channels.config.save', { id: 'whatsapp', config }, () =>
    jpost('/api/channels/config', { id: 'whatsapp', config }),
  );
}

export function waTest(): Promise<{ success: boolean }> {
  return rpcOrCall('channels.test', { id: 'whatsapp' }, () => jpost('/api/channels/test', { id: 'whatsapp' }));
}

// ── Live status ──────────────────────────────────────────────────────

const WA_CHANNELS = ['whatsapp:status', 'whatsapp:qr', 'whatsapp:pairing'];

/** The session states `whatsapp:status` carries; anything else is not a session state. */
const SESSION_STATES = new Set(['idle', 'linking', 'connected', 'disconnected', 'logged_out', 'unknown']);

/**
 * Whether a `whatsapp:status` push is a session state the card may adopt.
 * Older mtw-server builds also published `ready`, `paired`, `ack` (every
 * send) and `error` there; those would flip a linked card to "unlinked".
 */
export function isSessionStatus(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const state = (data as Record<string, unknown>).state;
  return typeof state === 'string' && SESSION_STATES.has(state);
}

/**
 * Subscribes to the three mtwRequest WhatsApp channels and delivers every
 * genuine push to `cb`. mtwRequest pushes land in a per-channel store
 * (`ensureStore`, see `ws.ts`'s `handleMtwMessage` — any channel without a
 * static mapping in `WS_CHANNEL_MAP`/the manifest gets one created on the
 * fly), so subscribing to those three stores is enough; nothing else needs
 * touching in `ws.ts`.
 *
 * Three fixes folded in (fix round 1), all about the same root cause —
 * nothing here is a fresh-per-mount value, it is all module-level state
 * that outlives the component:
 *
 * 1. `ensureStore(ch).subscribe()` replays synchronously, on subscribe,
 *    whatever that channel's LAST value was — possibly from a previous
 *    mount (stale "linking", an old QR/code). That replay happens before
 *    any real push possibly could, so the first emission per channel is
 *    always the replay and is dropped; only later emissions are genuine.
 * 2. `wsSubscribeChannels` only actually sends anything when the socket is
 *    OPEN right now (`mtwSubscribe` in `ws.ts`); a full reload runs this
 *    mount before the layout's `wsConnect`, and a dropped/retried socket
 *    clears `subscribedChannels` on `onclose`. So this (re)subscribes on
 *    every (re)connect via the `wsConnected` store, not just once at
 *    mount — same intent as `+layout.svelte`'s
 *    `onWsConnected(() => subscribePageChannels())`, but through the store
 *    because `onWsConnected` has no way to unregister a callback, which a
 *    component that mounts/unmounts repeatedly needs.
 * 3. The 2s poll fallback (no live WS) must poll only while linking is in
 *    progress — but this module keeps no status of its own, so it asks the
 *    card via `getState`. Without a live push AND without `getState`
 *    saying "linking", nothing here would ever learn the user just started
 *    a link attempt.
 */
export function subscribeWaLive(
  cb: (ev: { channel: string; data: unknown }) => void,
  getState?: () => string,
): () => void {
  const firstEmission: Record<string, boolean> = {};
  for (const ch of WA_CHANNELS) firstEmission[ch] = true;

  const unsubStores = WA_CHANNELS.map((ch) =>
    ensureStore(ch).subscribe((value) => {
      if (firstEmission[ch]) { firstEmission[ch] = false; return; } // the stale replay, not a real push
      if (value == null) return;
      if (ch === 'whatsapp:status' && !isSessionStatus(value)) return;
      let data: unknown = value;
      if (ch === 'whatsapp:pairing' && typeof value === 'object' && value !== null) {
        const v = value as Record<string, unknown>;
        if (typeof v.expires_at === 'number') data = { ...v, expires_at: toEpochMs(v.expires_at) };
      }
      cb({ channel: ch, data });
    }),
  );

  // On every (re)connect: subscribe, then read the authoritative status, so
  // a stale history replay (or anything missed while the socket was down) is
  // corrected at once.
  let closed = false;
  const unsubConnected = wsConnected.subscribe((connected) => {
    if (!connected) return;
    wsSubscribeChannels(WA_CHANNELS);
    waStatus()
      .then((s) => { if (!closed) cb({ channel: 'whatsapp:status', data: s }); })
      .catch(() => { /* the card keeps what it has */ });
  });

  const poll = setInterval(() => {
    if (wsIsConnected()) return;
    if (getState && getState() !== 'linking') return;
    waStatus()
      .then((s) => cb({ channel: 'whatsapp:status', data: s }))
      .catch(() => { /* try again next tick */ });
  }, 2000);

  return () => {
    closed = true;
    for (const u of unsubStores) u();
    unsubConnected();
    wsUnsubscribeChannels(WA_CHANNELS);
    clearInterval(poll);
  };
}
