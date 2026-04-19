/**
 * Normalize the server's rollback `warning` field into a banner string.
 * The signal is compliance-critical — a rollback may have persisted
 * without actually reversing the side-effect — so unknown shapes fall
 * back to a generic "something warned" banner rather than silently
 * returning null. Absent/empty values return null (no warning to show).
 */
const GENERIC_FALLBACK =
  "Rollback persisted, but the server returned a warning in an unrecognized shape. Check logs for details.";

/**
 * Log any non-null raw `warning` value that the caller couldn't surface
 * verbatim — non-string shapes, whitespace-only strings, or empty strings.
 * Called alongside `coerceRollbackWarning` so server-side schema drift is
 * observable even when the UI gracefully degrades. Accepts a logger so
 * tests can assert the call without wiring up console interception.
 */
export function logUnsurfacedRollbackWarning(
  raw: unknown,
  logger: (message: string, value: unknown) => void = console.warn,
): void {
  if (raw == null) return;
  if (typeof raw !== "string") {
    logger("handleRollback: non-string warning shape", raw);
    return;
  }
  if (raw.trim().length === 0) {
    logger("handleRollback: blank warning string", JSON.stringify(raw));
  }
}

export function coerceRollbackWarning(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  // If the server grows the warning field into an object, prefer a string
  // `message` field. Other keys are ignored; unknown shapes fall through
  // to the generic fallback below.
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const message = (raw as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  return GENERIC_FALLBACK;
}
