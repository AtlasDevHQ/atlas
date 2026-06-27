/**
 * Normalize a device user code for submission to `/device/approve` (#4043 /
 * ADR-0025).
 *
 * Better Auth generates a case-SENSITIVE user code from `[a-zA-Z0-9]`, so we
 * must NOT change case. We only strip surrounding and internal whitespace
 * (paste artifacts, accidental spaces) so a copy-pasted or hand-typed code
 * matches the stored value byte-for-byte.
 */
export function normalizeUserCode(raw: string): string {
  return raw.replace(/\s+/g, "");
}
