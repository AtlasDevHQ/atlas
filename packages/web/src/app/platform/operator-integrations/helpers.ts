/**
 * Pure helpers for the operator-integrations page (#3735).
 *
 * Extracted so the two safety-critical, server-mirroring transforms — the
 * blank=preserve payload builder and the destructive-rotation gate that drives
 * the confirm dialog — are unit-testable without rendering the page. Both
 * mirror invariants enforced server-side in `admin-operator-integrations.ts`;
 * a client bug here is otherwise silent (the server also preserves on blank).
 */

/** Minimal field shape these helpers need (subset of the wire `FieldStatus`). */
export interface CredentialFieldLike {
  readonly envVar: string;
  readonly destructiveRotation: boolean;
}

/**
 * Build the PUT payload from the draft: include a field only when its draft
 * value has non-whitespace content, but send the value UNTRIMMED so a secret
 * that legitimately contains edge whitespace isn't mangled. Mirrors the server
 * merge-preserve + no-trim contract — a blank/whitespace-only field is omitted,
 * which the server reads as "preserve the stored value".
 */
export function buildCredentialPayload<F extends { readonly envVar: string }>(
  fields: readonly F[],
  draft: Record<string, string>,
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const f of fields) {
    const raw = draft[f.envVar] ?? "";
    if (raw.trim().length > 0) payload[f.envVar] = raw;
  }
  return payload;
}

/**
 * The destructive-rotation fields the admin is about to change (non-empty
 * draft). Drives the confirm dialog: a non-empty edit on any of these requires
 * an explicit "Rotate & save" acknowledgement before the write.
 */
export function destructiveRotations<F extends CredentialFieldLike>(
  fields: readonly F[],
  draft: Record<string, string>,
): F[] {
  return fields.filter(
    (f) => f.destructiveRotation && (draft[f.envVar] ?? "").trim().length > 0,
  );
}

/** True ⇒ at least one field has a non-empty draft (gates the Save button). */
export function hasAnyEdit<F extends { readonly envVar: string }>(
  fields: readonly F[],
  draft: Record<string, string>,
): boolean {
  return fields.some((f) => (draft[f.envVar] ?? "").trim().length > 0);
}
