/**
 * `apiFetch` turns a non-2xx response into `Error(body.error)` and drops the
 * status; RPC errors arrive as `Error(message)`. These helpers turn both into
 * outcomes the wizard can act on.
 */
export type CreateError = { reason: 'exists'; officeId: string } | { reason: 'error'; message: string };
export type DraftError = { reason: 'invalid' } | { reason: 'input'; message: string } | { reason: 'error'; message: string };

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
	if (message === 'invalid_draft') return { reason: 'invalid' };
	if (message === 'description is required' || message.startsWith('description is longer than')) {
		return { reason: 'input', message };
	}
	return { reason: 'error', message };
}
