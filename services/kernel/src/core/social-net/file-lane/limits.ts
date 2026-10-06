/** Limits and timings of the file-lane. See the spec's "Límites" table. */
export const CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_FILES = 50;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_PENDING_PER_FRIEND = 5;
export const OFFER_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_BAD_HASHES = 3;
/** An unreachable friend for this long turns the transfer into `failed`. */
export const GIVE_UP_AFTER_MS = 6 * 60 * 60 * 1000;
/** Leftover parts of failed/expired/cancelled transfers are removed after this. */
export const ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Wait before retrying an unreachable friend: 30 s, 60 s, … capped at 1 h. */
export function retryDelayMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.min(attempt, 20), 3_600_000);
}

/** Wait between status polls while the offer waits for an answer: 2 s → 30 s. */
export function pollDelayMs(polls: number): number {
  return Math.min(2_000 * 1.5 ** Math.min(polls, 20), 30_000);
}
