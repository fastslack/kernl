/**
 * How a dashboard action picks between the WS RPC and its HTTP twin.
 *
 * The kernel runs one function behind both roads, so either answer is the
 * same answer. What is NOT the same is running it twice. Racing the two roads
 * (HTTP fires if WS has not answered in 800ms) is harmless for a read and a
 * double write for anything else: a slow `agents.run` started two runs, a
 * slow create made two rows. And retrying over HTTP after the kernel already
 * answered with an error just asks the same question again and runs the
 * mutation a second time.
 *
 * So: reads race; writes go by WS and use HTTP only when the WS never sent
 * them; an error the kernel answered is final on both.
 */

/** The kernel answered this request with an error: the request arrived and ran. */
export class RpcAnsweredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RpcAnsweredError';
	}
}

/** Not sent at all: the socket was down when the request was made. */
export class RpcNotSentError extends Error {
	constructor(action: string) {
		super(`WebSocket not connected: ${action}`);
		this.name = 'RpcNotSentError';
	}
}

/** Same suffixes the kernel's RPC handler treats as read-only. */
const READ_SUFFIXES = ['.list', '.detail', '.get', '.search', '.count', '.stats', '.export'];

export function isReadAction(action: string): boolean {
	return action.startsWith('dashboard.') || READ_SUFFIXES.some((s) => action.endsWith(s));
}

export interface CallRoads<T> {
	action: string;
	connected: boolean;
	ws: (timeoutMs: number) => Promise<T>;
	http: () => Promise<T>;
	/** How long a read waits for WS before HTTP joins the race. */
	raceAfterMs?: number;
}

export async function callWithFallback<T>({ action, connected, ws, http, raceAfterMs = 800 }: CallRoads<T>): Promise<T> {
	if (!connected) return http();

	if (!isReadAction(action)) {
		try {
			return await ws(10_000);
		} catch (err) {
			// Only a request that never left can safely go again. A timeout
			// may have run on the kernel, and an answered error did.
			if (err instanceof RpcNotSentError) return http();
			throw err;
		}
	}

	let settled = false;
	const viaWs = ws(3000).then(
		(r) => { settled = true; return r; },
		(err) => { settled = true; throw err; },
	);
	const viaHttp = new Promise<T>((resolve, reject) => {
		setTimeout(() => {
			if (settled) return;
			http().then(resolve, reject);
		}, raceAfterMs);
	});
	try {
		return await Promise.race([viaWs, viaHttp]);
	} catch (err) {
		if (err instanceof RpcAnsweredError) throw err;
		// Transport trouble on a read — one more HTTP attempt is harmless.
		return http();
	}
}
