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
 * Purity: this function performs NO database reads, NO I/O, and reads NO env
 * vars beyond the single documented `STAGING_MAIL_SINK` (the email sink
 * address). `region` is always an explicit argument — never read from the
 * environment here — so the function is fully deterministic given its inputs
 * plus that one documented var.
 */

import type { DeployRegion } from "@useatlas/types";

/**
 * Default email sink when `STAGING_MAIL_SINK` is unset (PRD
 * docs/prd/staging-environment.md, Credentials hard wall).
 */
const DEFAULT_MAIL_SINK = "staging-mail@useatlas.dev";

/**
 * Resolve the staging email sink. Reads the one documented env var, falling
 * back to the default. An empty/unset value uses the default (`||`, not
 * `??`, so an explicitly-empty var doesn't blank the recipient).
 */
function resolveMailSink(): string {
  return process.env.STAGING_MAIL_SINK || DEFAULT_MAIL_SINK;
}

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
 * this check already tolerates it. Only the `to` field is inspected; every
 * other field rides through the shallow copy untouched.
 */
function isRecipientField(to: unknown): to is string | string[] {
  return typeof to === "string" || (Array.isArray(to) && to.every((x) => typeof x === "string"));
}

/**
 * Email recipient redirect: rewrite `to` (single or array) to the single
 * staging sink address, preserving every non-recipient field — `subject`,
 * the body, `from`, headers, and anything else — via the shallow copy. A
 * multi-recipient array collapses to the one sink address: staging never
 * needs to fan out, and one sink keeps the soak inbox simple.
 *
 * SCOPE — `to` is the ONLY recipient field redirected, because the current
 * `EmailMessage` (`lib/email/delivery.ts`: `{ to, subject, html }`) has no
 * other recipient field. If the email layer ever grows `cc` / `bcc` /
 * `replyTo`, they are recipient fields too and MUST be redirected here as
 * well — otherwise a staging soak would deliver to those real addresses
 * while `to` looks correctly clamped (tracked as a follow-up). The
 * non-recipient fields above are intentionally preserved, not leaked.
 */
const EMAIL_CLAMP: OutboundClamp = {
  name: "email",
  appliesTo: (sendable) => isRecipientField((sendable as { to?: unknown }).to),
  rewrite: (sendable) => ({ ...sendable, to: resolveMailSink() }),
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
 *                 from the environment here. The wiring slice derives it from
 *                 `getApiRegion()` (which returns `string | null`), NARROWED
 *                 to a `DeployRegion` first — a raw unrecognized string takes
 *                 the prod identity path (fail-open), so the caller must pin
 *                 the narrowing rather than pass the raw env read.
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
