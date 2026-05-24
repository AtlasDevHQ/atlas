/**
 * SaaS CRM wiring — slice 1 of #2726 (#2727).
 *
 * Connects Atlas SaaS demo / (future) signup / (future) contact flows
 * into the Twenty CRM instance at crm.useatlas.dev via the
 * `@useatlas/twenty` plugin. Gated by `isEnterpriseEnabled()` —
 * self-hosters get the Noop layer from
 * `lib/effect/services.ts:NoopSaasCrmLayer`.
 *
 * Boot behavior:
 *  1. If enterprise is DISABLED → return `{ available: false }`.
 *  2. If `TWENTY_API_KEY` is unset → log warn, return `{ available: false }`.
 *  3. Verify that `atlasFirstSource` AND `atlasLastSource` custom fields
 *     exist on the Twenty Person object via the metadata endpoint.
 *     - Both present → `available: true`.
 *     - Either missing → `log.error` with exact creation instructions;
 *       `available: false`.
 *     - Metadata endpoint errors (transient network) → log warn,
 *       leave `available: true` so dispatches still attempt; a
 *       missing-field response will surface as the upstream 422 on
 *       the upsert call.
 *
 * Dispatch path (`upsertLead`):
 *  - Normalize the event via `LeadNormalizer` (slice 1: demo only).
 *  - Invoke `TwentyClient.upsertPerson` with credentials from
 *    `TwentyCredentialResolver.resolveCredentialsFromEnv()`.
 *  - On any failure: log a warning and swallow the error (return success).
 *    Atlas's demo-gate path must never block on Twenty.
 *
 * The durable outbox + retry loop arrives in slice 4 of #2726. Until
 * then, this is fire-and-forget — Twenty being down loses the lead.
 */

import { Effect, Layer } from "effect";
import {
  SaasCrm,
  type SaasCrmShape,
  type SaasCrmLeadInput,
} from "@atlas/api/lib/effect/services";
import { createLogger } from "@atlas/api/lib/logger";
import { isEnterpriseEnabled } from "../index";
import {
  getPersonMetadata,
  tryResolveCredentialsFromEnv,
  normalizeLead,
  upsertPerson,
  TwentyClientError,
  type ResolvedTwentyCredentials,
  type TwentyClientConfig,
} from "@useatlas/twenty";

const log = createLogger("ee:saas-crm");

const REQUIRED_PERSON_FIELDS = ["atlasFirstSource", "atlasLastSource"] as const;

/**
 * Build the create-instructions string for a missing custom field. The
 * exact text is part of the slice-1 acceptance criteria — when an
 * operator sees this, they should be able to follow it without
 * cross-referencing the README.
 */
function missingFieldInstructions(missing: ReadonlyArray<string>): string {
  return (
    `Twenty Person object is missing required Atlas custom field(s): ${missing.join(", ")}. ` +
    `Create them in the Twenty UI under Settings → Data Model → Person → + Add Field. ` +
    `Each field should be of type "Text". SaaS CRM dispatch is disabled until both ` +
    `atlasFirstSource and atlasLastSource exist on the Person object.`
  );
}

/**
 * Run startup verification against the Twenty metadata endpoint.
 *
 * Returns:
 *  - { ok: true } when both required fields are present.
 *  - { ok: false } when one or both fields are missing (a structured
 *    log.error has already been emitted).
 *  - { ok: "transient" } when the metadata endpoint itself errored
 *    (network blip / 5xx / parse failure). Per spec we leave the
 *    layer available — the upsert call will surface any real schema
 *    drift as a 422 upstream error.
 */
async function verifyCustomFields(
  creds: ResolvedTwentyCredentials,
): Promise<{ ok: true } | { ok: false } | { ok: "transient"; reason: string }> {
  try {
    const meta = await getPersonMetadata({
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
    });
    const present = new Set(meta.fields.map((f) => f.name));
    const missing = REQUIRED_PERSON_FIELDS.filter((f) => !present.has(f));
    if (missing.length === 0) return { ok: true };
    log.error(
      { missing, event: "saas_crm.custom_fields_missing" },
      missingFieldInstructions(missing),
    );
    return { ok: false };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: "transient", reason };
  }
}

/**
 * Dispatch a normalized lead via TwentyClient. Errors are caught and
 * logged inside this function so the SaasCrmShape Effect channel can
 * stay typed as `Effect<void>` (no error channel) — that contract is
 * what makes the call-site short (`yield* SaasCrm` then
 * `yield* upsertLead(input)` with nothing to catch).
 */
async function dispatchLead(
  clientConfig: TwentyClientConfig,
  input: SaasCrmLeadInput,
): Promise<void> {
  try {
    const normalized = normalizeLead(input);
    await upsertPerson(clientConfig, normalized.person);
    log.debug(
      { source: input.source, eventSource: normalized.eventSource },
      "SaaS CRM lead dispatched to Twenty",
    );
  } catch (err) {
    // Twenty being down (or a missing custom field, or a bad key)
    // MUST NOT block the caller. We log loudly enough that an operator
    // can correlate but never re-throw.
    if (err instanceof TwentyClientError) {
      log.warn(
        {
          source: input.source,
          status: err.status,
          upstreamCode: err.upstreamCode,
          err: err.message,
          event: "saas_crm.dispatch_failed",
        },
        "Twenty upsertPerson failed — lead lost (durable outbox lands in slice 4)",
      );
    } else {
      log.warn(
        {
          source: input.source,
          err: err instanceof Error ? err.message : String(err),
          event: "saas_crm.dispatch_failed",
        },
        "Twenty dispatch threw unexpectedly — lead lost",
      );
    }
  }
}

/**
 * Build the live SaasCrm service. Runs the boot-time verification once
 * inside `Layer.effect` — `available` is the result of that check; it
 * does NOT re-verify on every `upsertLead` call.
 */
export const SaasCrmLive: Layer.Layer<SaasCrm> = Layer.effect(
  SaasCrm,
  Effect.gen(function* () {
    const enterpriseOn = isEnterpriseEnabled();
    if (!enterpriseOn) {
      log.info("Enterprise disabled — SaasCrm.available=false");
      return {
        available: false,
        upsertLead: () => Effect.void,
      } satisfies SaasCrmShape;
    }

    const creds = tryResolveCredentialsFromEnv();
    if (!creds) {
      log.warn(
        { event: "saas_crm.credentials_absent" },
        "TWENTY_API_KEY not set — SaasCrm.available=false. Set TWENTY_API_KEY (and optionally TWENTY_BASE_URL) to enable SaaS CRM dispatch.",
      );
      return {
        available: false,
        upsertLead: () => Effect.void,
      } satisfies SaasCrmShape;
    }

    const verifyResult = yield* Effect.promise(() => verifyCustomFields(creds));
    if (verifyResult.ok === false) {
      // Already logged inside verifyCustomFields. Surface as unavailable
      // so subsequent demo signups are no-ops rather than dead-letter
      // rows in the (future) outbox.
      return {
        available: false,
        upsertLead: () => Effect.void,
      } satisfies SaasCrmShape;
    }
    if (verifyResult.ok === "transient") {
      log.warn(
        { err: verifyResult.reason, event: "saas_crm.verify_transient_failure" },
        "Twenty metadata endpoint errored during boot verification — assuming custom fields are present. " +
          "A real schema mismatch will surface as a 422 on the first upsertPerson call.",
      );
    } else {
      log.info(
        { baseUrl: creds.baseUrl, event: "saas_crm.ready" },
        "SaasCrm wired up — atlasFirstSource + atlasLastSource verified on Twenty Person",
      );
    }

    const clientConfig: TwentyClientConfig = {
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
    };

    return {
      available: true,
      upsertLead: (input) =>
        Effect.promise(() => dispatchLead(clientConfig, input)),
    } satisfies SaasCrmShape;
  }),
);

// Re-exported for direct testing of the verification / dispatch logic.
export { verifyCustomFields, dispatchLead };
