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
 * Boot probe fails closed (#2860). Any verification failure — missing
 * required custom field, deterministic misconfig (401/403/404), network
 * error, 5xx, or unparseable response — flips `available: false`. The
 * contact route then returns 404 and the marketing site's mailto
 * fallback captures leads, rather than the prior silent-transient path
 * that left `available: true` and dead-lettered every submission. The
 * probe targets Twenty's REST OpenAPI spec at `/rest/open-api/core`
 * (the GraphQL `/metadata` surface has drifted between Twenty releases
 * and `ObjectFilter.nameSingular` no longer exists in current Twenty).
 * The boot-resolved field set is reused as the dispatcher's payload
 * allowlist so optional fields like `atlasIp` the operator chose not
 * to create are silently dropped instead of 400-ing the upsert.
 *
 * Credential source — env-only (#2850). `TWENTY_API_KEY` /
 * `TWENTY_BASE_URL` belong to Atlas-the-operator; this Layer never
 * reads `twenty_integrations`. That table is reserved for per-workspace
 * plugin installs (Admin → Integrations → Twenty), which use the
 * `resolveWorkspaceCredentials` seam — not this Layer. The split makes
 * the Direction-2 leak structurally impossible: a future change here
 * cannot accidentally route Atlas's leads through a customer's Twenty
 * because the workspace function is not importable from this file
 * (enforced by `scripts/check-twenty-resolver-imports.sh`).
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
  tryResolveOperatorCredentials,
  normalizeLead,
  upsertPerson,
  createNote,
  getPersonRestSchema,
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
 * Atlas-specific custom fields the dispatcher CAN populate but the
 * workspace operator MAY choose to skip. The client.ts allowlist filter
 * silently omits any of these missing from the Twenty schema so we
 * don't 400 the entire upsert over a single optional field. Add a name
 * here when the dispatcher gains a new optional field; keep
 * `REQUIRED_PERSON_FIELDS` above for the load-bearing ones whose
 * absence should fail boot.
 */
const OPTIONAL_PERSON_FIELDS = ["atlasIp"] as const;

/**
 * Standard Twenty Person fields the dispatcher MUST be able to write —
 * `emails` is the email-keyed-upsert primary key; without it every POST
 * would be a body-less write. Treated identically to a missing custom
 * field at boot: probe shape that lacks `emails` flips `available: false`
 * rather than constructing a `filterPersonPayload` that silently strips
 * the lead's email out of every dispatch. Defensive against future
 * Twenty schema reshapes (e.g. composition via `$ref` / `allOf` that
 * would not populate flat `properties` keys).
 */
const REQUIRED_STANDARD_PERSON_FIELDS = ["emails"] as const;

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
    `Twenty REST OpenAPI probe returned HTTP ${status} from ${baseUrl}/rest/open-api/core — ` +
    `this is a deterministic misconfiguration that will NEVER succeed without ` +
    `operator intervention. Check TWENTY_API_KEY (bearer token from Twenty → ` +
    `Settings → API & Webhooks) and TWENTY_BASE_URL (must point at a Twenty ` +
    `instance whose REST API is reachable). SaaS CRM dispatch is disabled ` +
    `until this is fixed.`
  );
}

function unreachableProbeInstructions(reason: string, baseUrl: string): string {
  return (
    `Twenty REST OpenAPI probe at ${baseUrl}/rest/open-api/core was unreachable ` +
    `(${reason}). SaaS CRM dispatch is disabled until the probe succeeds — ` +
    `we will not "assume fields are present" and silently dead-letter every ` +
    `subsequent submission. /api/v1/contact will return 404; the marketing ` +
    `site's mailto fallback continues to capture leads while the probe is fixed.`
  );
}

/**
 * Build the TwentyClient config with the SaaS defaults applied. The
 * Atlas-internal base URL fallback lives here, NOT in the plugin's
 * schema default — self-hosters who install `@useatlas/twenty`
 * directly must point at their own Twenty.
 *
 * `allowedPersonFields` threads the boot-probed schema allowlist into
 * the client so `upsertPerson` / `stampStripeCustomerId` automatically
 * drop optional fields (e.g. `atlasIp`) the operator chose not to
 * create on their Twenty workspace.
 */
function buildSaasClientConfig(
  creds: ResolvedTwentyCredentials,
  allowedPersonFields?: ReadonlySet<string>,
): TwentyClientConfig {
  return {
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl ?? ATLAS_SAAS_TWENTY_BASE_URL,
    timeoutMs: SAAS_TIMEOUT_MS,
    allowedPersonFields,
  };
}

/**
 * Run startup verification against the Twenty REST OpenAPI spec.
 *
 * Returns:
 *  - `ok: true` with the `present` set — all required custom fields exist;
 *    the set is the full Person property list (standard + custom) so the
 *    dispatcher can filter optional fields the operator didn't create.
 *  - `ok: false` — fields missing OR upstream returned a deterministic
 *    misconfiguration code (401/403/404) OR the probe was unreachable.
 *    A structured `log.error` has already been emitted. In all cases the
 *    Live layer sets `available: false` — we never silently swallow an
 *    unverifiable schema.
 *
 * This replaces the prior GraphQL-metadata probe, which broke against
 * current Twenty when `ObjectFilter.nameSingular` was removed. The REST
 * OpenAPI surface is documented, stable across Twenty releases, and
 * authenticated identically to the data API.
 */
async function verifyCustomFields(
  creds: ResolvedTwentyCredentials,
): Promise<{ ok: true; present: ReadonlySet<string> } | { ok: false }> {
  const baseUrl = creds.baseUrl ?? ATLAS_SAAS_TWENTY_BASE_URL;
  try {
    const schema = await getPersonRestSchema({
      apiKey: creds.apiKey,
      baseUrl,
      timeoutMs: SAAS_TIMEOUT_MS,
    });
    const missingStandard = REQUIRED_STANDARD_PERSON_FIELDS.filter(
      (f) => !schema.fields.has(f),
    );
    if (missingStandard.length > 0) {
      // Defensive guard. The dispatcher uses the probe set as the
      // payload allowlist; a probe shape that omits `emails` would make
      // `filterPersonPayload` strip the lead's email out of every POST.
      // Treat as a permanent misconfig — never construct a client config
      // that's pre-broken at the email level.
      log.error(
        { missing: missingStandard, event: "saas_crm.standard_fields_missing" },
        `Twenty REST OpenAPI probe returned a Person schema missing standard fields ` +
          `(${missingStandard.join(", ")}). This is a Twenty-side schema reshape ` +
          `(likely $ref / allOf composition not flattened into properties) — the ` +
          `dispatcher cannot safely write Person records when standard keys are ` +
          `absent from the allowlist. SaaS CRM dispatch is disabled until the ` +
          `probe returns a flat-properties Person schema again.`,
      );
      return { ok: false };
    }
    const missing = REQUIRED_PERSON_FIELDS.filter((f) => !schema.fields.has(f));
    if (missing.length === 0) return { ok: true, present: schema.fields };
    log.error(
      { missing, event: "saas_crm.custom_fields_missing" },
      missingFieldInstructions(missing),
    );
    return { ok: false };
  } catch (err) {
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
          event: "saas_crm.openapi_misconfigured",
        },
        misconfigurationInstructions(err.status, baseUrl),
      );
      return { ok: false };
    }
    // Network / 5xx / parse / unknown error. Previously this was a
    // silent transient with `available: true` — that path eats leads at
    // dispatch time (cf. 1.6.0 hotfix where every submission dead-lettered
    // because the GraphQL probe was broken but the Live layer assumed
    // fields were present). Fail closed instead so /api/v1/contact returns
    // 404 and the mailto fallback handles leads while the probe is fixed.
    const reason = err instanceof Error ? err.message : String(err);
    log.error(
      { err: reason, baseUrl, event: "saas_crm.openapi_unreachable" },
      unreachableProbeInstructions(reason, baseUrl),
    );
    return { ok: false };
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

    // Credential source: env-only (#2850). `twenty_integrations` is
    // off-limits here — that table is for per-workspace plugin installs
    // (Admin → Integrations → Twenty), and routing Atlas's lead-capture
    // through it would create the Direction-2 leak documented in #2850.
    // The grep gate in scripts/check-twenty-resolver-imports.sh enforces
    // that this file cannot import resolveWorkspaceCredentials.
    const bootCreds = tryResolveOperatorCredentials();
    if (!bootCreds) {
      log.warn(
        { event: "saas_crm.credentials_absent" },
        "No Twenty operator credentials configured — SaasCrm.available=false. Set TWENTY_API_KEY in the environment (this env var is reserved for Atlas's own lead-capture pipeline; per-workspace plugin installs use Admin → Integrations → Twenty).",
      );
      return {
        available: false,
        upsertLead: () => Effect.void,
        stampConversion: () => Effect.void,
      } satisfies SaasCrmShape;
    }

    const verifyResult = yield* Effect.promise(() => verifyCustomFields(bootCreds));
    if (verifyResult.ok === false) {
      // Already logged inside verifyCustomFields (missing required field,
      // deterministic misconfig, or unreachable probe). Fail closed so
      // /api/v1/contact returns 404 and the marketing site's mailto
      // fallback captures leads while the operator investigates — never
      // accept submissions we know will dead-letter at dispatch.
      return {
        available: false,
        upsertLead: () => Effect.void,
        stampConversion: () => Effect.void,
      } satisfies SaasCrmShape;
    }

    const optionalFieldStatus = OPTIONAL_PERSON_FIELDS.map((f) => ({
      name: f,
      present: verifyResult.present.has(f),
    }));
    log.info(
      {
        baseUrl: bootCreds.baseUrl ?? ATLAS_SAAS_TWENTY_BASE_URL,
        credentialSource: bootCreds.source,
        optional: optionalFieldStatus,
        event: "saas_crm.ready",
      },
      `SaasCrm wired up — ${REQUIRED_PERSON_FIELDS.join(" + ")} verified on Twenty Person. ` +
        `Optional fields ${OPTIONAL_PERSON_FIELDS.join(", ")} dispatched only when present in the workspace schema.`,
    );

    // Boot-resolved env client config. Reused across every dispatch:
    // the env-only source means TWENTY_API_KEY / TWENTY_BASE_URL are
    // baked in at process start, and runtime mutation is not supported
    // (admin-UI credential edits flow through the per-workspace plugin
    // install, NOT here — see #2850). `allowedPersonFields` carries the
    // boot-probed schema allowlist so the client strips optional fields
    // (e.g. `atlasIp`) the workspace didn't create.
    const clientConfig: TwentyClientConfig = buildSaasClientConfig(
      bootCreds,
      verifyResult.present,
    );

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
      // Single-config dispatcher: env credentials are static for the
      // process lifetime, so we reuse the boot-resolved config (no
      // per-row credential re-read). `verifyCustomFields` already ran
      // at boot — if it had failed, this Layer would have short-
      // circuited to `available: false` above.
      dispatcher: async (row, persist) => {
        return dispatchOutboxRow(clientConfig, row, persist);
      },
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
