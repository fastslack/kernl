import { wsConnected, storeMap, data, ensureStore, agentFlowEvents, archEvents, notifications, unreadCount, type DashboardNotification } from './stores.js';
import { WS_CHANNEL_MAP } from './constants.js';

let ws: WebSocket | null = null;
let retryDelay = 1000;
const MAX_DELAY = 30000;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;

// Dynamic channel map — starts with hardcoded defaults, extended by manifest
const dynamicChannelMap: Record<string, string> = { ...WS_CHANNEL_MAP };

/** Merge manifest-provided wsChannelMap into the dynamic lookup */
export function mergeChannelMap(wsMap: Record<string, string[]>) {
	for (const [moduleKey, channels] of Object.entries(wsMap)) {
		for (const ch of channels) {
			if (!(ch in dynamicChannelMap)) {
				dynamicChannelMap[ch] = ch;
			}
		}
	}
}

// Cache of last JSON hash per store to avoid unnecessary re-renders
const lastHash: Record<string, string> = {};

// Fields to ignore when comparing (timestamps that change every tick)
const VOLATILE_FIELDS = ['lastRunAt', 'nextRunAt', 'runCount', 'lastRefresh', 'uptimeMs', 'uptimeFormatted'];

function stableHash(obj: unknown, depth = 0): string {
	if (depth > 4) return '~';  // Don't recurse too deep into large payloads
	if (obj === null || obj === undefined) return String(obj);
	if (typeof obj !== 'object') return String(obj);
	if (Array.isArray(obj)) {
		// For large arrays, sample instead of hashing every element
		if (obj.length > 20) return `[${obj.length}:${stableHash(obj[0], depth + 1)}:${stableHash(obj[obj.length - 1], depth + 1)}]`;
		return '[' + obj.map(v => stableHash(v, depth + 1)).join(',') + ']';
	}
	const sorted = Object.keys(obj as Record<string, unknown>)
		.filter(k => !VOLATILE_FIELDS.includes(k))
		.sort()
		.map(k => `${k}:${stableHash((obj as Record<string, unknown>)[k], depth + 1)}`);
	return '{' + sorted.join(',') + '}';
}

function updateIfChanged(store: { set: (v: unknown) => void }, key: string, newData: unknown): boolean {
	const newHash = stableHash(newData);
	if (lastHash[key] === newHash) {
		return false;
	}
	lastHash[key] = newHash;
	store.set(newData);
	return true;
}

// ── mtwRequest connection (Rust) ────────────────────────────

let mtwWs: WebSocket | null = null;
let mtwConnected = false;
let subscribedChannels = new Set<string>();

function mtwWsUrl(): string {
	const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
	return p + '//' + location.host + '/mtw';
}


/** Subscribe to a channel on mtwRequest */
function mtwSubscribe(channel: string) {
	subscribedChannels.add(channel);
	if (!mtwWs || mtwWs.readyState !== WebSocket.OPEN) {
		// No live WS (e.g. the zero-config stack has no mtwRequest broker).
		// Hydrate the channel store over HTTP so push-driven pages still load.
		void hydrateChannelHttp(channel);
		return;
	}
	mtwWs.send(JSON.stringify({
		id: crypto.randomUUID(),
		type: 'subscribe',
		channel,
		payload: { kind: 'None' },
		metadata: {},
		timestamp: Date.now(),
	}));
}

/** HTTP fallback for a single channel: fetch the kernel's snapshot and apply
 *  it to the matching store using the same channel→store mapping the WS path
 *  uses. Silent on failure — the page keeps its empty state. */
async function hydrateChannelHttp(channel: string): Promise<void> {
	try {
		const r = await fetch(`/api/channel/${encodeURIComponent(channel)}`);
		if (!r.ok) return;
		const msgData = await r.json();
		const key = dynamicChannelMap[channel] || channel;
		if (key === 'data') updateIfChanged(data, 'data', msgData);
		else if (key in storeMap) updateIfChanged(storeMap[key], key, msgData);
		else updateIfChanged(ensureStore(key), key, msgData);
	} catch { /* offline / unknown channel — leave the store as-is */ }
}

/** Re-poll every subscribed channel over HTTP. Driven by the fallback timer
 *  while the WS is down so the dashboard stays reasonably fresh in the
 *  zero-config stack. */
export function pollSubscribedChannels(): void {
	if (mtwWs && mtwWs.readyState === WebSocket.OPEN) return; // live WS covers it
	for (const ch of subscribedChannels) void hydrateChannelHttp(ch);
}

// ── RPC request/response ──────────────────────────────────

const pendingRpc = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

/** Send an RPC request via mtwRequest WebSocket. Returns response data. */
export function rpc(action: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (!mtwWs || mtwWs.readyState !== WebSocket.OPEN) {
			reject(new Error('WebSocket not connected'));
			return;
		}
		const id = crypto.randomUUID();
		const timer = setTimeout(() => {
			pendingRpc.delete(id);
			reject(new Error(`RPC timeout: ${action}`));
		}, timeoutMs);
		pendingRpc.set(id, { resolve, reject, timer });
		mtwWs.send(JSON.stringify({
			id,
			type: 'publish',
			channel: 'rpc',
			payload: { kind: 'Json', data: { action, args, _requestId: id } },
			metadata: {},
			timestamp: Date.now(),
		}));
	});
}

/** Check if WebSocket is connected */
export function wsIsConnected(): boolean {
	return mtwConnected && !!mtwWs && mtwWs.readyState === WebSocket.OPEN;
}

/** RPC with instant HTTP fallback — no waiting for WS timeout */
export async function rpcOrFetch(action: string, args: Record<string, unknown>, httpUrl: string): Promise<unknown> {
	if (wsIsConnected()) {
		try {
			const result = await rpc(action, args, 5000);
			console.debug(`[WS] ${action}`);
			return result;
		} catch { /* fall through to HTTP */ }
	}
	console.debug(`[HTTP] ${action} → ${httpUrl}`);
	const res = await fetch(httpUrl);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

/** RPC with generic HTTP fallback — races the WS path against HTTP so a flaky
 *  bridge never blocks the UI. WS usually responds in <100ms; if it hasn't
 *  responded in 800ms, HTTP fires in parallel and whichever returns first wins. */
export async function rpcOrCall<T = unknown>(action: string, args: Record<string, unknown>, httpFallback: () => Promise<T>): Promise<T> {
	if (!wsIsConnected()) {
		console.debug(`[HTTP] ${action} (WS disconnected)`);
		return httpFallback();
	}

	let settled = false;
	const wsPromise: Promise<T> = rpc(action, args, 3000)
		.then((r) => {
			if (!settled) { settled = true; console.debug(`[WS] ${action}`); }
			return r as T;
		})
		.catch((e) => {
			console.debug(`[WS] ${action} failed`, e);
			throw e;
		});

	const httpPromise: Promise<T> = new Promise<T>((resolve, reject) => {
		setTimeout(() => {
			if (settled) return;
			console.debug(`[HTTP] ${action} (WS slow, racing fallback)`);
			httpFallback().then((v) => {
				if (!settled) settled = true;
				resolve(v);
			}, reject);
		}, 800);
	});

	try {
		return await Promise.race([wsPromise, httpPromise]);
	} catch {
		// Both racers failed — last resort: one more HTTP attempt.
		return httpFallback();
	}
}

/** Handle a message from mtwRequest (MtwMessage format) */
function handleMtwMessage(msg: any, onMessage?: () => void) {
	// Handle RPC responses (correlated by ref_id — top-level field in MtwMessage)
	const refId = msg.ref_id ?? msg.metadata?.ref_id;
	if ((msg.type === 'response' || msg.type === 'error') && refId) {
		const payload = msg.payload?.kind === 'Json' ? msg.payload.data : null;
		// Skip publish ACKs — these are confirmations from mtwRequest, not RPC responses
		if (payload && typeof payload === 'object' && 'published' in payload) {
			return; // Ignore {published: "rpc", recipients: N}
		}
		const pending = pendingRpc.get(refId);
		if (pending) {
			clearTimeout(pending.timer);
			pendingRpc.delete(refId);
			if (msg.type === 'error' || payload?.ok === false) {
				pending.reject(new Error(payload?.error ?? 'RPC error'));
			} else {
				pending.resolve(payload?.data ?? payload);
			}
			return;
		}
	}

	// Skip other ack/response/error messages (subscribe confirmations etc.)
	if (msg.type === 'response' || msg.type === 'ack' || msg.type === 'error') return;

	// Channel-based messages: msg.type === 'event' or 'publish', data in msg.payload
	const channel = msg.channel;
	if (!channel) return;

	// Skip RPC channel messages in the store handler (handled above via ref_id)
	if (channel === 'rpc') return;

	// TEMP DEBUG: log everything on agents.flow
	if (channel === 'agents.flow') {
		console.log('[WS DEBUG agents.flow]', JSON.stringify(msg).slice(0, 500));
	}

	let msgData: unknown;
	if (msg.payload?.kind === 'Json') {
		msgData = msg.payload.data;
	} else if (msg.payload?.kind === 'Text') {
		try { msgData = JSON.parse(msg.payload.data); } catch { msgData = msg.payload.data; }
	} else {
		return;
	}

	// Special event types embedded in data (agentFlow, archEvent, notification)
	if (typeof msgData === 'object' && msgData !== null && 'type' in (msgData as any)) {
		const inner = msgData as Record<string, unknown>;
		if (inner.type === 'agentFlow') {
			agentFlowEvents.update(events => {
				const updated = [{ event: inner.event, data: inner.data, ts: inner.ts }, ...events];
				// 100 was too tight: a rounds=10/15/20 meeting plus background
				// agent activity easily exceeds it within minutes, evicting
				// meeting_ended before AgentWorld3D's processEvents picked it
				// up — the live meeting indicator would then stay stuck.
				return updated.slice(0, 1000);
			});
			return;
		}
		if (inner.type === 'archEvent') {
			archEvents.update(events => {
				const updated = [{ event: inner.event, data: inner.data, ts: inner.ts }, ...events];
				return updated.slice(0, 200);
			});
			return;
		}
		if (inner.type === 'notification') {
			const n = inner.data as DashboardNotification;
			notifications.update(list => [n, ...list].slice(0, 100));
			unreadCount.update(c => c + 1);
			return;
		}
	}

	// Map channel to store (same logic as legacy WS)
	const key = dynamicChannelMap[channel] || channel;
	let changed = false;
	if (key === 'data') {
		changed = updateIfChanged(data, 'data', msgData);
	} else if (key in storeMap) {
		changed = updateIfChanged(storeMap[key], key, msgData);
	} else {
		const store = ensureStore(key);
		changed = updateIfChanged(store, key, msgData);
	}
	if (changed) onMessage?.();
}

const onConnectedCbs: Array<() => void> = [];

/** Subscribe to page-specific channels. Call on page mount. */
export function wsSubscribeChannels(channels: string[]) {
	for (const ch of channels) mtwSubscribe(ch);
}

/** Unsubscribe from page-specific channels. Call on page destroy. */
export function wsUnsubscribeChannels(channels: string[]) {
	if (!mtwWs || mtwWs.readyState !== WebSocket.OPEN) return;
	for (const ch of channels) {
		if (!subscribedChannels.has(ch)) continue;
		subscribedChannels.delete(ch);
		mtwWs.send(JSON.stringify({
			id: crypto.randomUUID(),
			type: 'unsubscribe',
			channel: ch,
			payload: { kind: 'None' },
			metadata: {},
			timestamp: Date.now(),
		}));
	}
}

/** Register a callback that fires every time WS (re)connects */
export function onWsConnected(cb: () => void) {
	onConnectedCbs.push(cb);
}

function connectMtwRequest(onMessage?: () => void) {
	const url = mtwWsUrl();
	console.log('[WS] connecting to', url);
	try {
		mtwWs = new WebSocket(url);
	} catch (e) {
		console.error('[WS] constructor failed:', e);
		return;
	}

	mtwWs.onopen = () => {
		mtwConnected = true;
		wsConnected.set(true);
		console.log('[WS] connected');
		retryDelay = 1000;
		if (fallbackTimer) {
			clearInterval(fallbackTimer);
			fallbackTimer = null;
		}

		// Subscribe only to essential channels — pages subscribe to their own
		const essentialChannels = ['dashboard', 'notifications', 'rpc'];
		for (const ch of essentialChannels) {
			mtwSubscribe(ch);
		}

		// Notify layout to re-fetch init data via RPC
		for (const cb of onConnectedCbs) cb();
	};

	mtwWs.onmessage = (ev) => {
		try {
			const msg = JSON.parse(ev.data);
			handleMtwMessage(msg, onMessage);
		} catch {
			// ignore parse errors
		}
	};

	mtwWs.onclose = (ev) => {
		console.log('[WS] closed:', ev.code, ev.reason);
		mtwConnected = false;
		subscribedChannels.clear();
		disconnected(onMessage);
	};

	mtwWs.onerror = (ev) => { console.error('[WS] error:', ev); if (mtwWs) mtwWs.close(); };
}

// ── Public API ─────────────────────────────────────────────

export function wsConnect(onMessage?: () => void) {
	connectMtwRequest(onMessage);
}

function disconnected(onMessage?: () => void) {
	wsConnected.set(false);
	mtwWs = null;
	if (!fallbackTimer) {
		fallbackTimer = setInterval(() => { pollSubscribedChannels(); onMessage?.(); }, 60000);
	}
	// Immediate first poll so the page doesn't wait a full interval to hydrate.
	pollSubscribedChannels();
	scheduleRetry(onMessage);
}

function scheduleRetry(onMessage?: () => void) {
	setTimeout(() => connectMtwRequest(onMessage), retryDelay);
	retryDelay = Math.min(retryDelay * 2, MAX_DELAY);
}

export function wsDisconnect() {
	if (mtwWs) {
		mtwWs.close();
		mtwWs = null;
	}
	if (fallbackTimer) {
		clearInterval(fallbackTimer);
		fallbackTimer = null;
	}
	subscribedChannels.clear();
}
