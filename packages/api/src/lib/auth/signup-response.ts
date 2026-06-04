/**
 * Signup response parity normalization (#1792, F-P3 — 1.2.3 Security Sweep;
 * extended by #3159).
 *
 * Better Auth's `/sign-up/email` handler closes the signup enumeration
 * oracle when `emailAndPassword.requireEmailVerification: true` by
 * returning a synthetic 200 envelope for existing emails — the same
 * shape as the real (new-email) envelope, no 422/USER_ALREADY_EXISTS.
 *
 * The shapes are NOT byte-for-byte symmetric for fields that are null on a
 * fresh user: Better Auth's synthetic (existing-email) path materializes the
 * field verbatim (e.g. `image: image || null`, and every `user.additionalFields`
 * key), while the real path's `parseUserOutput` OMITS a null, no-default field
 * from the emitted user object. A client that checks key presence — e.g.
 * `"image" in body.user` — can therefore distinguish the two branches and
 * reopen the oracle.
 *
 * Affected keys:
 *   - `image` — #1792 (Better Auth core; upstream fix tracked at
 *     better-auth/better-auth#9346).
 *   - `banExpires`, `banReason` — #3159. These moved off the removed admin
 *     plugin onto `user.additionalFields`; the synthetic path now materializes
 *     them (null) while the real signup omits them. (`role`/`banned` carry
 *     defaults — "member" / false — so they appear on both paths and need no
 *     fill.)
 *
 * We close the asymmetry by filling each missing key as `null` on the real
 * path before the response leaves Atlas.
 *
 * Scope invariants:
 *   - Only touches the {@link PARITY_FILL_KEYS} on `body.user`. Every other
 *     field — top-level, other nested-under-`user`, or elsewhere — passes
 *     through unchanged.
 *   - Idempotent: applying twice yields the same result, and returns the SAME
 *     reference once every parity key is present (the synthetic-envelope shape).
 *     The Hono wrapper's `=== ` fast-path depends on this reference contract.
 *   - Non-user-shaped bodies (errors, non-JSON, arrays, primitives)
 *     pass through unchanged. The caller is responsible for scoping
 *     this normalizer to the `/sign-up/email` success path.
 */

/**
 * User-object keys the synthetic existing-email envelope materializes but the
 * real-signup path omits when null. See the module doc for the per-key origin.
 */
const PARITY_FILL_KEYS = ["image", "banExpires", "banReason"] as const;

export function normalizeSignupResponseBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const envelope = body as Record<string, unknown>;
  const user = envelope.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) return body;
  const userObj = user as Record<string, unknown>;
  const missing = PARITY_FILL_KEYS.filter((k) => !(k in userObj));
  // Fast path / idempotency: once every parity key is present (the synthetic
  // envelope, or an already-normalized body) return the same reference so the
  // Hono wrapper skips re-allocating the Response.
  if (missing.length === 0) return body;
  const filled: Record<string, unknown> = { ...userObj };
  for (const k of missing) filled[k] = null;
  return { ...envelope, user: filled };
}
