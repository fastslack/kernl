/**
 * An error a route handler throws to answer with a specific HTTP status.
 *
 * `server.route()` (and the dispatcher, for plain handlers) turns it into
 * `json(status, body ?? { error: message })`. Anything else a handler throws
 * is a 500.
 *
 * Recognised by a brand, not by `instanceof`: every extension bundle carries
 * its own copy of the SDK, so an extension's HttpError is a different class
 * from the kernel's and `instanceof` would miss it.
 */
const BRAND = Symbol.for("kernl.HttpError");

export class HttpError extends Error {
  readonly [BRAND] = true;

  constructor(
    readonly status: number,
    message: string,
    /** Response body in place of the default `{ error: message }`. */
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return typeof err === "object" && err !== null && (err as Record<symbol, unknown>)[BRAND] === true;
}
