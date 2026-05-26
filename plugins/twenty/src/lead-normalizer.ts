/**
 * LeadNormalizer — pure mapping from Atlas lead events to the Twenty
 * upsert input shape.
 *
 * Ships the `demo`, `sales-form`, and `signup` variants. `normalizeLead`'s
 * exhaustive switch surfaces a compile error the moment a new union
 * member lands.
 *
 * Design rule: the normalizer outputs a single `eventSource` field;
 * the first-source / last-source translation happens INSIDE
 * `TwentyClient.upsertPerson`. That keeps this module a pure function
 * of input → payload, with no I/O and no Twenty-record-state coupling.
 *
 * Types are defined inline here and mirrored in `packages/api/src/lib/effect/services.ts`
 * (`SaasCrmLeadInput`) — the exhaustiveness switch in `normalizeLead`
 * keeps the two in lockstep. Promote to `@useatlas/types` when a second
 * consumer outside of `ee/src/saas-crm/` appears.
 */

import type { UpsertPersonInput } from "./client";

/**
 * Sticky / last-touch source attribution stamped on Twenty Person
 * records. Narrow literal union: a typo here persists in Twenty
 * forever, so the type must reject misspellings at compile time.
 */
export type AtlasEventSource = "DEMO" | "SIGNUP" | "SALES_FORM" | "OTHER";

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
 * Discriminated union over every Atlas-internal lead event. The
 * exhaustiveness check in `normalizeLead` catches missing handlers
 * at compile time.
 */
export type AtlasLeadEvent =
  | AtlasDemoLeadEvent
  | AtlasSalesFormLeadEvent
  | AtlasSignupLeadEvent;

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

  // No request context on the auth-side hook → no atlasIp.
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

/** Dispatch on `source`. */
export function normalizeLead(event: AtlasLeadEvent): NormalizedLead {
  switch (event.source) {
    case "demo":
      return normalizeDemoLead(event);
    case "sales-form":
      return normalizeSalesFormLead(event);
    case "signup":
      return normalizeSignupLead(event);
    default: {
      // Exhaustiveness — when new variants are added to `AtlasLeadEvent`,
      // the absence of a case here surfaces as a tsgo compile error.
      const _exhaustive: never = event;
      void _exhaustive;
      throw new Error(`Unknown lead source: ${String((event as { source?: unknown }).source)}`);
    }
  }
}
