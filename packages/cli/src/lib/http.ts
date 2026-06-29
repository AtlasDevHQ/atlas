/**
 * Shared HTTP primitives for the workspace CLI clients (#4113 — milestone #77
 * sibling-consistency cleanup).
 *
 * Each workspace CLI client (`sql-client`, `metric-client`, `datasource-client`,
 * and the `explore` command) is a thin, transport-only wrapper over one REST
 * route. The body-narrowing + error-shaping helpers below were byte-identical
 * copies pasted across them; consolidating here gives the wire contract ONE
 * definition, so a change to how a server error becomes user-facing copy (or how
 * a `requestId` is appended) can't drift between siblings.
 *
 * Nothing here calls `process.exit`, `console`, or `fetch` directly — the
 * clients inject `fetch` and own presentation, keeping these pure + unit-testable.
 */

/** The global `fetch`, injectable so clients stay unit-testable without a live server. */
export type FetchImpl = typeof fetch;

/** Narrow an unknown parsed-JSON value to a record; non-objects (incl. `null`) → `{}`. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Pull the server's actionable message off a JSON error body, falling back to
 * the HTTP status. Appends the server's `requestId` (Atlas error envelopes carry
 * one) so a bug report stays log-correlatable operator-side.
 */
export function serverMessage(body: Record<string, unknown>, status: number): string {
  const base =
    typeof body.message === "string" && body.message.length > 0
      ? body.message
      : typeof body.error === "string" && body.error.length > 0
        ? body.error
        : `HTTP ${status}`;
  return typeof body.requestId === "string" && body.requestId.length > 0
    ? `${base} (request ${body.requestId})`
    : base;
}

/**
 * Whether a thrown `fetch` rejection is an abort/timeout rather than a genuine
 * transport failure. `AbortSignal.timeout(...)` rejects with a `TimeoutError`; a
 * caller-driven abort (Ctrl-C) rejects with an `AbortError`. The clients map
 * both to their `network` error kind with a deadline-specific message.
 */
export function isAbortOrTimeout(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

/** The "couldn't reach the API" message shared verbatim across the clients. */
export function unreachableMessage(baseUrl: string, err: unknown): string {
  return `Could not reach the Atlas API at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`;
}
