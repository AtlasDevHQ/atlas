/**
 * `breaking-change` — the PURE breaking-vs-additive policy + signal layer over the
 * structured spec-drift diff (PRD #2868, v0.0.3 — Spec Lifecycle, #2979).
 *
 * `diff.ts` answers "WHAT moved between two probes" and deliberately stays neutral
 * on whether a move matters (its header: breaking-vs-additive classification "is
 * #2979's job"). THIS module answers "does it matter to the agent, and should a
 * customer be told before their calls start failing." It is the seam between the
 * raw changeset and the admin-visible signal:
 *
 *   1. {@link classifyBreakingChanges} — a pure function over an
 *      {@link OperationGraphDiff} → a {@link BreakingAssessment}.
 *   2. {@link resolveDriftAlertWrite} — the pure raise/clear/leave decision both the
 *      manual route and the Tier-2 scheduler thread through `persistRediscoverySnapshot`,
 *      so the two stay in lockstep without `lib/` importing `api/routes/`.
 *   3. {@link projectDriftAlert} — the fail-soft JSONB read-back projection (mirrors
 *      `summarizeSpecDiffRecord`) that the admin list/detail endpoint surfaces.
 *
 * Like `diff.ts`, this module is PURE and SIDE-EFFECT-FREE: no clock, no I/O. The
 * caller supplies `raisedAt` and persists the result.
 *
 * ## Classification policy (each bullet justified)
 *
 * BREAKING — something the agent relied on is gone, moved, or retyped under it:
 *   - **Removed operation** → the agent's calls vanish.
 *   - **Operation `method` / `path` change** → routing moved under a stable
 *     `operationId`; a call the agent composed now hits the wrong verb/route.
 *   - **Operation `security` change** → the auth requirements changed; a call that
 *     satisfied the old requirement may now 401 (or, looser, expose a surface that
 *     used to be gated). Either direction is a contract change the agent built on.
 *   - **`sideEffecting` false → true** → a read became a write. The validator now
 *     forces it through the write-allowlist + confirm path; a workflow that read
 *     freely now mutates. (De-escalation true → false is NOT flagged — it only
 *     loosens, and the parser forbids it anyway: a write method stays a write.)
 *   - **Removed / retyped field** (param, request body, response, or named-schema
 *     field) → a field the agent read/sent is gone, or its type/`$ref`/`required`
 *     changed under it.
 *   - **Added REQUIRED field on a REQUEST surface** (`param:*` / `requestBody:*`) →
 *     calls the agent already composes omit it and now fail.
 *   - **Removed named schema** → a shape the agent's representation referenced is gone.
 *
 * ADDITIVE (quiet) — the agent's existing contract still holds:
 *   - **Added operation / added named schema** → new capability, nothing broke.
 *   - **Added OPTIONAL request field, or ANY added RESPONSE field** → the agent can
 *     read more or send more, but every existing call still type-checks.
 *   - **Added field on a NAMED SCHEMA** → a named component is reachable from BOTH
 *     request and response surfaces, and the diff's bare schema-field path carries
 *     no surface prefix to tell which. Rather than guess "request" and nag on a
 *     benign response-shape growth, an *added* schema field is treated as additive.
 *     (Removed / retyped schema fields are still breaking — those break a read no
 *     matter the surface.)
 *
 * ## `MAX_FIELD_DEPTH` caveat (inherited from `diff.ts`)
 * The diff's field walk is bounded by `MAX_FIELD_DEPTH`; two specs differing ONLY
 * below that depth read as `unchanged`. The bound is symmetric (never invents
 * drift), but `unchanged` therefore means "no change down to depth N", NOT a proof
 * of no breaking change. A breaking retype buried deeper than `MAX_FIELD_DEPTH`
 * would not surface here — accept this as the same coverage `diff.ts` already
 * documents, not a new gap this module introduces.
 */
import type {
  AttributeChange,
  DiffCounts,
  FieldChange,
  OperationGraphDiff,
  SpecDiffRecord,
} from "./diff";

// ─────────────────────────────────────────────────────────────────────
//  Assessment output shape
// ─────────────────────────────────────────────────────────────────────

/** Why a change is breaking — a small, legible descriptor the audit + UI render. */
export type BreakingReasonKind =
  | "operation_removed"
  | "operation_attribute_changed"
  | "field_removed"
  | "field_retyped"
  | "field_required_added"
  | "schema_removed";

/** Every {@link BreakingReasonKind}, as a Set for fail-soft read-back validation. */
const BREAKING_REASON_KINDS: ReadonlySet<string> = new Set<BreakingReasonKind>([
  "operation_removed",
  "operation_attribute_changed",
  "field_removed",
  "field_retyped",
  "field_required_added",
  "schema_removed",
]);

/**
 * One breaking change, located + explained. `operationId` is set for an operation-
 * scoped reason, `schema` for a named-component-scoped one; `path` carries the
 * dotted field location (the same grammar `diff.ts` emits) when the reason is a
 * field. `detail` is a human-readable one-liner the admin pill / audit row renders.
 */
export interface BreakingReason {
  readonly kind: BreakingReasonKind;
  readonly operationId?: string;
  readonly schema?: string;
  readonly path?: string;
  readonly detail: string;
}

/** The verdict over a whole changeset: is anything breaking, and (if so) what. */
export interface BreakingAssessment {
  readonly breaking: boolean;
  readonly reasons: ReadonlyArray<BreakingReason>;
}

/** A not-breaking verdict — the shape returned for a baseline (no comparison ran). */
const EMPTY_ASSESSMENT: BreakingAssessment = { breaking: false, reasons: [] };

const ZERO_COUNTS: DiffCounts = {
  operationsAdded: 0,
  operationsRemoved: 0,
  operationsChanged: 0,
  schemasAdded: 0,
  schemasRemoved: 0,
  schemasChanged: 0,
  fieldsAdded: 0,
  fieldsRemoved: 0,
  fieldsRetyped: 0,
};

// ─────────────────────────────────────────────────────────────────────
//  Internals — per-change classification
// ─────────────────────────────────────────────────────────────────────

/**
 * A field path the agent SENDS on a request (a query/header/path/cookie param, or
 * a request-body field). An added-required field here breaks calls that omit it.
 * A response-body path (`response:*`) or a bare named-schema path is NOT a request
 * surface — see the module header for why an added schema field stays quiet.
 */
function isRequestSurfacePath(path: string): boolean {
  return path.startsWith("param:") || path.startsWith("requestBody:");
}

/** Whether an operation-attribute change is contract-breaking (see module header). */
function isBreakingAttribute(attr: AttributeChange): boolean {
  switch (attr.name) {
    case "method":
    case "path":
    case "security":
      return true;
    case "sideEffecting":
      // Only escalation (read → write) is breaking; de-escalation merely loosens.
      return attr.before === "false" && attr.after === "true";
  }
}

/** Human one-liner for a breaking attribute change. */
function describeAttribute(operationId: string, attr: AttributeChange): string {
  switch (attr.name) {
    case "method":
      return `Operation "${operationId}" moved from ${attr.before} to ${attr.after}`;
    case "path":
      return `Operation "${operationId}" path changed from ${attr.before} to ${attr.after}`;
    case "security":
      return `Operation "${operationId}" auth requirements changed (${attr.before || "none"} → ${attr.after || "none"})`;
    case "sideEffecting":
      return `Operation "${operationId}" became side-effecting (a read became a write)`;
  }
}

/**
 * Classify a single {@link FieldChange} within an operation (`ctx.operationId`) or a
 * named schema (`ctx.schema`). Returns a {@link BreakingReason} when breaking, or
 * `null` when additive (added-optional / added-response / added-schema field).
 */
function classifyField(
  fc: FieldChange,
  ctx: { operationId?: string; schema?: string },
): BreakingReason | null {
  const locate = { ...ctx, path: fc.path };
  const where = ctx.operationId ? `operation "${ctx.operationId}"` : `schema "${ctx.schema}"`;
  switch (fc.kind) {
    case "removed":
      return { kind: "field_removed", ...locate, detail: `Field "${fc.path}" was removed from ${where}` };
    case "retyped":
      return { kind: "field_retyped", ...locate, detail: `Field "${fc.path}" was retyped on ${where}` };
    case "added":
      if (fc.after.required === true && isRequestSurfacePath(fc.path)) {
        return {
          kind: "field_required_added",
          ...locate,
          detail: `Required request field "${fc.path}" was added to ${where}`,
        };
      }
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Public entry point — classification
// ─────────────────────────────────────────────────────────────────────

/**
 * Classify a structured spec-drift {@link OperationGraphDiff} as breaking vs
 * additive. Pure: no clock, no I/O. Returns every breaking reason found (the order
 * mirrors the diff's own stable ordering — removed ops, then changed ops, then
 * removed schemas, then changed schemas), so the output is deterministic for the
 * same diff. An empty `reasons` list ⇒ `breaking: false` (additive-only or
 * unchanged).
 */
export function classifyBreakingChanges(diff: OperationGraphDiff): BreakingAssessment {
  const reasons: BreakingReason[] = [];

  // Removed operations — the agent's calls vanish.
  for (const op of diff.operations.removed) {
    reasons.push({
      kind: "operation_removed",
      operationId: op.operationId,
      detail: `Operation "${op.operationId}" (${op.method} ${op.path}) was removed`,
    });
  }

  // Changed operations — routing/safety attributes + per-field deltas.
  for (const change of diff.operations.changed) {
    for (const attr of change.attributes) {
      if (isBreakingAttribute(attr)) {
        reasons.push({
          kind: "operation_attribute_changed",
          operationId: change.operationId,
          detail: describeAttribute(change.operationId, attr),
        });
      }
    }
    for (const fc of change.fields) {
      const reason = classifyField(fc, { operationId: change.operationId });
      if (reason) reasons.push(reason);
    }
  }

  // Removed named schemas — a referenced shape is gone.
  for (const name of diff.schemas.removed) {
    reasons.push({ kind: "schema_removed", schema: name, detail: `Schema "${name}" was removed` });
  }

  // Changed named schemas — field-level deltas (added/removed components handled above).
  for (const change of diff.schemas.changed) {
    for (const fc of change.fields) {
      const reason = classifyField(fc, { schema: change.name });
      if (reason) reasons.push(reason);
    }
  }

  return { breaking: reasons.length > 0, reasons };
}

// ─────────────────────────────────────────────────────────────────────
//  Persisted alert record (stored on the install) + lifecycle decision
// ─────────────────────────────────────────────────────────────────────

/**
 * JSONB field name for the persisted breaking-change signal on
 * `workspace_plugins.config`. NON-SECRET, selective-field (same pattern as
 * `openapi_last_diff` / `spec_refresh_interval`), so it needs no migration and is
 * never round-tripped through the credential encrypt path. The single source of
 * truth for the field name; `rediscover.ts` (the write) and the admin route (the
 * acknowledge SQL + projection) splice this constant, never a literal.
 */
export const OPENAPI_DRIFT_ALERT_FIELD = "openapi_drift_alert" as const;

/**
 * Cap on the breaking reasons embedded in a persisted alert (and the audit row).
 * A spec that renames everything could produce hundreds of reasons; `breakingCount`
 * still records the true total, so the UI can say "+N more" without unbounded JSONB.
 */
export const MAX_STORED_DRIFT_REASONS = 20;

/**
 * Per-string cap applied when projecting reason fields read back from JSONB. The
 * writer's reasons are short one-liners, but a hand-edited / drifted row could
 * carry a megabyte string; truncating at read keeps a malformed row from inflating
 * the admin response. Generous enough never to clip a real `detail`.
 */
const MAX_DRIFT_REASON_FIELD_CHARS = 500;

/**
 * The persisted breaking-change signal stored at
 * `workspace_plugins.config.openapi_drift_alert` when a SCHEDULED re-discovery
 * detects breaking drift (#2979). Distinct from `openapi_last_diff` (the full,
 * always-overwritten structured diff): this record is RAISED only on breaking
 * scheduled drift, persists across refreshes until acknowledged or cleared by a
 * clean refresh, and drives the admin attention pill.
 */
export interface SpecDriftAlertRecord {
  /** ISO-8601 instant the signal was raised. */
  readonly raisedAt: string;
  /** ISO-8601 `probedAt` of the prior snapshot the breaking diff was computed against. */
  readonly previousProbedAt: string | null;
  /** ISO-8601 `probedAt` of the re-probe that surfaced the breaking drift. */
  readonly currentProbedAt: string;
  /** Total breaking reasons found (may exceed `reasons.length` when capped). */
  readonly breakingCount: number;
  /** A capped sample of breaking reasons (≤ {@link MAX_STORED_DRIFT_REASONS}). */
  readonly reasons: ReadonlyArray<BreakingReason>;
  /** The diff roll-up counts at raise time, for context in the UI/audit. */
  readonly counts: DiffCounts;
  /** ISO-8601 instant an admin acknowledged the signal; `null` while unacknowledged. */
  readonly acknowledgedAt: string | null;
}

/**
 * Build a fresh (unacknowledged) {@link SpecDriftAlertRecord} from a breaking
 * assessment. Only ever called on `assessment.breaking === true`, which can only
 * arise from a computed (non-null) diff — so `diffRecord.diff` is present; the
 * `?? ZERO_COUNTS` is a defensive fallback, never hit on the live path.
 */
export function buildDriftAlertRecord(
  diffRecord: SpecDiffRecord,
  assessment: BreakingAssessment,
  raisedAt: string,
): SpecDriftAlertRecord {
  return {
    raisedAt,
    previousProbedAt: diffRecord.previousProbedAt,
    currentProbedAt: diffRecord.currentProbedAt,
    breakingCount: assessment.reasons.length,
    reasons: assessment.reasons.slice(0, MAX_STORED_DRIFT_REASONS),
    counts: diffRecord.diff?.counts ?? ZERO_COUNTS,
    acknowledgedAt: null,
  };
}

/** Which trigger drove the re-discovery — only `scheduled` raises a persisted pill (AC2). */
export type RediscoveryTrigger = "manual" | "scheduled";

/**
 * The write the persistence layer should apply to the `openapi_drift_alert` field:
 *   - `raise`  — set it to a fresh {@link SpecDriftAlertRecord}.
 *   - `clear`  — set it to JSON `null` (the "all good now" signal).
 *   - `leave`  — don't touch the field (preserve whatever's there).
 */
export type DriftAlertWrite =
  | { readonly op: "raise"; readonly record: SpecDriftAlertRecord }
  | { readonly op: "clear" }
  | { readonly op: "leave" };

/** The classification + the resulting persisted-signal write, resolved together. */
export interface DriftSignalResolution {
  readonly assessment: BreakingAssessment;
  readonly write: DriftAlertWrite;
}

/**
 * The single, trigger-aware lifecycle decision shared by the manual route and the
 * Tier-2 scheduler (AC3). Pure — both consumers call it so raise/clear/leave stay
 * in lockstep:
 *
 *   - BASELINE (`diff === null` — first-ever discovery OR an unparseable prior):
 *     no comparison ran, so `leave`. "Clear on a clean refresh" requires a real,
 *     clean comparison; an absent/dropped one is neither clean nor breaking, and
 *     must not silently dismiss a standing alert (real drift may have gone unseen).
 *   - BREAKING + `scheduled`: `raise` — the unattended path is the one that must
 *     warn the customer before calls fail.
 *   - BREAKING + `manual`: `leave` — "Refresh now" shows the inline diff (the admin
 *     is already looking), so it doesn't raise a redundant persisted pill.
 *   - CLEAN (unchanged or additive-only), manual OR scheduled: `clear` — a clean
 *     re-discovery is the "all good now" signal that dismisses any standing alert.
 */
export function resolveDriftAlertWrite(
  diffRecord: SpecDiffRecord,
  trigger: RediscoveryTrigger,
  raisedAt: string,
): DriftSignalResolution {
  const diff = diffRecord.diff;
  if (diff === null) {
    return { assessment: EMPTY_ASSESSMENT, write: { op: "leave" } };
  }
  const assessment = classifyBreakingChanges(diff);
  if (assessment.breaking) {
    return trigger === "scheduled"
      ? { assessment, write: { op: "raise", record: buildDriftAlertRecord(diffRecord, assessment, raisedAt) } }
      : { assessment, write: { op: "leave" } };
  }
  return { assessment, write: { op: "clear" } };
}

// ─────────────────────────────────────────────────────────────────────
//  Fail-soft projection (JSONB read-back → UI/wire shape)
// ─────────────────────────────────────────────────────────────────────

/**
 * The projected, fail-soft view of a persisted {@link SpecDriftAlertRecord} the
 * admin list/detail endpoint surfaces. Same shape as the record — the projection's
 * job is sanitizing an untyped JSONB read-back, not reshaping it.
 */
export interface SpecDriftAlertSummary {
  readonly raisedAt: string;
  readonly previousProbedAt: string | null;
  readonly currentProbedAt: string;
  readonly breakingCount: number;
  readonly reasons: ReadonlyArray<BreakingReason>;
  readonly counts: DiffCounts;
  readonly acknowledgedAt: string | null;
}

/**
 * Clamp a JSONB-read tally to a NON-NEGATIVE INTEGER. A count is a cardinality, so
 * a negative or fractional value from a malformed/edited row is nonsense; coerce it
 * to the nearest sane integer rather than letting it surface in the admin response.
 */
function clampCount(v: number): number {
  return Math.max(0, Math.trunc(v));
}

/** Truncate a JSONB-read reason field to {@link MAX_DRIFT_REASON_FIELD_CHARS}. */
function clampField(s: string): string {
  return s.length > MAX_DRIFT_REASON_FIELD_CHARS ? s.slice(0, MAX_DRIFT_REASON_FIELD_CHARS) : s;
}

/** Validate + coerce the 9 numeric tallies, or {@link ZERO_COUNTS} when missing/wrong-typed. */
function coerceCounts(raw: unknown): DiffCounts {
  if (typeof raw !== "object" || raw === null) return ZERO_COUNTS;
  const r = raw as Record<string, unknown>;
  const out: Record<keyof DiffCounts, number> = { ...ZERO_COUNTS };
  for (const key of Object.keys(ZERO_COUNTS) as Array<keyof DiffCounts>) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = clampCount(v);
  }
  return out;
}

/**
 * Drop malformed entries; keep well-formed {@link BreakingReason}s with a known kind.
 * Caps the result at {@link MAX_STORED_DRIFT_REASONS} (the same bound the writer
 * applies) and truncates each string field, so a bloated/edited row can't inflate
 * the projected payload past the writer's own ceiling.
 */
function coerceReasons(raw: unknown): BreakingReason[] {
  if (!Array.isArray(raw)) return [];
  const out: BreakingReason[] = [];
  for (const item of raw) {
    if (out.length >= MAX_STORED_DRIFT_REASONS) break;
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.kind !== "string" || !BREAKING_REASON_KINDS.has(r.kind)) continue;
    if (typeof r.detail !== "string") continue;
    out.push({
      kind: r.kind as BreakingReasonKind,
      detail: clampField(r.detail),
      ...(typeof r.operationId === "string" ? { operationId: clampField(r.operationId) } : {}),
      ...(typeof r.schema === "string" ? { schema: clampField(r.schema) } : {}),
      ...(typeof r.path === "string" ? { path: clampField(r.path) } : {}),
    });
  }
  return out;
}

/**
 * Fail-soft projection of a `config.openapi_drift_alert` JSONB value into a
 * {@link SpecDriftAlertSummary}, or `null` when there's no (valid) alert. Mirrors
 * `summarizeSpecDiffRecord`: the value is untyped at the trust boundary (an older
 * writer, a JSON `null` clear, or a hand-edited row), so a record missing its
 * load-bearing `raisedAt` / `currentProbedAt` coerces to `null` (no pill) rather
 * than rendering `undefined`. Secondary fields (`counts`, `reasons`,
 * `breakingCount`) degrade to safe defaults instead of nulling the whole signal —
 * a breaking alert with malformed counts is still worth showing.
 */
export function projectDriftAlert(raw: unknown): SpecDriftAlertSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.raisedAt !== "string" || typeof r.currentProbedAt !== "string") return null;
  const reasons = coerceReasons(r.reasons);
  const breakingCount =
    typeof r.breakingCount === "number" && Number.isFinite(r.breakingCount)
      ? clampCount(r.breakingCount)
      : reasons.length;
  return {
    raisedAt: r.raisedAt,
    previousProbedAt: typeof r.previousProbedAt === "string" ? r.previousProbedAt : null,
    currentProbedAt: r.currentProbedAt,
    breakingCount,
    reasons,
    counts: coerceCounts(r.counts),
    acknowledgedAt: typeof r.acknowledgedAt === "string" ? r.acknowledgedAt : null,
  };
}
