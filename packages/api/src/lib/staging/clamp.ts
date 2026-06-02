/**
 * StagingClamp — the single outbound-rewrite chokepoint for the `staging`
 * deploy region (staging slice 4, #2910).
 *
 * The staging instance (`*.staging.useatlas.dev`) runs the full SaaS code
 * path against real external providers (Resend, Stripe, Slack, …). Without a
 * clamp, a staging soak would email real-looking customer addresses,
 * burning Resend sender reputation, and could mirror state into real
 * provider accounts. {@link clampOutbound} rewrites outbound payloads so a
 * staging soak is inert from the recipient's point of view while still
 * exercising the real delivery code.
 *
 * Design — a deep module behind a one-line interface:
 *
 *   clampOutbound(region, sendable) -> sendable
 *
 * Callers never branch on region themselves; they pass every outbound
 * payload through this one function. Today the only registered transform is
 * the email recipient redirect. Future transforms (Stripe customer-creation
 * mirroring, Slack webhook destination overrides — out of scope for #2910)
 * slot in as additional entries in {@link OUTBOUND_CLAMPS} without changing
 * this signature, so no caller breaks when the body grows.
 *
 * Purity: this function performs NO database reads and NO I/O. `region` is
 * always an explicit argument — never read from the environment here — so the
 * function is deterministic given its inputs plus the sink resolution. The
 * only env reads happen inside {@link resolveMailSink} (the `STAGING_MAIL_SINK`
 * override and, for its profile default, `ATLAS_DEPLOY_ENV`); both are
 * documented, non-secret, and read only on the `staging` rewrite path.
 */

import type { DeployRegion } from "@useatlas/types";
import { resolveMailSink } from "@atlas/api/lib/env-profile";

/**
 * A registered outbound transform. `appliesTo` owns payload classification;
 * `rewrite` returns a NEW object (never mutates its input) with the
 * staging-safe substitution applied. The generic `rewrite` preserves the
 * caller's payload type so {@link clampOutbound} stays `(T) => T`.
 */
interface OutboundClamp {
  readonly name: string;
  appliesTo(sendable: object): boolean;
  rewrite<T extends object>(sendable: T): T;
}

/**
 * Is `to` a recipient field — a string or an array of strings?
 *
 * This structural check (rather than importing `EmailMessage` from
 * `lib/email/delivery.ts`) keeps the clamp dependency-free of the email
 * subsystem. Today `EmailMessage.to` is a single `string`; the array arm is
 * forward-looking — IF the delivery layer later grows a multi-recipient `to`,
 * this check already tolerates it. Applied per-field to every entry in
 * {@link RECIPIENT_FIELDS}; a field that is absent or not recipient-shaped is
 * left untouched by the shallow copy.
 */
function isRecipientField(to: unknown): to is string | string[] {
  return typeof to === "string" || (Array.isArray(to) && to.every((x) => typeof x === "string"));
}

/**
 * Every recipient field a clamp must redirect. `to` is the only one today's
 * `EmailMessage` (`lib/email/delivery.ts`: `{ to, subject, html }`) carries,
 * but `cc` / `bcc` / `replyTo` are recipient fields too — and a nodemailer
 * `SendMailOptions` payload (the per-workspace SMTP agent path, #3095) already
 * declares all four. If any of them is ever populated, it MUST be redirected to
 * the sink as well, or a staging soak would deliver to those real addresses
 * while `to` looks correctly clamped. Redirecting the whole set up front closes
 * that latent trap now rather than leaving it armed for a future field-add
 * (#2984), so a payload growing `cc`/`bcc`/`replyTo` cannot ride through the
 * shallow copy unredirected.
 */
const RECIPIENT_FIELDS = ["to", "cc", "bcc", "replyTo"] as const;

/**
 * Email recipient redirect: rewrite EVERY populated recipient field
 * (`to`/`cc`/`bcc`/`replyTo`) to the single staging sink address, preserving
 * every non-recipient field — `subject`, the body, `from`, headers, and
 * anything else — via the shallow copy. Each redirected field's SHAPE is
 * preserved so the `(T) => T` contract stays type-honest: a single-string
 * field becomes the sink string; an array field becomes a one-element array
 * `[sink]`. Either way there is exactly one recipient per field — staging never
 * needs to fan out, and one sink keeps the soak inbox simple — but collapsing an
 * array to a bare string would make the field's runtime value diverge from its
 * declared `string[]` type, an unsound `(T) => T` a typed caller (e.g. one
 * doing `result.cc.map(...)`) would trip over.
 *
 * A field that is absent or not recipient-shaped (`isRecipientField` false —
 * e.g. a numeric `cc`, or a `headers` object carrying a `Reply-To` value) is
 * left untouched: only real top-level recipient values are redirected, never
 * mis-stamped. The non-recipient fields are intentionally preserved, not leaked.
 *
 * SCOPE of the structural guard: it covers the `string | string[]` recipient
 * shapes only. nodemailer also permits `Address` objects (`{ name, address }`)
 * and `Array<string | Address>` for these fields; an `Address`-shaped recipient
 * is NOT recipient-shaped to `isRecipientField`, so it would ride through
 * unredirected. That is safe TODAY because both callers only ever produce string
 * recipients (`EmailMessage.to` is a `string`; the SMTP agent path builds
 * `to: Array.from(to)` from Zod-validated `string` addresses), but a future
 * caller that passes `Address` objects MUST widen `isRecipientField` to match
 * them — otherwise such a recipient would reach a real address on a staging soak.
 */
const EMAIL_CLAMP: OutboundClamp = {
  name: "email",
  // Claim any payload carrying at least one recipient-shaped field. Keying on
  // the whole recipient set (not just `to`) means a future payload that omits
  // `to` but sets `cc` can't slip past classification and leak the `cc`.
  appliesTo: (sendable) =>
    RECIPIENT_FIELDS.some((field) =>
      isRecipientField((sendable as Record<string, unknown>)[field]),
    ),
  rewrite: (sendable) => {
    const sink = resolveMailSink();
    // Shallow copy, then redirect each populated recipient field in place,
    // preserving its string-vs-array shape so the returned object honestly
    // matches its declared `T` — see the doc above. The `Record` view is only
    // used to mutate; the spread copy itself stays typed as `T`.
    const next = { ...sendable };
    const view = next as Record<string, unknown>;
    for (const field of RECIPIENT_FIELDS) {
      const current = view[field];
      if (isRecipientField(current)) {
        view[field] = Array.isArray(current) ? [sink] : sink;
      }
    }
    return next;
  },
};

/**
 * The registered transforms, tried in order. Append new entries here to
 * cover additional outbound payload kinds; {@link clampOutbound}'s signature
 * does not change.
 */
const OUTBOUND_CLAMPS: readonly OutboundClamp[] = [EMAIL_CLAMP];

/**
 * Clamp an outbound payload for the given deploy region.
 *
 * - For every prod region (`us` / `eu` / `apac`) this is the identity
 *   transform: the exact same reference is returned, no allocation.
 * - For `staging`, the first registered transform whose `appliesTo` matches
 *   rewrites the payload. An email payload has its recipient(s) redirected to
 *   the staging sink. A payload no transform claims (or a non-object, e.g. a
 *   primitive or `null`) passes through unchanged.
 *
 * @param region   the deploy region — ALWAYS an explicit argument, never read
 *                 from the environment here. The wiring slice (#2985) derives
 *                 it from `getApiRegion()` (which returns `string | null`,
 *                 with GRANULAR values like `"us-west"`/`"eu-west"`) and MUST
 *                 MAP that to a `DeployRegion` (e.g. `"us-west"` -> `"us"`) —
 *                 a plain type-narrow is insufficient, because the env values
 *                 are finer-grained than this union, so `"us-west"` is not
 *                 itself a `DeployRegion`. Any unrecognized value takes the
 *                 prod identity path (fail-OPEN), so passing a raw
 *                 `getApiRegion()` result here is a customer-email-leak bug:
 *                 the caller MUST pin the mapping, not pass the raw env read.
 * @param sendable the outbound payload (email message, future: Stripe/Slack).
 * @returns the same `sendable` outside staging; a staging-safe copy inside.
 */
export function clampOutbound<T>(region: DeployRegion, sendable: T): T {
  // Identity outside staging — no prod region rewrites outbound payloads.
  if (region !== "staging") return sendable;

  // Only objects can be classified/rewritten; primitives and null pass
  // through (every clampable payload is an object).
  if (typeof sendable !== "object" || sendable === null) return sendable;

  for (const clamp of OUTBOUND_CLAMPS) {
    if (clamp.appliesTo(sendable)) {
      return clamp.rewrite(sendable);
    }
  }

  // No transform claimed this payload kind yet — pass through untouched.
  return sendable;
}
