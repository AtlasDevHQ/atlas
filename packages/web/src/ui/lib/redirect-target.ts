/**
 * The two rules for validating a server-supplied redirect target — and why
 * there are two (#5191).
 *
 * ⚠️ **The right rule depends on WHICH FIELD you are guarding, and applying
 * one blanket rule to both is how each of these got written.** #5189 round 2
 * added `sameOriginPath` because a single loose check was being used on a
 * field that is always internal; this module exists because the mirror-image
 * mistake — reusing `sameOriginPath` on a field that is always EXTERNAL —
 * would silently reject every legitimate value and leave the user staring at
 * prose about their identity provider with no link.
 *
 *   • {@link sameOriginPath} — for a field whose value is always an INTERNAL
 *     path. Today: `enrollmentUrl` (`mfa_enrollment_required`), which the
 *     server builds from our own route table. Anything that resolves off our
 *     origin is refused.
 *
 *   • {@link externalRedirectUrl} — for a field whose value is always an
 *     EXTERNAL absolute URL. Today: `ssoRedirectUrl`, the workspace's own
 *     configured IdP (`ee/src/auth/sso.ts` — the SAML URL or the OIDC issuer).
 *     Same-origin would reject every legitimate value.
 *
 * The looser rule is justified by PROVENANCE, not by convenience:
 * `ssoRedirectUrl` is derived from the workspace's own SSO provider row, never
 * from anything a caller supplies. The residual risk is an admin pointing
 * their own workspace at a hostile IdP, which is a capability the SSO feature
 * grants by design.
 *
 * If a third field appears, the question to answer first is which of these two
 * it is. If the answer is "sometimes both", it needs a third rule, not a
 * relaxation of one of these.
 */

/**
 * A same-origin path, or `null` if the input is anything else.
 *
 * ⚠️ **Parsed, not prefix-matched, and the difference is exploitable.** The
 * obvious `startsWith("/") && !startsWith("//")` check was measured wrong:
 * WHATWG URL parsing normalizes `\` to `/` for special schemes and strips
 * TAB/LF/CR *before* authority detection, so `/\evil.example.com`,
 * `/\/evil.com` and `/<TAB>/evil.com` all pass it and all navigate off-site.
 * Resolving against a known base and comparing origins has no such arms to
 * enumerate — it answers the question directly.
 */
export function sameOriginPath(raw: string | undefined): string | null {
  if (!raw) return null;
  const base = "https://atlas.invalid";
  try {
    const u = new URL(raw, base);
    return u.origin === base ? `${u.pathname}${u.search}${u.hash}` : null;
  } catch (err) {
    // A URL the parser rejects outright is not a destination either.
    console.warn(
      "[redirect-target] unparseable same-origin path:",
      raw,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * An absolute `http:`/`https:` URL, or `null`.
 *
 * Parsed WITHOUT a base on purpose — that is what rejects a relative path and
 * garbage like `"[object Object]"`, both of which would resolve happily
 * against one. The protocol allowlist is what rejects `javascript:` and
 * `data:`, which parse fine as absolute URLs.
 *
 * Returns the ORIGINAL string rather than `u.href`: the IdP's URL is handed
 * back to the IdP, and WHATWG normalization (a trailing `/` added to a bare
 * origin, percent-encoding adjustments) is not ours to apply to someone else's
 * endpoint.
 */
export function externalRedirectUrl(raw: unknown, field = "ssoRedirectUrl"): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return raw;
  } catch (err) {
    // Same shape as its sibling above: tagged with THIS module, carrying the
    // rejected value AND the parser's reason, and naming the field.
    //
    // ⚠️ The default is the real field name, not a generic phrase. Round 1
    // added `field` with a comment claiming it kept the two call sites
    // distinguishable — and then NEITHER call site passed it, so every log line
    // read "external redirect URL", strictly less specific than the
    // "Malformed ssoRedirectUrl" the comment said must not regress. A parameter
    // nobody passes is documentation of an intention, not an implementation of
    // one; defaulting it to the only field that reaches here today makes the
    // common case right and leaves the argument available for the second one.
    console.warn(
      `[redirect-target] malformed ${field} from server:`,
      raw,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
