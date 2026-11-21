// A user's session on the live socket: only `changes` reaches the broker,
// page channels load over HTTP and are refetched when a change is announced,
// and RPC goes over the socket.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

class FakeSocket {
	static OPEN = 1;
	static last: FakeSocket | null = null;
	readyState = 0;
	sent: any[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onclose: ((ev: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public url: string) { FakeSocket.last = this; }
	send(s: string) { this.sent.push(JSON.parse(s)); }
	close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
	open() { this.readyState = 1; this.onopen?.(); }
	receive(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const fetched: string[] = [];
const saved: Record<string, unknown> = {};
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
	for (const k of ['WebSocket', 'location', 'localStorage', 'fetch']) saved[k] = (globalThis as any)[k];
	(globalThis as any).WebSocket = FakeSocket;
	(globalThis as any).location = { protocol: 'http:', host: 'kernl.test' };
	(globalThis as any).localStorage = { getItem: () => 'kul_user' };
	(globalThis as any).fetch = async (url: string) => {
		fetched.push(url);
		return { ok: true, json: async () => ({ from: 'http' }) };
	};
});

afterAll(async () => {
	const { wsDisconnect } = await import('./ws.js');
	wsDisconnect();
	for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v;
});

describe("a user's live socket", () => {
	it('subscribes to changes alone, keeps page channels on HTTP and refetches them on a change', async () => {
		const ws = await import('./ws.js');
		ws.wsConnectAsUser();
		const sock = FakeSocket.last!;
		expect(sock.url).toBe('ws://kernl.test/mtw?token=kul_user');
		sock.open();
		expect(sock.sent.filter((m) => m.type === 'subscribe').map((m) => m.channel)).toEqual(['changes']);

		ws.wsSubscribeChannels(['agents']);
		await tick();
		expect(sock.sent.some((m) => m.channel === 'agents')).toBe(false);
		expect(fetched).toContain('/api/channel/agents');

		fetched.length = 0;
		sock.receive({ id: 'n1', type: 'publish', channel: 'changes', payload: { kind: 'Json', data: { module: 'agents', ts: 1 } }, metadata: {} });
		sock.receive({ id: 'n2', type: 'publish', channel: 'changes', payload: { kind: 'Json', data: { module: 'tasks', ts: 2 } }, metadata: {} });
		await tick(300);
		// One refetch for the burst.
		expect(fetched).toEqual(['/api/channel/agents']);

		ws.wsUnsubscribeChannels(['agents']);
		expect(sock.sent.some((m) => m.type === 'unsubscribe')).toBe(false);
	});

	it('sends RPC over the socket and takes the reply addressed to it', async () => {
		const ws = await import('./ws.js');
		const sock = FakeSocket.last!;
		const p = ws.rpc('agents.list', {});
		const req = sock.sent.at(-1);
		expect(req).toMatchObject({ type: 'publish', channel: 'rpc', payload: { data: { action: 'agents.list' } } });
		sock.receive({ id: 'x', type: 'response', channel: 'rpc', ref_id: req.id, payload: { kind: 'Json', data: { ok: true, data: { agents: [] } } }, metadata: { reply_to: 'c1' } });
		expect(await p).toEqual({ agents: [] });
	});
});
