/**
 * `apiFetch` turns a non-2xx response into `Error(body.error)` and drops the
 * status; RPC errors arrive as `Error(message)`. These helpers turn both into
 * outcomes the wizard can act on.
 */
export type CreateError = { reason: 'exists'; officeId: string } | { reason: 'error'; message: string };
export type DraftError =
	/** The model answered, but not with a usable office. `detail` is the
	 *  validation failure and `model` the chain link that produced it — both
	 *  optional, since an older kernel sends neither. */
	| { reason: 'invalid'; detail?: string; model?: string }
	| { reason: 'input'; message: string }
	| { reason: 'error'; message: string };

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function parseCreateError(err: unknown): CreateError {
	const message = errorMessage(err);
	const match = /office_exists(?::([A-Za-z0-9_-]+))?/.exec(message);
	if (match) return { reason: 'exists', officeId: match[1] ?? '' };
	return { reason: 'error', message };
}

export function parseDraftError(err: unknown): DraftError {
	const message = errorMessage(err);
	if (message === 'invalid_draft') {
		const body = (err as { body?: { detail?: string; model?: string } } | null)?.body;
		return { reason: 'invalid', detail: body?.detail, model: body?.model };
	}
	if (message === 'description is required' || message.startsWith('description is longer than')) {
		return { reason: 'input', message };
	}
	return { reason: 'error', message };
}
