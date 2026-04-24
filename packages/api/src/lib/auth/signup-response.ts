/**
 * Signup response parity normalization (#1792, F-P3 — 1.2.3 Security Sweep).
 *
 * Better Auth's `/sign-up/email` handler closes the signup enumeration
 * oracle when `emailAndPassword.requireEmailVerification: true` by
 * returning a synthetic 200 envelope for existing emails — the same
 * shape as the real (new-email) envelope, no 422/USER_ALREADY_EXISTS.
 *
 * The shapes are NOT byte-for-byte symmetric when the signup body
 * omits `image`:
 *   - Real path (new email → `parseUserOutput`): `user.image` is
 *     absent from the emitted user object.
 *   - Synthetic path (existing email): `user.image: null` is emitted
 *     verbatim (the Better Auth source writes `image: image || null`).
 *
 * A client that checks key presence — `"image" in body.user` — can
 * therefore distinguish the two branches and reopen the oracle. We
 * close the asymmetry here by filling `user.image: null` on the real
 * path before the response leaves Atlas.
 *
 * This is the Atlas-side workaround (issue #1792 option 2). The
 * long-term fix is upstream at better-auth/better-auth#9346: once
 * `parseUserOutput` emits `image: null` on real signups too, this
 * normalizer becomes a no-op and can be deleted outright.
 *
 * Scope invariants:
 *   - Only touches `body.user.image`. Every other field — top-level,
 *     nested under `user`, or elsewhere — passes through unchanged.
 *   - Idempotent: applying twice yields the same result.
 *   - Non-user-shaped bodies (errors, non-JSON, arrays, primitives)
 *     pass through unchanged. The caller is responsible for scoping
 *     this normalizer to the `/sign-up/email` success path.
 */

export function normalizeSignupResponseBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const envelope = body as Record<string, unknown>;
  const user = envelope.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) return body;
  const userObj = user as Record<string, unknown>;
  if ("image" in userObj) return body;
  return { ...envelope, user: { ...userObj, image: null } };
}
