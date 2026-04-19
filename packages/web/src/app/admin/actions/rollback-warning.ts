/**
 * Normalize the `warning` field on a rollback 200 response into a banner
 * string. The server currently emits `{ warning: string }` when a rollback
 * persisted but the side-effect may not have actually reversed. Operators
 * rely on this signal for compliance — silently dropping a non-string
 * shape would hide "rollback may not have fully reversed" from the audit
 * trail.
 *
 * Returns `null` when the field is absent/null/undefined/empty — there's
 * genuinely no warning to show.
 *
 * For unknown shapes (object, array, number, boolean), returns a generic
 * fallback string so the operator still sees that something warned, and
 * the raw value is logged for follow-up. Callers should surface the
 * returned string in the warning banner as-is.
 */
const GENERIC_FALLBACK =
  "Rollback persisted, but the server returned a warning in an unrecognized shape. Check logs for details.";

export function coerceRollbackWarning(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  // Best-effort extraction from the most common object shape the server
  // might grow into: `{ message: string, code?: string }`. Everything
  // else falls back to the generic banner; the caller logs the raw value.
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const message = (raw as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  return GENERIC_FALLBACK;
}
