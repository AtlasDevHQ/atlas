/**
 * Pull a human-readable message from a Better Auth device-endpoint error
 * (#4043 / ADR-0025).
 *
 * The device-flow error shape is `{ error, error_description, status,
 * statusText }` (RFC 8628), not the `{ message }` shape other Better Auth
 * plugins use — so we read it defensively, preferring the human-facing
 * `error_description`, then `message`, then the raw `error` code, and finally
 * an actionable default. A shape change degrades to the default rather than a
 * crash.
 */
export function deviceErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.error_description === "string" && e.error_description) return e.error_description;
    if (typeof e.message === "string" && e.message) return e.message;
    if (typeof e.error === "string" && e.error) return e.error;
  }
  return "That code is invalid or has expired. Check your terminal and try again.";
}
