/**
 * Test helpers for mutating base64url-encoded segments (JWT-style tokens).
 *
 * Why this exists: tampering tests that "flip a char" by appending a
 * constant (e.g. `slice(0, -1) + "A"`) are a no-op ~1/64 of the time —
 * the base64url alphabet is 64 chars, so the original last char already
 * equals the constant with uniform probability. Surfaced empirically on
 * PR #2680 CI; tracked as #2681.
 */

/**
 * Replace the last char of a base64url segment with one guaranteed to
 * be different. Returns the input minus its last char, with `"A"`
 * appended — unless the original last char was already `"A"`, in which
 * case `"B"`. Both substitutes are valid base64url chars.
 */
export function mutateLastChar(s: string): string {
  return s.slice(0, -1) + (s.slice(-1) === "A" ? "B" : "A");
}
