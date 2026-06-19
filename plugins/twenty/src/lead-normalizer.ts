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
 * `LeadEventSchema` is the SINGLE source of truth for the lead-event wire
 * shape. `@atlas/api` (the `SaasCrm` Tag's `upsertLead` contract) imports the
 * derived `LeadEvent` type, and `normalizeLead` runs `LeadEventSchema.parse`
 * on the raw `crm_outbox` payload — so a malformed row dead-letters with a
 * precise field error instead of an `as`-cast trusting jsonb it never
 * validated. The `ee` dispatcher passes the persisted payload straight to
 * `normalizeLead`; the schema *value* stays inside this module so only the
 * already-published `normalizeLead` symbol crosses into `@atlas/api`/`ee`.
 * Both already depend on `@useatlas/twenty`, so there is no second union to
 * mirror and no drift guard to maintain. Promote the schema to a neutral
 * package only when a SECOND CRM adapter (not the Twenty one) needs it — until
 * then the adapter that consumes the shape owns it.
 */

import { z } from "zod";
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
const demoLeadEventSchema = z.object({
  source: z.literal("demo"),
  email: z.string(),
  ip: z.string().nullish(),
  userAgent: z.string().nullish(),
});

/**
 * Sales-form variant — captured by the Talk-to-sales dialog on
 * `/pricing`. Carries the free-text message that becomes a Twenty Note
 * attached to the Person.
 */
const salesFormLeadEventSchema = z.object({
  source: z.literal("sales-form"),
  email: z.string(),
  /** Full name as typed by the prospect. Split into first/last at the seam. */
  name: z.string(),
  company: z.string(),
  /** Plan label they're interested in (e.g. "Starter" / "Pro" / "Business"). */
  planInterest: z.string(),
  /** Free-text message. Becomes the Note body verbatim. */
  message: z.string(),
  ip: z.string().nullish(),
  userAgent: z.string().nullish(),
});

/**
 * Better Auth signup variant — fired by the `user.create.after` hook in
 * `packages/api/src/lib/auth/server.ts`. No request context (no IP, no
 * UA) since the hook runs post-commit on the auth pathway, and no
 * attached message — first/last source semantics are owned by
 * `TwentyClient.upsertPerson`, so a prior demo/sales-form touch keeps
 * its `atlasFirstSource` and only `atlasLastSource` flips to `SIGNUP`.
 * `name` is optional because email-only signup is allowed.
 */
const signupLeadEventSchema = z.object({
  source: z.literal("signup"),
  email: z.string(),
  name: z.string().optional(),
});

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
 * overload. `name` is optional for parity with `signup`.
 */
const mcpSignupLeadEventSchema = z.object({
  source: z.literal("mcp-signup"),
  email: z.string(),
  name: z.string().optional(),
});

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
const conversionLeadEventSchema = z.object({
  source: z.literal("conversion"),
  email: z.string(),
  /** Stripe `customer.id` (the `cus_…` literal). */
  stripeCustomerId: z.string(),
});

/**
 * Discriminated union over every Atlas-internal lead event — the single
 * source of truth for the `crm_outbox` payload wire shape. The
 * exhaustiveness check in `normalizeLead` catches missing handlers at
 * compile time; `LeadEventSchema.parse` catches malformed payloads at the
 * `ee/src/saas-crm` flush boundary at runtime.
 */
export const LeadEventSchema = z.discriminatedUnion("source", [
  demoLeadEventSchema,
  salesFormLeadEventSchema,
  signupLeadEventSchema,
  mcpSignupLeadEventSchema,
  conversionLeadEventSchema,
]);

/** Every Atlas-internal lead event. Derived from {@link LeadEventSchema}. */
export type LeadEvent = z.infer<typeof LeadEventSchema>;

export type DemoLeadEvent = Extract<LeadEvent, { source: "demo" }>;
export type SalesFormLeadEvent = Extract<LeadEvent, { source: "sales-form" }>;
export type SignupLeadEvent = Extract<LeadEvent, { source: "signup" }>;
export type McpSignupLeadEvent = Extract<LeadEvent, { source: "mcp-signup" }>;
export type ConversionLeadEvent = Extract<LeadEvent, { source: "conversion" }>;

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
export function normalizeDemoLead(event: DemoLeadEvent): NormalizedLead {
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
  event: SalesFormLeadEvent,
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
export function normalizeSignupLead(event: SignupLeadEvent): NormalizedLead {
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
  event: McpSignupLeadEvent,
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
  event: ConversionLeadEvent,
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

/**
 * Validate the persisted payload, then dispatch on `source`. This is the
 * single trust boundary for the `crm_outbox` payload: `LeadEventSchema.parse`
 * rejects a malformed/stale row with a precise Zod field error — instead of an
 * `as`-cast trusting jsonb it never validated — and the exhaustive switch maps
 * the parsed `LeadEvent` to a Twenty upsert payload. The caller (the `ee`
 * outbox dispatcher) passes the raw jsonb object as `unknown` and gets either a
 * `NormalizedLead` or a thrown error to dead-letter. Folding the parse in here
 * (rather than exposing `LeadEventSchema` for callers to parse) also keeps the
 * schema *value* out of `@atlas/api`/`ee` import sites — only this already-
 * published `normalizeLead` symbol crosses the package boundary.
 */
export function normalizeLead(event: unknown): NormalizedLead {
  const parsed = LeadEventSchema.parse(event);
  switch (parsed.source) {
    case "demo":
      return normalizeDemoLead(parsed);
    case "sales-form":
      return normalizeSalesFormLead(parsed);
    case "signup":
      return normalizeSignupLead(parsed);
    case "mcp-signup":
      return normalizeMcpSignupLead(parsed);
    case "conversion":
      return normalizeConversionLead(parsed);
    default: {
      // Exhaustiveness — when new variants are added to `LeadEventSchema`,
      // the absence of a case here surfaces as a tsgo compile error.
      const _exhaustive: never = parsed;
      void _exhaustive;
      throw new Error(`Unknown lead source: ${String((parsed as { source?: unknown }).source)}`);
    }
  }
}
