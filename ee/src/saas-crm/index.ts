/**
 * SaaS CRM wiring — connects Atlas SaaS lead-capture flows into the
 * Twenty CRM instance at `crm.useatlas.dev` via the `@useatlas/twenty`
 * plugin. Self-hosted Atlas gets the Noop layer from
 * `lib/effect/services.ts:NoopSaasCrmLayer`.
 *
 * `upsertLead` enqueues a `crm_outbox` row and returns; the scheduler-
 * wired flusher (`lib/effect/layers.ts:makeSchedulerLive`) claims the
 * row on the next tick and calls `dispatchOutboxRow` below. A Twenty
 * outage, API crash, or partial sub-step failure does not drop the lead.
 * Enqueue itself surfaces its error via the Effect failure channel so
 * callers that care about durability (the contact form) can return 503
 * — the demo route wraps `runEnterprise` in a try/catch and swallows.
 *
 * Transient metadata-probe failures deliberately leave `available: true`
 * — a real schema mismatch surfaces as a 422 on the first upsert call.
 * Deterministic misconfigurations (401/403/404) flip to permanent so
 * leads aren't lost silently against a clearly-broken endpoint.
 */

import { Effect, Layer } from "effect";
import {
  SaasCrm,
  type SaasCrmShape,
  type SaasCrmLeadInput,
} from "@atlas/api/lib/effect/services";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import {
  enqueue,
  classifyHttpStatus,
  type OutboxDB,
  type ClaimedOutboxRow,
  type OutboxPersistHelpers,
  type DispatchOutcome,
} from "@atlas/api/lib/lead-outbox";
import { isEnterpriseEnabled } from "../index";
import {
  getPersonMetadata,
  tryResolveCredentialsFromEnv,
  normalizeLead,
  upsertPerson,
  createNote,
  TwentyClientError,
  type ResolvedTwentyCredentials,
  type TwentyClientConfig,
} from "@useatlas/twenty";

const log = createLogger("ee:saas-crm");

const REQUIRED_PERSON_FIELDS = [
  "atlasFirstSource",
  "atlasLastSource",
  // #2737 — conversion stamp lands in this custom field. Boot fails-soft
  // if it's missing so the outbox doesn't dead-letter every conversion
  // event against a 422 schema mismatch.
  "atlasStripeCustomerId",
] as const;

/**
 * Outbox event-type string for Stripe → Twenty conversion stamps
 * (#2737). Distinct from the union discriminator (`"conversion"`) on the
 * payload — the eventType is purely for crm_outbox row triage and
 * observability; the dispatcher routes by re-normalizing the payload.
 */
const STAMP_CONVERSION_EVENT_TYPE = "stamp-conversion";

/**
 * Atlas's known Twenty CRM hostname. Used as the fallback when
 * `TWENTY_BASE_URL` is unset in the SaaS deployment — self-hosters
 * never hit this code path (Noop layer is the default; if they were
 * to install `@useatlas/twenty`, they go through the plugin's
 * `atlas.config.ts` which requires `baseUrl` explicitly).
 */
const ATLAS_SAAS_TWENTY_BASE_URL = "https://crm.useatlas.dev";

/**
 * Per-request timeout for the SaaS CRM client. With the outbox in
 * place the demo response no longer waits on the dispatch, so we
 * could relax this — but a tight timeout still bounds how long a
 * single flush tick blocks on a stuck Twenty. 5s keeps the flusher
 * responsive without thrashing on transient slow responses.
 */
const SAAS_TIMEOUT_MS = 5_000;

function missingFieldInstructions(missing: ReadonlyArray<string>): string {
  return (
    `Twenty Person object is missing required Atlas custom field(s): ${missing.join(", ")}. ` +
    `Create them in the Twenty UI under Settings → Data Model → Person → + Add Field. ` +
    `Each field should be of type "Text". SaaS CRM dispatch is disabled until all of ` +
    `${REQUIRED_PERSON_FIELDS.join(", ")} exist on the Person object.`
  );
}

function misconfigurationInstructions(status: number, baseUrl: string): string {
  return (
    `Twenty metadata probe returned HTTP ${status} from ${baseUrl}/metadata — ` +
    `this is a deterministic misconfiguration that will NEVER succeed without ` +
    `operator intervention. Check TWENTY_API_KEY (bearer token from Twenty → ` +
    `Settings → API & Webhooks) and TWENTY_BASE_URL (must point at a Twenty ` +
    `instance whose /metadata GraphQL endpoint is reachable). SaaS CRM dispatch ` +
    `is disabled until this is fixed.`
  );
}

/**
 * Build the TwentyClient config with the SaaS defaults applied. The
 * Atlas-internal base URL fallback lives here, NOT in the plugin's
 * schema default — self-hosters who install `@useatlas/twenty`
 * directly must point at their own Twenty.
 */
function buildSaasClientConfig(creds: ResolvedTwentyCredentials): TwentyClientConfig {
  return {
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl ?? ATLAS_SAAS_TWENTY_BASE_URL,
    timeoutMs: SAAS_TIMEOUT_MS,
  };
}

/**
 * Run startup verification against the Twenty metadata endpoint.
 *
 * Returns:
 *  - `ok: true` — both required fields are present.
 *  - `ok: false` — fields missing OR upstream returned a deterministic
 *    misconfiguration code (401/403/404). A structured `log.error` has
 *    already been emitted.
 *  - `ok: "transient"` — network / 5xx / parse failure. Layer stays
 *    available; a real schema mismatch will surface as a 422 on the
 *    first upsertPerson call.
 */
async function verifyCustomFields(
  creds: ResolvedTwentyCredentials,
): Promise<{ ok: true } | { ok: false } | { ok: "transient"; reason: string }> {
  const baseUrl = creds.baseUrl ?? ATLAS_SAAS_TWENTY_BASE_URL;
  try {
    const meta = await getPersonMetadata({
      apiKey: creds.apiKey,
      baseUrl,
      timeoutMs: SAAS_TIMEOUT_MS,
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
    // 401/403/404 are deterministic misconfigurations — silently
    // marking them transient would leave `available: true` and every
    // subsequent dispatch would fail identically forever, losing leads.
    if (
      err instanceof TwentyClientError &&
      (err.status === 401 || err.status === 403 || err.status === 404)
    ) {
      log.error(
        {
          status: err.status,
          upstreamCode: err.upstreamCode,
          err: err.message,
          baseUrl,
          event: "saas_crm.metadata_misconfigured",
        },
        misconfigurationInstructions(err.status, baseUrl),
      );
      return { ok: false };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: "transient", reason };
  }
}

/**
 * The outbox-side OutboxDB adapter. We delegate to the module-level
 * `internalQuery` rather than yielding `InternalDB` from Effect
 * Context so the SaasCrm Layer requirements stay empty — the demo
 * route's `runEnterprise(...)` provides `EnterpriseSubsystem`, not
 * `InternalDB`, and we don't want to widen that contract just to give
 * the SaasCrm layer access to the pool.
 */
const outboxDb: OutboxDB = {
  query: internalQuery,
};

/**
 * Dispatch one claimed outbox row through the Twenty client. Each
 * sub-step's resource ID is persisted via the `persist` callbacks
 * AS SOON AS the call returns — that's what makes the partial-success
 * crash path idempotent on retry.
 *
 * Errors are classified into `transient` / `permanent` based on the
 * upstream HTTP status (per #2729): 4xx other than 429 → permanent
 * (deterministic misconfig, never going to succeed on retry); 5xx /
 * 429 / transport / unknown → transient (worth a retry).
 */
export async function dispatchOutboxRow(
  clientConfig: TwentyClientConfig,
  row: ClaimedOutboxRow,
  persist: OutboxPersistHelpers,
): Promise<DispatchOutcome> {
  // Normalize from the persisted payload. The payload was JSON.stringified
  // on enqueue (`enqueue` passes `JSON.stringify(input.payload)`), and the
  // jsonb column round-trips through pg as a plain object — so what we
  // get back is structurally a `SaasCrmLeadInput`. Cast at this single
  // boundary; downstream code is type-safe.
  let normalized;
  try {
    normalized = normalizeLead(row.payload as SaasCrmLeadInput);
  } catch (err) {
    // A normalizer error is a bug in our own code (the discriminated
    // union exhaustiveness should have caught it). Dead-letter so an
    // operator sees the corrupt payload.
    return {
      kind: "permanent",
      message: `normalizeLead threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Row snapshot is frozen at claim time; track `personId` locally so
  // sub-step 2 (createNote) sees the id sub-step 1 (upsertPerson) just
  // persisted on the SAME dispatch.
  let personId: string | null = row.twentyPersonId;

  // ── Sub-step 1: upsertPerson (always required) ────────────────────
  if (!personId) {
    let person;
    try {
      person = await upsertPerson(clientConfig, normalized.person);
    } catch (err) {
      return classifyTwentyError(err, "upsertPerson");
    }
    if (!person.id) {
      // Twenty returned a 2xx Person with no id. Treat as permanent —
      // we have no way to reference the record on retry, so retrying
      // would just create another duplicate-by-email upsert against
      // an already-mutated record. Operator must inspect.
      return {
        kind: "permanent",
        message: "upsertPerson succeeded but returned no id",
      };
    }
    // Persist the id in its own try/catch so an isolated pg blip is
    // labelled as a persist failure, not as an `upsertPerson threw`.
    // The next claim will see `twentyPersonId === null` and re-call
    // upsertPerson, which is safe because `upsertPerson` itself does
    // a find-by-email-first → PATCH-if-exists (no duplicate Person).
    try {
      await persist.setTwentyPersonId(person.id);
    } catch (err) {
      return {
        kind: "transient",
        message:
          `persist.setTwentyPersonId failed after upsertPerson succeeded ` +
          `(personId=${person.id}): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    personId = person.id;
  }

  // ── Sub-step 2: createNote (sales-form only) ──────────────────────
  // Normalized payload carries the note shape for sales-form rows; demo
  // rows have no note and skip this branch entirely. Skip on replay when
  // twentyNoteId is already populated — sub-step idempotency contract:
  // createNote must NOT be called twice on retry.
  if (normalized.note && !row.twentyNoteId) {
    if (!personId) {
      // Defensive: sub-step 1 above must have populated personId. If we
      // got here without it, our own invariant is broken — dead-letter
      // so an operator sees it (the row would otherwise loop forever).
      return {
        kind: "permanent",
        message: "createNote skipped — personId is null after upsertPerson sub-step (invariant violation)",
      };
    }
    let note;
    try {
      note = await createNote(clientConfig, {
        personId,
        title: normalized.note.title,
        body: normalized.note.body,
      });
    } catch (err) {
      return classifyTwentyError(err, "createNote");
    }
    if (!note.id) {
      // createNote's own contract throws when 2xx has no id, so this is
      // belt-and-suspenders. Same reasoning as the upsertPerson no-id
      // branch above.
      return {
        kind: "permanent",
        message: "createNote succeeded but returned no id",
      };
    }
    try {
      await persist.setTwentyNoteId(note.id);
    } catch (err) {
      return {
        kind: "transient",
        message:
          `persist.setTwentyNoteId failed after createNote succeeded ` +
          `(noteId=${note.id}): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { kind: "ok" };
}

function classifyTwentyError(err: unknown, op: string): DispatchOutcome {
  if (err instanceof TwentyClientError) {
    // Orphaned-note signal — note POST succeeded, link POST failed.
    // The note exists in Twenty under `orphanedNoteId` with no Person
    // attached; the next dispatch retry will create a SECOND linked
    // note. Emit a dedicated structured event so operators can grep
    // for the orphan id and delete it from Twenty by hand.
    if (err.orphanedNoteId) {
      log.warn(
        {
          event: "saas_crm.twenty_note_orphaned",
          orphanedNoteId: err.orphanedNoteId,
          status: err.status,
          upstreamCode: err.upstreamCode,
          op,
        },
        `Twenty Note ${err.orphanedNoteId} was created but the noteTarget link failed — the next dispatch retry will create a duplicate. Delete the orphaned note in Twenty when convenient.`,
      );
    }
    const classification = classifyHttpStatus(err.status);
    const message = `${op} failed (status=${err.status}${err.upstreamCode ? `, code=${err.upstreamCode}` : ""}): ${err.message}`;
    if (classification === "transient") {
      return {
        kind: "transient",
        message,
        httpStatus: err.status,
        retryAfterMs: err.retryAfterMs,
      };
    }
    return { kind: "permanent", message, httpStatus: err.status };
  }
  const message = `${op} threw: ${err instanceof Error ? err.message : String(err)}`;
  return { kind: "transient", message };
}

// Boot-time verification runs once inside Layer.effect; available reflects that one check.
export const SaasCrmLive: Layer.Layer<SaasCrm> = Layer.effect(
  SaasCrm,
  Effect.gen(function* () {
    const enterpriseOn = isEnterpriseEnabled();
    if (!enterpriseOn) {
      log.info("Enterprise disabled — SaasCrm.available=false");
      return {
        available: false,
        upsertLead: () => Effect.void,
        stampConversion: () => Effect.void,
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
        stampConversion: () => Effect.void,
      } satisfies SaasCrmShape;
    }

    if (!hasInternalDB()) {
      log.warn(
        { event: "saas_crm.no_internal_db" },
        "Internal DB unavailable — SaasCrm.available=false. The outbox cannot enqueue without a Postgres backing store.",
      );
      return {
        available: false,
        upsertLead: () => Effect.void,
        stampConversion: () => Effect.void,
      } satisfies SaasCrmShape;
    }

    const verifyResult = yield* Effect.promise(() => verifyCustomFields(creds));
    if (verifyResult.ok === false) {
      // Already logged inside verifyCustomFields (missing fields OR
      // deterministic misconfiguration). Surface unavailable so
      // subsequent demo signups are no-ops rather than rows that will
      // dead-letter on the very first flush.
      return {
        available: false,
        upsertLead: () => Effect.void,
        stampConversion: () => Effect.void,
      } satisfies SaasCrmShape;
    }
    if (verifyResult.ok === "transient") {
      log.warn(
        { err: verifyResult.reason, event: "saas_crm.verify_transient_failure" },
        "Twenty metadata endpoint errored during boot verification — assuming custom fields are present. " +
          "A real schema mismatch will surface as a 422 on the first dispatch (and dead-letter the row).",
      );
    } else {
      log.info(
        {
          baseUrl: creds.baseUrl ?? ATLAS_SAAS_TWENTY_BASE_URL,
          event: "saas_crm.ready",
        },
        `SaasCrm wired up — ${REQUIRED_PERSON_FIELDS.join(" + ")} verified on Twenty Person`,
      );
    }

    const clientConfig = buildSaasClientConfig(creds);

    return {
      available: true,
      upsertLead: (input) =>
        Effect.tryPromise({
          try: async () => {
            await enqueue(outboxDb, {
              eventType: input.source,
              payload: input as unknown as Record<string, unknown>,
            });
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          // Tap the failure into a structured log so an operator sees
          // it regardless of how the caller chooses to surface the
          // error. Callers that swallow (demo route, where the user
          // already has a sandbox link) still get the audit trail;
          // callers that propagate (contact route, where a lost lead
          // is a missed sales conversation) get to return 503.
          Effect.tapError((err) =>
            Effect.sync(() => {
              log.error(
                {
                  source: input.source,
                  err: err.message,
                  event: "saas_crm.enqueue_failed",
                },
                "crm_outbox enqueue failed — Postgres write error",
              );
            }),
          ),
        ),
      stampConversion: (input) => {
        // Construct the canonical `conversion` SaasCrmLeadInput payload
        // — the normalizer is the single source of truth for the
        // dispatch shape, and routing by re-normalizing the payload
        // keeps the dispatcher generic over event types.
        const payload: SaasCrmLeadInput = {
          source: "conversion",
          email: input.email,
          stripeCustomerId: input.stripeCustomerId,
        };
        return Effect.tryPromise({
          try: async () => {
            await enqueue(outboxDb, {
              eventType: STAMP_CONVERSION_EVENT_TYPE,
              payload: payload as unknown as Record<string, unknown>,
            });
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          Effect.tapError((err) =>
            Effect.sync(() => {
              log.error(
                {
                  // Don't log the stripeCustomerId; bare-minimum
                  // breadcrumb is email + the error.
                  email: input.email,
                  err: err.message,
                  event: "saas_crm.stamp_conversion_enqueue_failed",
                },
                "crm_outbox enqueue failed for stamp-conversion — Postgres write error",
              );
            }),
          ),
        );
      },
      dispatcher: (row, persist) => dispatchOutboxRow(clientConfig, row, persist),
    } satisfies SaasCrmShape;
  }),
);

// Re-exported for direct testing of the verification / dispatch logic.
export {
  verifyCustomFields,
  buildSaasClientConfig,
  ATLAS_SAAS_TWENTY_BASE_URL,
  classifyTwentyError,
  STAMP_CONVERSION_EVENT_TYPE,
  REQUIRED_PERSON_FIELDS,
};
