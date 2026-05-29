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
 * Credential source — per-row routing on `workspace_id` (#2849, built
 * on the #2850 resolver split):
 *
 *   - workspace_id matches the resolved operator id (or the sentinel
 *     `<atlas-operator>` on regions/deploys with no flagged operator
 *     row) → boot env config (`TWENTY_API_KEY` / `TWENTY_BASE_URL`)
 *     resolved once via `tryResolveOperatorCredentials`. This is the
 *     SaaS lead-capture pipeline at `crm.useatlas.dev`.
 *   - any other workspace_id → fresh per-row lookup against
 *     `twenty_integrations` via `resolveWorkspaceCredentials` +
 *     `lookupTwentyDbCredentials`. The Direction-2 leak (operator
 *     credentials leaking into per-tenant dispatch) is prevented by
 *     the workspace_id stamp being a deterministic enqueue-time fact
 *     rather than a query-time guess; the Direction-1 leak (per-tenant
 *     credentials leaking into the operator pipeline) is prevented by
 *     the resolver split in #2850 — `resolveWorkspaceCredentials`
 *     never falls back to env regardless of the workspace_id value.
 *
 * The grep gate at `scripts/check-twenty-resolver-imports.sh` keeps
 * `resolveOperatorCredentials` confined to `ee/src/saas-crm/`; this
 * file is the only consumer of both resolvers, which is correct —
 * it's the single seam where per-tenant and operator-env credentials
 * are picked.
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
import { lookupTwentyDbCredentials } from "@atlas/api/lib/integrations/twenty/credentials";
import { isEnterpriseEnabled } from "../index";
import {
  tryResolveOperatorCredentials,
  resolveWorkspaceCredentials,
  normalizeLead,
  upsertPerson,
  createNote,
  getPersonRestSchema,
  TwentyClientError,
  TwentyCredentialError,
  isTwentyDecryptError,
  type AtlasLeadEvent,
  type DbCredentialLookup,
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
 * Fallback workspace_id stamped on operator-pipeline outbox rows when no
 * `organization.is_operator_workspace = true` row exists at boot (#2849).
 * Matches the literal in `0106_crm_outbox_workspace_id.sql` so the
 * migration's backfill produces the same value that the runtime
 * enqueue path uses on the same deploy shape (EU/APAC SaaS regions
 * with the flusher disabled; self-hosted enterprise with no flagged
 * operator org).
 *
 * Sentinel rather than NULL because the column is NOT NULL — and a
 * sentinel routes deterministically (`workspaceId === operatorId`
 * → env creds) rather than triggering a per-tenant DB lookup that
 * would inevitably miss.
 *
 * 16 chars in `<…>` form so it cannot collide with a Better Auth
 * `organization.id` (32-char nanoid). The sentinel never appears in
 * `organization` itself, so a per-tenant dispatch can never resolve
 * a real install against it.
 */
export const ATLAS_OPERATOR_WORKSPACE_SENTINEL = "<atlas-operator>";

/**
 * Resolve the SaaS operator workspace id at boot for stamping on
 * outbox rows enqueued via `upsertLead` / `stampConversion`. Reads the
 * single `organization.is_operator_workspace = true` row (#2702
 * convention; US SaaS region has it backfilled by migration 0090).
 *
 * Three deploy shapes, three outcomes:
 *
 *  1. Flagged row exists → returns its id. Operator-pipeline rows
 *     stamp the real org id and route via env creds.
 *  2. No flagged row (EU/APAC, self-hosted enterprise pre-#2702
 *     backfill, dev without managed auth) → returns the sentinel
 *     {@link ATLAS_OPERATOR_WORKSPACE_SENTINEL}. Sentinel-stamped
 *     rows route via env creds — identical to flagged-row traffic
 *     by design (matches migration 0106's DEFAULT for new rows).
 *  3. SELECT throws — pg transport blip, broken managed-auth schema,
 *     anything other than "table doesn't exist" → THROWS (#2849
 *     codex C2). Fail-loud is correct: if migration 0106 already
 *     stamped existing rows with the real operator id and the
 *     resolver silently fell back to the sentinel, those existing
 *     rows would route through the per-tenant branch
 *     (workspaceId !== sentinel && workspaceId !== resolved-sentinel)
 *     and dead-letter against a missing twenty_integrations lookup.
 *     SaasCrmLive maps a throw here to `available: false` + a per-
 *     tenant-only dispatcher; operator-pipeline rows wait in
 *     `crm_outbox` for a healthy boot rather than burning the retry
 *     budget.
 *
 * "Table doesn't exist" (SQLSTATE 42P01) is the only fully-expected
 * error and degrades to outcome 2 — that's the self-hosted dev shape
 * where Better Auth's `organization` table isn't installed.
 *
 * Exported so tests can assert each of the three branches.
 */
export async function resolveOperatorWorkspaceId(): Promise<string> {
  let rows: { id: string }[];
  try {
    rows = await internalQuery<{ id: string }>(
      `SELECT id FROM organization WHERE is_operator_workspace = true LIMIT 1`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code;
    const looksLikeMissingTable =
      code === "42P01" ||
      message.includes('relation "organization" does not exist');
    if (looksLikeMissingTable) {
      // Non-managed-auth deploy. Sentinel is the correct steady state.
      log.info(
        { event: "saas_crm.operator_workspace_no_managed_auth" },
        "No `organization` table — non-managed-auth deploy; using sentinel for operator workspace_id (outbox rows route through env creds).",
      );
      return ATLAS_OPERATOR_WORKSPACE_SENTINEL;
    }
    log.error(
      {
        err: message,
        code,
        event: "saas_crm.operator_workspace_lookup_failed",
      },
      "Failed to resolve operator workspace_id at boot — refusing to fall back to sentinel. " +
        "Silent-fallback would mask real-org-id rows stamped by migration 0106 (those would route through per-tenant lookup and dead-letter). " +
        "SaasCrm.available will be false until the SELECT succeeds; per-tenant dispatch continues.",
    );
    throw err instanceof Error ? err : new Error(message);
  }
  const id = rows[0]?.id;
  if (typeof id === "string" && id.length > 0) return id;
  // No flagged row — EU/APAC region or self-hosted enterprise without
  // is_operator_workspace=true backfill. Legitimate steady state.
  return ATLAS_OPERATOR_WORKSPACE_SENTINEL;
}

/**
 * Operator-pipeline default when `TWENTY_BASE_URL` is unset. Self-
 * hosters never hit this — the Noop layer is the default, and a
 * direct `@useatlas/twenty` install routes through the plugin's
 * `atlas.config.ts` which requires `baseUrl` explicitly. This
 * constant is the OPERATOR's host and must never be used as a
 * fallback for a per-tenant dispatch (codex C1 — tenant rows with
 * NULL baseUrl dead-letter instead of falling through here).
 */
const ATLAS_SAAS_TWENTY_BASE_URL = "https://crm.useatlas.dev";

/**
 * Per-request timeout for the SaaS CRM client. 5s bounds per-tick
 * blocking on a stuck Twenty without thrashing on transient slow
 * responses.
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
 * Compile-time bridge between the two intentionally-duplicated lead-event
 * unions: `SaasCrmLeadInput` (the `SaasCrm` Tag's `upsertLead` contract, in
 * `@atlas/api`) and `AtlasLeadEvent` (the Twenty normalizer's input, in
 * `@useatlas/twenty`). They are mirrored by hand — see the "Adding a
 * variant" note on `SaasCrmLeadInput` — never merged, because that would
 * drag `@useatlas/twenty` into `@atlas/api`'s public contract surface.
 *
 * This `ee/src/saas-crm/` file is the one place that legitimately depends on
 * both sides (the EE inversion rule), and the `row.payload as SaasCrmLeadInput`
 * → `normalizeLead(...)` cast in `dispatchOutboxRow` below relies on the two
 * unions being interchangeable.
 *
 * `ExactType<A, B>` is the standard exact-equality check (the
 * function-parameter-bivariance idiom): it resolves to `true` only when A and
 * B are structurally *identical* — same variants, same fields, same
 * optionality and `readonly`-ness — and to `false` on any asymmetry. That's
 * stricter than mutual assignability (`[A] extends [B]` both ways), which
 * would silently tolerate, e.g., one side dropping `readonly` or flipping a
 * field optional. "Mirror" means identical, so equality is the right tool.
 *
 * Asserting `= true` (rather than a bare `T extends true` helper) is
 * load-bearing: on drift the check resolves to `false`/`never`, and `never`
 * *is* assignable to a `T extends true` constraint — so a naked helper would
 * fail open. `const _x: ExactType<…> = true` instead forbids the drift result.
 * Add a variant to one union but not the other — or change a field's shape on
 * just one side — and this line goes red in `tsgo` HERE, instead of
 * dead-lettering at flush with `normalizeLead`'s runtime `Unknown lead source`
 * throw.
 */
type ExactType<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false;
const _leadUnionsAreMirrors: ExactType<SaasCrmLeadInput, AtlasLeadEvent> = true;
void _leadUnionsAreMirrors;

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

/**
 * Build the `available: false` no-op shape returned when the SaaS CRM
 * cannot enqueue anything. `dispatcher` is null because there is no
 * outbox to drain (no EE, or no internal DB) — the flusher gate in
 * `layers.ts` skips wiring.
 */
function noopShape(): SaasCrmShape {
  return {
    available: false,
    upsertLead: () => Effect.void,
    stampConversion: () => Effect.void,
    dispatcher: null,
  };
}

/**
 * Build the `available: false` shape returned when the operator
 * pipeline is broken (no creds / probe failed / workspace-id resolve
 * threw) but the outbox is still reachable. Per-tenant rows can
 * dispatch via their own `twenty_integrations` credentials; operator-
 * pipeline rows dead-letter with a permanent message pointing at the
 * boot log that flipped operator state. `upsertLead` /
 * `stampConversion` stay no-ops because enqueuing an operator-pipeline
 * row we know would dead-letter is wasted work.
 *
 * Codex I2 (#2849): pre-this-fix, the flusher mounted only when
 * `available: true`, which starved every customer-workspace row when
 * the operator side broke.
 */
function tenantOnlyShape(reason: string): SaasCrmShape {
  const dispatcher: NonNullable<
    (SaasCrmShape & { available: false })["dispatcher"]
  > = async (row, persist) =>
    dispatchWithResolvedConfig(
      {
        // Sentinel matches no row's workspace_id post-migration-0106
        // (real op id is stamped). The dispatcher routes only
        // sentinel-stamped rows through the "operator pipeline broken"
        // permanent branch via `operatorClientConfig: null`.
        operatorWorkspaceId: ATLAS_OPERATOR_WORKSPACE_SENTINEL,
        operatorClientConfig: null,
        operatorBrokenReason: reason,
      },
      row,
      persist,
    );
  return {
    available: false,
    upsertLead: () => Effect.void,
    stampConversion: () => Effect.void,
    dispatcher,
  };
}

// Boot-time verification runs once inside Layer.effect; available reflects that one check.
export const SaasCrmLive: Layer.Layer<SaasCrm> = Layer.effect(
  SaasCrm,
  Effect.gen(function* () {
    const enterpriseOn = isEnterpriseEnabled();
    if (!enterpriseOn) {
      log.info("Enterprise disabled — SaasCrm.available=false");
      return noopShape();
    }

    if (!hasInternalDB()) {
      log.warn(
        { event: "saas_crm.no_internal_db" },
        "Internal DB unavailable — SaasCrm.available=false. The outbox cannot enqueue without a Postgres backing store.",
      );
      return noopShape();
    }

    // Credential source: env-only for the operator pipeline (#2850).
    // `twenty_integrations` is off-limits here — that table is for
    // per-workspace plugin installs (Admin → Integrations → Twenty),
    // and routing Atlas's lead-capture through it would create the
    // Direction-2 leak documented in #2850. Per-row routing in the
    // dispatcher below reads `twenty_integrations` for per-tenant
    // rows via the separate `resolveWorkspaceCredentials` seam; the
    // grep gate at `scripts/check-twenty-resolver-imports.sh` keeps
    // the two seams from collapsing into one.
    const bootCreds = tryResolveOperatorCredentials();
    if (!bootCreds) {
      log.warn(
        { event: "saas_crm.credentials_absent" },
        "No Twenty operator credentials configured — operator pipeline disabled. Set TWENTY_API_KEY in the environment (this env var is reserved for Atlas's own lead-capture pipeline; per-workspace plugin installs use Admin → Integrations → Twenty). Per-tenant dispatch continues; operator-pipeline rows in crm_outbox dead-letter until creds are configured.",
      );
      return tenantOnlyShape(
        "TWENTY_API_KEY unset at boot — operator-pipeline rows cannot dispatch until env creds are configured",
      );
    }

    // Resolve the operator workspace id BEFORE verifyCustomFields so a
    // pg blip fails the entire operator pipeline (codex C2). The catch
    // arm degrades to the tenant-only shape rather than crashing the
    // Layer (codex I4: Effect.tryPromise, not Effect.promise).
    const operatorWorkspaceIdResult = yield* Effect.tryPromise({
      try: () => resolveOperatorWorkspaceId(),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.map((id) => ({ ok: true as const, id })),
      Effect.catchAll((err) =>
        Effect.succeed({ ok: false as const, err: err.message }),
      ),
    );
    if (!operatorWorkspaceIdResult.ok) {
      return tenantOnlyShape(
        `resolveOperatorWorkspaceId threw at boot: ${operatorWorkspaceIdResult.err}. ` +
          `Operator-pipeline rows cannot route until the SELECT against the organization table succeeds.`,
      );
    }
    const operatorWorkspaceId = operatorWorkspaceIdResult.id;

    const verifyResult = yield* Effect.promise(() => verifyCustomFields(bootCreds));
    if (verifyResult.ok === false) {
      // Already logged inside verifyCustomFields (missing required field,
      // deterministic misconfig, or unreachable probe). Operator pipeline
      // fails closed so /api/v1/contact returns 404 and the marketing
      // site's mailto fallback captures leads. Tenant rows keep flowing.
      return tenantOnlyShape(
        "verifyCustomFields failed at boot — operator Twenty schema missing required fields or probe unreachable; see saas_crm.openapi_* event in boot logs.",
      );
    }

    const optionalFieldStatus = OPTIONAL_PERSON_FIELDS.map((f) => ({
      name: f,
      present: verifyResult.present.has(f),
    }));
    log.info(
      {
        baseUrl: bootCreds.baseUrl ?? ATLAS_SAAS_TWENTY_BASE_URL,
        credentialSource: bootCreds.source,
        operatorWorkspaceId,
        operatorWorkspaceIsSentinel:
          operatorWorkspaceId === ATLAS_OPERATOR_WORKSPACE_SENTINEL,
        optional: optionalFieldStatus,
        event: "saas_crm.ready",
      },
      `SaasCrm wired up — ${REQUIRED_PERSON_FIELDS.join(" + ")} verified on Twenty Person. ` +
        `Optional fields ${OPTIONAL_PERSON_FIELDS.join(", ")} dispatched only when present in the workspace schema.`,
    );

    // Boot-resolved env client config. Used for every operator-pipeline
    // row (workspace_id matches the resolved operator id or the
    // sentinel) — TWENTY_API_KEY / TWENTY_BASE_URL are baked in at
    // process start, and runtime mutation is not supported (admin-UI
    // credential edits flow through the per-workspace plugin install,
    // NOT here — see #2850). `allowedPersonFields` carries the
    // boot-probed schema allowlist so the client strips optional fields
    // (e.g. `atlasIp`) the operator workspace didn't create.
    const operatorClientConfig: TwentyClientConfig = buildSaasClientConfig(
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
              workspaceId: operatorWorkspaceId,
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
              workspaceId: operatorWorkspaceId,
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
      // Per-row dispatcher (#2849). Routes by `row.workspaceId`:
      //   - operator pipeline (workspaceId === operator id or the
      //     sentinel) → boot-resolved env config. No per-row DB
      //     round-trip; the path that drains Atlas's own lead-capture
      //     queue stays as fast as the pre-#2849 single-config form.
      //   - per-tenant (any other workspaceId) → resolve fresh from
      //     `twenty_integrations` via `lookupTwentyDbCredentials`.
      //     A missing or decrypt-failed row dead-letters that row
      //     (permanent — operator must configure the install or
      //     rotate the encryption key before the row can dispatch).
      //
      // No per-tenant credential cache. Per-row resolution costs one
      // SELECT + one AES decrypt; that's measured in microseconds and
      // a stale cached key would silently dispatch to the wrong
      // Twenty after credential rotation. Add an LRU only if the
      // backlog scale ever justifies it (today's volume: < 1 row /
      // second sustained, well under what an uncached resolver
      // tolerates).
      dispatcher: async (row, persist) => {
        return dispatchWithResolvedConfig(
          {
            operatorWorkspaceId,
            operatorClientConfig,
          },
          row,
          persist,
        );
      },
    } satisfies SaasCrmShape;
  }),
);

/**
 * Routing closure handed to the flusher. Extracted to its own function
 * so tests can drive the routing branches without booting the full
 * Layer. The closure captures the operator's resolved id + boot-probed
 * env client config; rows whose `workspaceId` matches the operator
 * (including the sentinel form) dispatch through the env config,
 * everything else resolves per-row from `twenty_integrations`.
 *
 * Error classification:
 *
 *   - `TwentyDecryptError` → permanent (decrypt failure means
 *     `ATLAS_ENCRYPTION_KEYS` is misconfigured; operator must rotate
 *     or re-save the row).
 *   - `TwentyCredentialError` WITH no `cause` → permanent (genuine
 *     missing-row; operator must install Twenty in this workspace).
 *   - `TwentyCredentialError` WITH a `cause` → transient (the
 *     resolver swallowed a transport error and re-threw as
 *     missing-credentials; codex I1 — without this branch a pg blip
 *     during lookup would burn the retry budget in a single tick).
 *   - Anything else thrown → transient (network blip on the SELECT,
 *     malformed pg response).
 *
 * `operatorClientConfig: null` means the operator probe / env-creds /
 * workspace-id resolve failed at boot (codex I2 — `tenantOnlyShape`
 * above). Per-tenant rows route normally; operator-pipeline rows (the
 * comparison below) dead-letter as permanent so the platform-crm-
 * outbox UI surfaces them for triage rather than letting them retry
 * forever against a broken pipeline.
 *
 * @internal Exported for direct unit testing in `saas-crm.test.ts`.
 */
export interface DispatchRoutingDeps {
  readonly operatorWorkspaceId: string;
  /**
   * Boot-resolved env config for operator-pipeline rows. `null` only
   * when the SaasCrm Layer booted into the tenant-only shape — no
   * operator creds, broken probe, or workspace-id resolve threw.
   * Operator-pipeline rows then dead-letter as permanent.
   */
  readonly operatorClientConfig: TwentyClientConfig | null;
  /**
   * Human-readable reason the operator pipeline is broken. Only read
   * when `operatorClientConfig === null` to compose the permanent
   * dead-letter message.
   */
  readonly operatorBrokenReason?: string;
  /**
   * Per-tenant credential lookup. Defaults to the production adapter
   * (`lookupTwentyDbCredentials`); tests inject a stub. Named
   * `DbCredentialLookup` rather than `typeof` so the signature is
   * stable when the adapter gains parameters.
   */
  readonly lookup?: DbCredentialLookup;
}

export async function dispatchWithResolvedConfig(
  deps: DispatchRoutingDeps,
  row: ClaimedOutboxRow,
  persist: OutboxPersistHelpers,
): Promise<DispatchOutcome> {
  const lookup = deps.lookup ?? lookupTwentyDbCredentials;

  // Operator pipeline: stamp matches the resolved operator id OR the
  // sentinel (an EU/APAC region / self-hosted enterprise with no
  // `is_operator_workspace=true` row backfilled). Both route through
  // the env config — migration 0106 backfilled existing rows to either
  // form via DEFAULT '<atlas-operator>' + an optional UPDATE to the
  // real org id when one exists; new enqueues stamp whatever
  // `resolveOperatorWorkspaceId` returned at boot.
  if (
    row.workspaceId === deps.operatorWorkspaceId ||
    row.workspaceId === ATLAS_OPERATOR_WORKSPACE_SENTINEL
  ) {
    if (deps.operatorClientConfig === null) {
      return {
        kind: "permanent",
        message:
          `Operator-pipeline row (workspace=${row.workspaceId}) cannot dispatch — ` +
          `operator pipeline disabled at boot: ${deps.operatorBrokenReason ?? "(reason unset)"}. ` +
          `Fix the boot failure (TWENTY_API_KEY env / Twenty probe / operator workspace SELECT) and the next dispatch attempt will succeed.`,
      };
    }
    return dispatchOutboxRow(deps.operatorClientConfig, row, persist);
  }

  // Per-tenant pipeline. Resolve fresh — a rotated key on the workspace
  // row mid-batch must not dispatch under the old key, and a deleted
  // row must dead-letter rather than fall back to the operator's env
  // (the Direction-1 leak in #2850).
  let creds: ResolvedTwentyCredentials;
  try {
    creds = await resolveWorkspaceCredentials(row.workspaceId, {
      deployMode: "saas",
      lookup,
    });
  } catch (err) {
    if (isTwentyDecryptError(err)) {
      return {
        kind: "permanent",
        message:
          `resolveWorkspaceCredentials decrypt-failed for workspace=${row.workspaceId}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Rotate ATLAS_ENCRYPTION_KEYS or re-save the integration row before this lead can dispatch.`,
      };
    }
    if (err instanceof TwentyCredentialError) {
      // The resolver wraps lookup transport errors in TwentyCredentialError
      // with the original carried as `cause` (plugins/twenty/src/credential-
      // resolver.ts:355-387). Distinguish: cause-present → transient
      // (transport blip; next tick may succeed); cause-absent → permanent
      // (genuinely missing twenty_integrations row).
      //
      // Codex I1 (#2849): pre-this-fix, both shapes landed in permanent.
      // A single pg blip would dead-letter a per-tenant row on its first
      // attempt instead of cycling through the retry budget.
      const cause = (err as { cause?: unknown }).cause;
      if (cause !== undefined) {
        return {
          kind: "transient",
          message:
            `resolveWorkspaceCredentials transport-blip for workspace=${row.workspaceId}: ` +
            `${cause instanceof Error ? cause.message : String(cause)}. ` +
            `Retrying on next tick.`,
        };
      }
      return {
        kind: "permanent",
        message:
          `resolveWorkspaceCredentials missing for workspace=${row.workspaceId}: ` +
          `${err.message}`,
      };
    }
    // Lookup threw something other than the typed errors above (malformed
    // pg response, our own bug). Treat as transient — a flaky pool
    // shouldn't burn the retry budget.
    return {
      kind: "transient",
      message:
        `resolveWorkspaceCredentials threw for workspace=${row.workspaceId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Per-tenant rows must NEVER fall back to the operator's host
  // (codex C1 #2849). A NULL `base_url` in twenty_integrations
  // means the install row is misconfigured — `creds.baseUrl ??
  // ATLAS_SAAS_TWENTY_BASE_URL` would route the tenant's apiKey
  // against crm.useatlas.dev (auth fails, but the attempt lands
  // in Atlas's CRM access logs with a foreign key — Direction-2
  // leak vector). Dead-letter with an actionable message so the
  // operator re-saves the install.
  if (!creds.baseUrl) {
    return {
      kind: "permanent",
      message:
        `Twenty integration for workspace=${row.workspaceId} has no baseUrl configured. ` +
        `Re-save the install with a valid URL under Admin → Integrations → Twenty. ` +
        `Per-tenant dispatch never falls back to the operator host (${ATLAS_SAAS_TWENTY_BASE_URL}) — ` +
        `that would route customer leads to Atlas's CRM.`,
    };
  }

  // Per-tenant `allowedPersonFields` is `undefined` — the boot probe
  // only covered the operator workspace's Twenty schema. The client's
  // own request-time error surfaces a 422/400 if a customer's Twenty
  // is missing one of the Atlas custom fields (Person-level), which
  // dead-letters that row via `classifyTwentyError`. Out of scope for
  // this slice: a per-tenant boot probe + cached allowlist (would let
  // optional fields like atlasIp be silently dropped instead of 400'd).
  // Tracked in the architecture-wins doc for a future deepening.
  const tenantClientConfig: TwentyClientConfig = {
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl,
    timeoutMs: SAAS_TIMEOUT_MS,
  };
  return dispatchOutboxRow(tenantClientConfig, row, persist);
}

// Re-exported for direct testing of the verification / dispatch logic.
export {
  verifyCustomFields,
  buildSaasClientConfig,
  ATLAS_SAAS_TWENTY_BASE_URL,
  classifyTwentyError,
  STAMP_CONVERSION_EVENT_TYPE,
  REQUIRED_PERSON_FIELDS,
};

// `ATLAS_OPERATOR_WORKSPACE_SENTINEL`, `resolveOperatorWorkspaceId`,
// and `dispatchWithResolvedConfig` are exported inline at their
// definitions above for the per-row routing tests in #2849.
