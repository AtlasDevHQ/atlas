/**
 * LeadNormalizer — pure mapping from Atlas lead events to the Twenty
 * upsert input shape.
 *
 * Currently ships the demo variant only — `normalizeLead`'s exhaustive
 * switch surfaces a compile error the moment a new union member lands.
 *
 * Design rule: the normalizer outputs a single `eventSource` field;
 * the first-source / last-source translation happens INSIDE
 * `TwentyClient.upsertPerson`. That keeps this module a pure function
 * of input → payload, with no I/O and no Twenty-record-state coupling.
 *
 * Types are defined inline here for 0.0.1; they will move to
 * `@useatlas/types` in a subsequent release so the dispatch boundary
 * (`@useatlas/twenty` → SaaS CRM seam) can share one source of truth.
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
 * Discriminated union over every Atlas-internal lead event.
 *
 * Extended in subsequent slices: signup hook (`source: "signup"`),
 * sales-form (`source: "sales-form"`), etc. The exhaustiveness check
 * in `normalizeLead` catches missing handlers at compile time.
 */
export type AtlasLeadEvent = AtlasDemoLeadEvent;

export interface NormalizedLead {
  readonly person: UpsertPersonInput;
  /** Mirror of `person.eventSource` — surfaced so the caller can log / route. */
  readonly eventSource: AtlasEventSource;
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

/** Dispatch on `source`. */
export function normalizeLead(event: AtlasLeadEvent): NormalizedLead {
  switch (event.source) {
    case "demo":
      return normalizeDemoLead(event);
    default: {
      // Exhaustiveness — when new variants are added to `AtlasLeadEvent`,
      // the absence of a case here surfaces as a tsgo compile error.
      const _exhaustive: never = event.source;
      void _exhaustive;
      throw new Error(`Unknown lead source: ${String((event as { source?: unknown }).source)}`);
    }
  }
}
