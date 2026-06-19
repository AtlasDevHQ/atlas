/**
 * Business-email-only signup policy (#3650, ADR-0018).
 *
 * Atlas signup — web form AND the MCP `start_trial` path — is business-email
 * only. Because `start_trial` provisions through the *same* Better Auth signup
 * (`signUpEmail` → `databaseHooks.user.create.before`), enforcing the policy in
 * that one hook makes web and MCP identical by construction.
 *
 * Two hard denies, both surfaced through a single typed `business_email_required`
 * rejection so the web layer shows one actionable message and the MCP envelope
 * (#3649) maps one stable code:
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
 * Extract the lower-cased domain (everything after the last `@`) from an email
 * address. Returns `undefined` for input with no `@` or an empty domain.
 */
export function extractEmailDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : undefined;
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
 */
export function isDisposableEmail(email: string): boolean {
  if (!email) return false;
  return !validateEmail(email);
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
