/**
 * Business-email-only signup policy (#3650, ADR-0018).
 *
 * Atlas signup — web form AND the MCP `start_trial` path — is business-email
 * only. Because `start_trial` provisions through the *same* Better Auth signup
 * (`signUpEmail` → `databaseHooks.user.create.before`), enforcing the policy in
 * that one hook makes web and MCP identical by construction.
 *
 * The business-email policy has two hard denies, both surfaced through a single
 * typed `business_email_required` rejection so the web layer shows one actionable
 * message and the MCP envelope (#3649) maps one stable code (the plus-addressing
 * reject below is a separate policy with its own code):
 *
 *  1. **Disposable / throwaway mailboxes** — detected via `better-auth-harmony`'s
 *     `validateEmail` (the same `mailchecker` engine, 50k+ domains, that the
 *     `emailHarmony` plugin ships). We route the rejection through our own typed
 *     error rather than the plugin's generic "Invalid email" 400 (the plugin's
 *     own route validation is disabled in `buildPlugins` for exactly this
 *     reason — see the `emailHarmony({ matchers: { validation: [] } })` call).
 *  2. **Freemium / consumer domains** (gmail, outlook, yahoo, icloud, proton, …)
 *     — a maintained denylist that lives in code ({@link FREEMIUM_EMAIL_DOMAINS}),
 *     relaxable later without a migration.
 *
 * The `normalizedEmail` unique column (collapsing `+alias`/dot/case variants, the
 * teeth behind one-trial-per-user) is contributed by the `emailHarmony` plugin
 * itself; this module only owns the *deny* decision.
 *
 * A third, separately-typed deny lives here too: the **plus-addressing reject**
 * (#4091, {@link assertNoPlusAddressing}) — an explicit-intent layer on top of
 * the `normalizedEmail` normalization that blocks `user+tag@domain` signups for
 * every domain except an exempt allowlist ({@link PLUS_ADDRESSING_EXEMPT_DOMAINS},
 * fixed to `useatlas.dev`). It carries its OWN code/message
 * ({@link PLUS_ADDRESSING_NOT_ALLOWED_CODE}) so a plus-addressed signup gets a
 * clear "use your primary work email" rejection rather than the freemium/
 * disposable "use your work email" message or a duplicate-key error. The exempt
 * allowlist is fixed in code (no override path), consistent with the
 * business-email policy being a code module rather than an operator knob.
 *
 * Template-synced to create-atlas, so this stays dependency-light: a plain
 * `APIError` (Better Auth's HTTP error type) is thrown, no Atlas-internal imports.
 */

import { APIError } from "better-auth/api";
import { validateEmail } from "better-auth-harmony/email";

/**
 * Error `code` carried on the thrown {@link APIError} body and the value the MCP
 * `start_trial` envelope surfaces (#3649). Stable contract — do not rename
 * without updating the MCP provisioner's envelope mapping.
 */
export const BUSINESS_EMAIL_REQUIRED_CODE = "BUSINESS_EMAIL_REQUIRED" as const;

/**
 * User-facing rejection message. Actionable (tells the user what to do) and
 * deliberately identical for the disposable and freemium cases — to the person
 * signing up, "we need your work email" is the single relevant instruction. The
 * web signup form renders this verbatim (`res.error.message`).
 */
export const BUSINESS_EMAIL_REQUIRED_MESSAGE =
  "Please sign up with your work email address. Personal and disposable email " +
  "addresses aren't supported for Atlas trials.";

/**
 * Freemium / consumer email domains denied at signup. Lives in code so the list
 * is maintained alongside the policy and relaxable without a migration. Lower-case
 * registrable hosts; regional variants are listed explicitly because the match is
 * exact (no suffix matching — `notgmail.com` must not be caught by `gmail.com`).
 */
export const FREEMIUM_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  "gmail.com",
  "googlemail.com",
  // Microsoft
  "outlook.com",
  "outlook.co.uk",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "live.com",
  "live.co.uk",
  "msn.com",
  // Yahoo / Oath
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.in",
  "yahoo.fr",
  "yahoo.de",
  "ymail.com",
  "rocketmail.com",
  // Apple
  "icloud.com",
  "me.com",
  "mac.com",
  // Proton
  "proton.me",
  "protonmail.com",
  "pm.me",
  // AOL
  "aol.com",
  // GMX / mail.com family
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "mail.com",
  // Zoho (consumer)
  "zohomail.com",
  // Yandex
  "yandex.com",
  "yandex.ru",
  // Fastmail (consumer)
  "fastmail.com",
  // HEY
  "hey.com",
  // Tutanota / Tuta
  "tutanota.com",
  "tuta.io",
  // Other large consumer providers
  "aim.com",
  "hushmail.com",
  "inbox.com",
  // Regional consumer webmail
  "qq.com",
  "163.com",
  "126.com",
  "sina.com",
  "naver.com",
  "daum.net",
  "web.de",
  "t-online.de",
  "orange.fr",
  "free.fr",
  "libero.it",
  "mail.ru",
]);

/**
 * Plus-addressing reject (#4091).
 *
 * Email plus-addressing (`user+tag@acme.com`) lets one real inbox mint an
 * unbounded number of distinct-looking addresses — and because every signup
 * provisions a fresh user + org, that's a trial-farming / per-org-limit-evasion
 * vector. `emailHarmony`'s `normalizedEmail` UNIQUE column already collapses
 * `+tag` variants of the SAME base inbox (so a second plus-variant collides),
 * but that surfaces as a confusing "account already exists" duplicate error and
 * still accepts+stores the first plus-addressed address. This is the explicit,
 * intentional reject layered on top: a clear typed error stating intent, not a
 * unique-constraint side effect.
 *
 * EXEMPTION: Atlas's own `/verify-prod-signup` 3-region E2E flow depends on
 * plus-addressed `@useatlas.dev` throwaway accounts (`matt+us@useatlas.dev`) —
 * that plus-tag is the signature the `ops teardown-verify-accounts` guard keys
 * on (`isThrowawayVerifyEmail`). So `useatlas.dev` MUST stay allowed; everyone
 * else gets blocked. A hardcoded policy constant (not a settings knob) because
 * this is a security policy, not an operator tuning knob.
 */
export const PLUS_ADDRESSING_NOT_ALLOWED_CODE = "PLUS_ADDRESSING_NOT_ALLOWED" as const;

/**
 * User-facing rejection message for a plus-addressed signup. Actionable (tells
 * the user what to do) and leaks no internal details (no mention of the
 * anti-abuse rationale or the exempt domain). The web signup form renders this
 * verbatim (`res.error.message`).
 */
export const PLUS_ADDRESSING_NOT_ALLOWED_MESSAGE =
  "Plus-addressed emails aren't supported — use your primary work email.";

/**
 * Domains exempt from the plus-addressing reject — plus-addressing is allowed
 * here. Lower-case registrable hosts, matched exactly (case-insensitively) via
 * {@link extractEmailDomain}. Fixed to `["useatlas.dev"]` (no override path) for
 * the verify-prod-signup carve-out documented above.
 */
export const PLUS_ADDRESSING_EXEMPT_DOMAINS: ReadonlySet<string> = new Set([
  "useatlas.dev",
]);

/**
 * Extract the lower-cased domain (everything after the last `@`) from an email
 * address. Returns `undefined` for input with no `@` or an empty domain.
 */
export function extractEmailDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : undefined;
}

/**
 * Extract the local-part (everything before the last `@`) from an email address.
 * Case is preserved (unlike {@link extractEmailDomain}) — the caller only needs
 * to test for a literal `+`, which is case-irrelevant. Returns `undefined` for
 * input with no `@` or an empty local-part.
 */
export function extractEmailLocalPart(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at <= 0) return undefined;
  const local = email.slice(0, at);
  return local.length > 0 ? local : undefined;
}

/**
 * True when the email uses plus-addressing (its local-part contains a `+`) AND
 * its domain is NOT on the {@link PLUS_ADDRESSING_EXEMPT_DOMAINS} allowlist.
 * Empty/malformed input is reported as `false` (Better Auth owns the
 * required-field / format case; an address with no resolvable local-part can't
 * be plus-addressed). An address with a `+` but no resolvable domain (e.g.
 * `a+b@`) fails closed to `true` — the exemption can't apply, and it's malformed
 * anyway.
 */
export function hasDisallowedPlusAddressing(email: string): boolean {
  const local = extractEmailLocalPart(email);
  if (!local || !local.includes("+")) return false;
  const domain = extractEmailDomain(email);
  if (domain !== undefined && PLUS_ADDRESSING_EXEMPT_DOMAINS.has(domain)) {
    return false;
  }
  return true;
}

/** True when the email's domain is on the freemium/consumer denylist. */
export function isFreemiumEmailDomain(email: string): boolean {
  const domain = extractEmailDomain(email);
  return domain !== undefined && FREEMIUM_EMAIL_DOMAINS.has(domain);
}

/**
 * True when the email is a disposable/throwaway mailbox (or otherwise fails the
 * `mailchecker` validity check — a syntactically invalid address also returns
 * `true` here, folded into the same deny). Delegates to `better-auth-harmony`'s
 * `validateEmail` so we share the exact disposable-domain corpus the plugin
 * blocks with.
 *
 * `validateEmail` throws on a null/empty input (its underlying `isEmail`
 * expects a string), so we guard first and report empty as not-disposable —
 * Better Auth owns the required-field case. This keeps the exported helper safe
 * for a direct caller (e.g. the MCP `start_trial` provisioner, #3649) that
 * hasn't already passed through {@link assertBusinessEmail}'s empty guard.
 *
 * If `validateEmail` itself THROWS on hostile input (a pathological/over-length
 * address, or a future `mailchecker` that throws instead of returning false),
 * we fail CLOSED — treat the address as disposable (deny) rather than let an
 * unclassified throw escape `assertBusinessEmail` as an opaque 500. An
 * abuse/eligibility check must never admit an address it couldn't validate.
 * Logged via `console` to keep this module dependency-light (template-synced;
 * no Atlas-internal imports — see the file header).
 */
export function isDisposableEmail(email: string): boolean {
  if (!email) return false;
  try {
    return !validateEmail(email);
  } catch (err) {
    console.warn(
      "[business-email] validateEmail threw; denying address as disposable (fail closed):",
      err instanceof Error ? err.message : String(err),
    );
    return true;
  }
}

/** Why an address fails the business-email policy. */
export type BusinessEmailReason = "disposable" | "freemium";

/**
 * Why an address was rejected, or `{ ok: true }` when it passes both denies.
 * Disposable is checked first so a disposable freemium address reports the more
 * specific structural reason.
 */
export type BusinessEmailVerdict =
  | { ok: true }
  | { ok: false; reason: BusinessEmailReason };

/** Classify an address against the business-email policy. Pure, no throw. */
export function classifyBusinessEmail(email: string): BusinessEmailVerdict {
  if (isDisposableEmail(email)) return { ok: false, reason: "disposable" };
  if (isFreemiumEmailDomain(email)) return { ok: false, reason: "freemium" };
  return { ok: true };
}

/**
 * Shape of the {@link APIError} body thrown on a business-email rejection — the
 * single typed contract shared by the producer ({@link assertBusinessEmail}),
 * the recognizer ({@link isBusinessEmailRejection}), and the MCP `start_trial`
 * envelope mapping (#3649). `reason` reuses {@link BusinessEmailReason}, so a new
 * deny reason can't be emitted on the wire without widening the verdict union in
 * the same edit.
 */
export interface BusinessEmailErrorBody {
  code: typeof BUSINESS_EMAIL_REQUIRED_CODE;
  message: typeof BUSINESS_EMAIL_REQUIRED_MESSAGE;
  reason: BusinessEmailReason;
}

/**
 * Throw a typed {@link APIError} when `email` violates the business-email policy.
 * No-op for an allowed business address (and for a null/empty email — Better
 * Auth's own validation owns the "email required" case; we only judge domains).
 *
 * Called from `databaseHooks.user.create.before` (SaaS deploy mode only — see
 * the call site in server.ts) so it gates EVERY SaaS signup path (web, social,
 * MCP `start_trial`) identically. The throw aborts user creation; Better Auth
 * serializes the `APIError` to a 400 whose body carries
 * {@link BUSINESS_EMAIL_REQUIRED_CODE} + {@link BUSINESS_EMAIL_REQUIRED_MESSAGE}.
 */
export function assertBusinessEmail(email: string | null | undefined): void {
  if (!email) return;
  const verdict = classifyBusinessEmail(email);
  if (verdict.ok) return;
  const body: BusinessEmailErrorBody = {
    code: BUSINESS_EMAIL_REQUIRED_CODE,
    message: BUSINESS_EMAIL_REQUIRED_MESSAGE,
    reason: verdict.reason,
  };
  throw new APIError("BAD_REQUEST", body);
}

/**
 * Recognize a business-email rejection on a caught error. Used by the MCP
 * `start_trial` provisioner (#3649) to map the shared-signup-path failure to its
 * typed `business_email_required` envelope. Matches on the stable
 * {@link BUSINESS_EMAIL_REQUIRED_CODE}, not a message string, so it survives copy
 * changes and harmony upgrades.
 */
export function isBusinessEmailRejection(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  const body = err.body as Partial<BusinessEmailErrorBody> | undefined;
  return body?.code === BUSINESS_EMAIL_REQUIRED_CODE;
}

/**
 * Shape of the {@link APIError} body thrown on a plus-addressing rejection
 * (#4091) — the typed contract shared by the producer
 * ({@link assertNoPlusAddressing}), the recognizer
 * ({@link isPlusAddressingRejection}), and the MCP `start_trial` envelope
 * mapping. Distinct from {@link BusinessEmailErrorBody} so the two denies never
 * cross-match and a plus-addressed signup surfaces its own actionable message
 * rather than a generic duplicate/validation error.
 */
export interface PlusAddressingErrorBody {
  code: typeof PLUS_ADDRESSING_NOT_ALLOWED_CODE;
  message: typeof PLUS_ADDRESSING_NOT_ALLOWED_MESSAGE;
}

/**
 * Throw a typed {@link APIError} when `email` uses disallowed plus-addressing.
 * No-op for an exempt domain ({@link PLUS_ADDRESSING_EXEMPT_DOMAINS}), a
 * non-plus address, and a null/empty email (Better Auth's own validation owns
 * the "email required" case).
 *
 * Called from `databaseHooks.user.create.before` (SaaS deploy mode only)
 * alongside {@link assertBusinessEmail} so it gates EVERY SaaS signup path (web,
 * social, MCP `start_trial`) identically. The throw aborts user creation; Better
 * Auth serializes the `APIError` to a 400 carrying
 * {@link PLUS_ADDRESSING_NOT_ALLOWED_CODE} + {@link PLUS_ADDRESSING_NOT_ALLOWED_MESSAGE}.
 *
 * This is additive to (not a replacement for) the `emailHarmony`
 * `normalizedEmail` normalization — see the file header.
 */
export function assertNoPlusAddressing(email: string | null | undefined): void {
  if (!email) return;
  if (!hasDisallowedPlusAddressing(email)) return;
  const body: PlusAddressingErrorBody = {
    code: PLUS_ADDRESSING_NOT_ALLOWED_CODE,
    message: PLUS_ADDRESSING_NOT_ALLOWED_MESSAGE,
  };
  throw new APIError("BAD_REQUEST", body);
}

/**
 * Recognize a plus-addressing rejection on a caught error. Used by the MCP
 * `start_trial` provisioner to map the shared-signup-path failure to its typed
 * `plus_addressing` envelope. Matches on the stable
 * {@link PLUS_ADDRESSING_NOT_ALLOWED_CODE}, not a message string.
 */
export function isPlusAddressingRejection(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  const body = err.body as Partial<PlusAddressingErrorBody> | undefined;
  return body?.code === PLUS_ADDRESSING_NOT_ALLOWED_CODE;
}
