/**
 * LeadNormalizer — pure mapping from Atlas lead events to the Twenty
 * upsert input shape.
 *
 * Ships the `demo`, `sales-form`, `signup`, `mcp-signup`, and `conversion`
 * variants. `normalizeLead`'s exhaustive switch surfaces a compile error the
 * moment a new union member lands.
 *
 * Design rule: the normalizer outputs a single `eventSource` field;
 * the first-source / last-source translation happens INSIDE
 * `TwentyClient.upsertPerson`. That keeps this module a pure function
 * of input → payload, with no I/O and no Twenty-record-state coupling.
 *
 * Types are defined inline here and mirrored in `packages/api/src/lib/effect/services.ts`
 * (`SaasCrmLeadInput`). The compile-time gate that keeps the two in lockstep
 * is the `_leadUnionsAreMirrors` exact-equality assertion in
 * `ee/src/saas-crm/index.ts` (the one place allowed to depend on both); the
 * exhaustiveness switch in `normalizeLead` is the runtime backstop. Promote
 * to `@useatlas/types` when a second consumer outside of `ee/src/saas-crm/`
 * appears.
 */

import type { UpsertPersonInput } from "./client";

/**
 * Sticky / last-touch source attribution stamped on Twenty Person
 * records. Narrow literal union: a typo here persists in Twenty
 * forever, so the type must reject misspellings at compile time.
 */
export type AtlasEventSource =
  | "DEMO"
  | "SIGNUP"
  | "MCP_SIGNUP"
  | "SALES_FORM"
  | "CONVERSION"
  | "OTHER";

/** Demo signup variant — captured at the `/demo` gate on useatlas.dev. */
export interface AtlasDemoLeadEvent {
  readonly source: "demo";
  readonly email: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/**
 * Sales-form variant — captured by the Talk-to-sales dialog on
 * `/pricing`. Carries the free-text message that becomes a Twenty Note
 * attached to the Person.
 */
export interface AtlasSalesFormLeadEvent {
  readonly source: "sales-form";
  readonly email: string;
  /** Full name as typed by the prospect. Split into first/last at the seam. */
  readonly name: string;
  readonly company: string;
  /** Plan label they're interested in (e.g. "Starter" / "Pro" / "Business"). */
  readonly planInterest: string;
  /** Free-text message. Becomes the Note body verbatim. */
  readonly message: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/**
 * Better Auth signup variant — fired by the `user.create.after` hook in
 * `packages/api/src/lib/auth/server.ts`. No request context (no IP, no
 * UA) since the hook runs post-commit on the auth pathway, and no
 * attached message — first/last source semantics are owned by
 * `TwentyClient.upsertPerson`, so a prior demo/sales-form touch keeps
 * its `atlasFirstSource` and only `atlasLastSource` flips to `SIGNUP`.
 */
export interface AtlasSignupLeadEvent {
  readonly source: "signup";
  readonly email: string;
  /**
   * Full name from Better Auth's `user.name` field — split into
   * first/last at the seam (parity with the sales-form variant).
   * Optional because email-only signup is allowed.
   */
  readonly name?: string;
}

/**
 * Self-serve MCP trial-signup variant — fired by `provisionTrialWorkspace`
 * (`ee/src/onboarding/provision-trial.ts`) on the `start_trial` path
 * (ADR-0018). Structurally identical to the web `signup` variant, but a
 * DISTINCT lead source so the acquisition channel is measurable in the CRM:
 * `eventSource = "MCP_SIGNUP"` → sticky `atlasFirstSource = MCP_SIGNUP`.
 *
 * The same provisioning path also runs Better Auth's `user.create` hook, whose
 * auto-`SIGNUP` lead is suppressed on the MCP path so this is the SOLE
 * `crm_outbox` row for the email and wins first-touch — see
 * `lib/auth/signup-origin.ts` for the sticky-first-touch race and why
 * suppression is load-bearing. Lead source (acquisition attribution) is
 * deliberately kept separate from Agent origin (approval/audit, ADR-0015):
 * both can say "mcp", but unifying them would recreate the `surface`→`origin`
 * overload.
 */
export interface AtlasMcpSignupLeadEvent {
  readonly source: "mcp-signup";
  readonly email: string;
  /**
   * Optional display name — present for type-parity with `signup` and any
   * future email-only caller. Today's provisioner always derives one from the
   * email local-part, so in practice it's populated. Split into first/last at
   * the normalizer seam.
   */
  readonly name?: string;
}

/**
 * Stripe → Twenty conversion stamping variant — fired by the
 * `onSubscriptionComplete` hook in `packages/api/src/lib/auth/server.ts`
 * after a paying checkout. Carries the Stripe `customer.id` so the
 * dispatcher can stamp `customFields.atlasStripeCustomerId` on the
 * matching Twenty Person — closing the funnel attribution loop for the
 * read-side datasource (#2728).
 *
 * Edge case: paying customer who never demoed/signed up. The dispatcher
 * still creates a new Person with `atlasFirstSource = "CONVERSION"` (the
 * `upsertPerson` POST branch) so the stamp is never lost.
 */
export interface AtlasConversionLeadEvent {
  readonly source: "conversion";
  readonly email: string;
  /** Stripe `customer.id` (the `cus_…` literal). */
  readonly stripeCustomerId: string;
}

/**
 * Discriminated union over every Atlas-internal lead event. The
 * exhaustiveness check in `normalizeLead` catches missing handlers
 * at compile time.
 */
export type AtlasLeadEvent =
  | AtlasDemoLeadEvent
  | AtlasSalesFormLeadEvent
  | AtlasSignupLeadEvent
  | AtlasMcpSignupLeadEvent
  | AtlasConversionLeadEvent;

/** Note attached to the Person — only emitted by variants that carry a message. */
export interface NormalizedNote {
  /** Short title surfaced in Twenty's note list view. */
  readonly title: string;
  /** Free-text body. Twenty stores as markdown. */
  readonly body: string;
}

export interface NormalizedLead {
  readonly person: UpsertPersonInput;
  /** Mirror of `person.eventSource` — surfaced so the caller can log / route. */
  readonly eventSource: AtlasEventSource;
  /** Optional Note to attach to the Person after upsert. */
  readonly note?: NormalizedNote;
}

/** Normalize a demo lead event to a Twenty upsert payload. */
export function normalizeDemoLead(event: AtlasDemoLeadEvent): NormalizedLead {
  const email = event.email.toLowerCase().trim();
  const eventSource: AtlasEventSource = "DEMO";

  // Only attach custom fields with a concrete value — Twenty distinguishes
  // "absent" from "explicitly nulled" on the field shape.
  const customFields: { atlasIp?: string } = {};
  if (event.ip && event.ip.length > 0) {
    customFields.atlasIp = event.ip;
  }
  // userAgent is captured at the call site for log correlation but is
  // NOT round-tripped into Twenty — keeps the schema surface small and
  // avoids the cardinality blow-up of a free-text UA field.

  return {
    person: {
      email,
      eventSource,
      customFields,
    },
    eventSource,
  };
}

/**
 * Split a single free-text name into first/last components. Whitespace
 * runs collapse to a single space; the first token becomes firstName,
 * everything after it becomes lastName. Single-word names emit
 * firstName only — Twenty distinguishes "absent" from "" on its name
 * subfield, and a stray empty lastName would clobber an existing one on
 * PATCH.
 */
function splitName(raw: string): { firstName: string; lastName?: string } | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parts = trimmed.split(/\s+/);
  const [first, ...rest] = parts;
  if (rest.length === 0) return { firstName: first };
  return { firstName: first, lastName: rest.join(" ") };
}

/** Normalize a sales-form lead event to a Twenty upsert payload + note. */
export function normalizeSalesFormLead(
  event: AtlasSalesFormLeadEvent,
): NormalizedLead {
  const email = event.email.toLowerCase().trim();
  const eventSource: AtlasEventSource = "SALES_FORM";

  const customFields: { atlasIp?: string } = {};
  if (event.ip && event.ip.length > 0) {
    customFields.atlasIp = event.ip;
  }

  const name = splitName(event.name);

  return {
    person: {
      email,
      eventSource,
      ...(name ? { name } : {}),
      customFields,
    },
    eventSource,
    note: {
      // Title pins the triage context — company + plan label — so the
      // sales team can scan the Note list without opening every body.
      title: `Talk to sales — ${event.company} (${event.planInterest})`,
      body: event.message,
    },
  };
}

/**
 * Normalize a Better Auth signup lead event to a Twenty upsert payload.
 * No note — signup events don't carry a message; first vs. last source
 * semantics are owned by `upsertPerson`, not the normalizer.
 */
export function normalizeSignupLead(event: AtlasSignupLeadEvent): NormalizedLead {
  const email = event.email.toLowerCase().trim();
  const eventSource: AtlasEventSource = "SIGNUP";

  const customFields: { atlasIp?: string } = {};

  const name = event.name ? splitName(event.name) : undefined;

  return {
    person: {
      email,
      eventSource,
      ...(name ? { name } : {}),
      customFields,
    },
    eventSource,
  };
}

/**
 * Normalize a self-serve MCP trial-signup event to a Twenty upsert payload.
 * Mirror of `normalizeSignupLead` save for the `MCP_SIGNUP` event source — no
 * note, no request context, first vs. last source semantics owned by
 * `upsertPerson`. The distinct source is the whole reason this variant exists
 * (ADR-0018): it lets the CRM attribute MCP self-serve as its own channel.
 */
export function normalizeMcpSignupLead(
  event: AtlasMcpSignupLeadEvent,
): NormalizedLead {
  const email = event.email.toLowerCase().trim();
  const eventSource: AtlasEventSource = "MCP_SIGNUP";

  const customFields: { atlasIp?: string } = {};

  const name = event.name ? splitName(event.name) : undefined;

  return {
    person: {
      email,
      eventSource,
      ...(name ? { name } : {}),
      customFields,
    },
    eventSource,
  };
}

/**
 * Normalize a Stripe → Twenty conversion event to a Twenty upsert
 * payload. The `atlasStripeCustomerId` rides through `customFields` and
 * is spread inline by `upsertPerson` on every write path (POST + both
 * PATCH branches), so the stamp lands regardless of whether the Person
 * already existed. No note — conversion carries no message.
 */
export function normalizeConversionLead(
  event: AtlasConversionLeadEvent,
): NormalizedLead {
  const email = event.email.toLowerCase().trim();
  const eventSource: AtlasEventSource = "CONVERSION";

  return {
    person: {
      email,
      eventSource,
      customFields: { atlasStripeCustomerId: event.stripeCustomerId },
    },
    eventSource,
  };
}

/** Dispatch on `source`. */
export function normalizeLead(event: AtlasLeadEvent): NormalizedLead {
  switch (event.source) {
    case "demo":
      return normalizeDemoLead(event);
    case "sales-form":
      return normalizeSalesFormLead(event);
    case "signup":
      return normalizeSignupLead(event);
    case "mcp-signup":
      return normalizeMcpSignupLead(event);
    case "conversion":
      return normalizeConversionLead(event);
    default: {
      // Exhaustiveness — when new variants are added to `AtlasLeadEvent`,
      // the absence of a case here surfaces as a tsgo compile error.
      const _exhaustive: never = event;
      void _exhaustive;
      throw new Error(`Unknown lead source: ${String((event as { source?: unknown }).source)}`);
    }
  }
}
