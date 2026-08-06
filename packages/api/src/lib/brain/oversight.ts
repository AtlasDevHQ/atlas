/**
 * Admin oversight for the fact class — counts without content (#4825,
 * ADR-0036 §Access control & residency), plus the one reader-scoped content
 * disclosure that rides beside them: the will-supersede pairs (#4912).
 *
 * ## The asymmetry this exists to disclose
 *
 * Publish is WORKSPACE-scoped (`promoteBrainFacts` takes an `orgId` and no
 * reader) and the review queue is READER-scoped (`loadFactCandidates` composes
 * `aclVisibilityClause`). Both are correct, and the pairing is deliberate — see
 * `docs/development/brain-slack-history.md` § Publish scope for the decision and
 * the alternative that was rejected. What is NOT correct is the situation that
 * falls out of it: an admin outside a private channel's audience sees a clean
 * queue, presses publish, and promotes claims nobody could review. Every number
 * on the way was individually right; together they were inexplicable.
 *
 * This module makes the gap legible without widening what anyone may read.
 *
 * ## The rule this module enforces, stated once
 *
 *   **An admin learns that facts exist they cannot see — a number, never
 *   content.**
 *
 * Mechanically that means: no UNSCOPED query here selects `subject`,
 * `predicate`, `object`, `provenance`, `source_episode_id`, or anything off
 * `brain_episodes`. TWO statements in this module select claim content —
 * `willSupersedePairsSql` (#4912) and `willWidenRowsSql` (#5032) — and both are
 * READER-SCOPED, so each can only show a reader claims their own ACL already
 * entitles them to read; see their headers for why that does not breach this
 * rule.
 *
 * ⚠️ `willWidenRowsSql` is the only one that touches `brain_episodes` at all,
 * and it is why that disclosure has NO unscoped `withheld` counterpart: the
 * count would have to run the grant grammar over episode grants for facts the
 * reader cannot see, which this rule forbids. Its header records the gap rather
 * than working around it.
 *
 * From the UNSCOPED aggregates, TWO non-numeric values reach the wire, and an
 * auditor must check both: `label`, only when {@link classifyToken} rules the
 * token disclosable; and `key`, which is that same token on the disclosable
 * arms and a positional handle (`discovered-N`) on the withheld one.
 * Everything else there is a number or a closed enum. `oversight.test.ts` pins
 * both, because a `z.strictObject` on the wire schema can reject an unexpected
 * KEY but cannot tell a channel id from a sentence. The third and fourth places
 * an auditor must now look are `loadSupersessionPreview`'s pairs (#4912) and
 * `loadWideningPreview`'s entries (#5032) — fact ids, SPO labels and, on the
 * latter, GRANT TOKENS. All sanctioned because they are READER-scoped, not
 * workspace-wide; see their headers. The tokens are the same list the
 * post-publish `PromotionReport.widened` already reports to the same admin one
 * moment later, which is why they are not held to `classifyToken`'s
 * disclosable/withheld policy — that policy governs the UNSCOPED aggregate,
 * where the reader has no entitlement to the row at all.
 *
 * ## Why the aggregate is deliberately NOT ACL-scoped
 *
 * Composing `aclVisibilityClause` here would be the obvious-looking move and
 * would destroy the surface: the reader's own subset is what
 * `/api/v1/admin/brain-facts/summary` already reports, and a view that agreed with it
 * would say "your queue is your workspace" — which is exactly the false
 * all-clear an admin currently gets.
 *
 * Be precise about the authority for that, because the tempting shorthand is
 * wrong. ADR-0036 admits exactly ONE bypass: a reason-gated, owner/admin-only,
 * logged audit override over CONTENT, implemented in `aclVisibilityClause` and
 * region-scoped. This is not that, and deliberately does not use it — there is
 * no `AclAuditOverride` here, no reason, no audit row. It is a narrower thing
 * decided in #4825: an unscoped COUNT carrying no content and no override
 * machinery. The decision lives in `docs/development/brain-slack-history.md`
 * § Publish scope, not in the ADR; do not read this module as standing licence
 * for unscoped reads.
 *
 * It is safe because a count cannot be read back into a claim:
 * `role:platform_admin` stays refused by the grant grammar, and a platform role
 * still confers no brain grant.
 *
 * `reviewableAwaitingReview` is the one scoped number, carried here rather than
 * fetched separately so both halves of the disclosure come from one REQUEST —
 * see {@link loadFactOversight} on why that is not the same as one snapshot.
 */

import { createHash } from "node:crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import {
  aclVisibilityClause,
  isUnknownArray,
  parsePrincipal,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
// The widening notice runs the transaction's OWN decision function (#5032), so
// the disclosure and the act cannot disagree about what widens. Never
// reimplement it as a SQL predicate here — the grant grammar has one home.
import {
  widenGrantFromEvidence,
  type StoredGrant,
} from "@atlas/api/lib/brain/promotion";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import {
  PROVISIONAL_PREDICATE,
  TENSION_EXISTS_SELECT,
  type BrainCandidateReader,
} from "@atlas/api/lib/brain/candidates";
import { parseChatChannelAudienceId } from "@atlas/api/lib/brain/ingest/grant";
import {
  brainFactCurrentClause,
  supersedingDraftPredicate,
  supersessionCollisionJoin,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import {
  SLACK_HISTORY_CATALOG_ID,
  SLACK_HISTORY_SOURCE,
  parseSlackHistoryConfig,
} from "@atlas/api/lib/brain/ingest/slack/config";
import type {
  BrainFactOversight,
  BrainFactOversightBucket,
  BrainFactOversightBucketKind,
  BrainFactOversightLabelPolicy,
  BrainFactOversightTotals,
  BrainFactWillSupersede,
  BrainFactWillSupersedePair,
  BrainFactWillWiden,
  BrainFactWillWidenEntry,
} from "@useatlas/types";

const log = createLogger("brain-oversight");

/** Surface tag on this module's `BrainReaderUnresolvedError` throws. */
const OVERSIGHT_SURFACE = "oversight";

/** Tenant + correlation context carried on this module's degradation logs. */
interface CountMeta {
  readonly workspaceId: string;
  readonly requestId?: string;
}

/**
 * Most buckets one response carries.
 *
 * A bound, not a policy. Grant tokens are one per audience in practice — a
 * Slack install is capped at 50 channels — but `user:` grants are per person
 * and a region-import bundle can carry arbitrary junk, so the token cardinality
 * has no ceiling at rest. Overrun is REPORTED (`bucketsTruncated`), never
 * silent: a clipped breakdown reads as a complete account of where the
 * workspace's facts sit, which is the one thing this surface must not imply.
 * The workspace totals are computed per fact rather than per bucket, so the
 * top-line disclosure stays exact even when the breakdown is clipped.
 */
export const OVERSIGHT_BUCKET_MAX = 200;

// ---------------------------------------------------------------------------
// Label policy — which audiences may be named
// ---------------------------------------------------------------------------

/**
 * The workspace's admin-configured channel ids, per source.
 *
 * Built from the install config, which is the RECORD OF WHAT THE ADMIN TYPED.
 * That is the whole justification for naming a channel in this view: the
 * existence and activity level of `#project-severance` is sensitive even with
 * no content attached, but an admin who entered `C0…` into the install form
 * learns nothing from seeing it back — `workspace_plugins.config` is already
 * admin-readable.
 */
export type ConfiguredChannels = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Every Slack chat-history install's stored config, regardless of enabled or
 * archived state.
 *
 * DELIBERATELY WIDER than `AUDIENCE_SYNC_INSTALLS_SQL` ON THE ENABLED/ARCHIVED
 * AXIS: that statement filters `enabled = true AND status <> 'archived'`
 * because it answers a different question — "which installs should be syncing
 * right now". This one answers "which channels has an admin of this workspace
 * ever named", and disabling a source does not un-name them. Reusing the sync
 * predicate would make a label silently flip to opaque the moment somebody
 * toggled the install off, which reads as Atlas hiding something at exactly the
 * wrong moment.
 *
 * It also drops that statement's `pillar = 'knowledge'`, which is not a
 * widening in practice: `catalog_id` already pins a single catalog row, and
 * `pillar` is denormalized FROM that row, so the predicate is implied.
 */
export const OVERSIGHT_INSTALL_CONFIGS_SQL = `SELECT config
         FROM workspace_plugins
        WHERE workspace_id = $1 AND catalog_id = $2`;

/**
 * Load the configured channel set for one workspace.
 *
 * Degrades to "nothing is configured" on a read fault, and that is the
 * FAIL-CLOSED direction here: with no configured set, every audience is
 * `discovered` and every label is withheld. So a database problem costs the
 * admin some legibility and can never cost them confidentiality. It is logged
 * rather than thrown for the same reason — the counts are the load-bearing half
 * of this surface and must still be served.
 */
export async function loadConfiguredChannels(
  db: BrainCandidateReader,
  workspaceId: string,
  requestId?: string,
): Promise<ConfiguredChannels> {
  const bySource = new Map<string, Set<string>>();
  let rows: readonly unknown[];
  try {
    const result = await db.query(OVERSIGHT_INSTALL_CONFIGS_SQL, [
      workspaceId,
      SLACK_HISTORY_CATALOG_ID,
    ]);
    rows = result.rows;
  } catch (err) {
    // `errorMessage`, not a raw ternary: this wraps a bare `db.query`, which is
    // the pg failure class whose message can echo the connection string. The
    // scrubber strips `scheme://user:pass@host` userinfo and truncates. `err` is
    // the key the brain subsystem uses everywhere else, and the one pino's
    // serializer keys on.
    log.warn(
      { workspaceId, requestId, err: errorMessage(err) },
      "brain oversight: could not read install configs — every audience will be reported with an opaque handle. Counts are unaffected",
    );
    return bySource;
  }

  const channels = new Set<string>();
  let unparseableConfigs = 0;
  for (const raw of rows) {
    const config =
      typeof raw === "object" && raw !== null
        ? (raw as { config?: unknown }).config
        : undefined;
    const parsed = parseSlackHistoryConfig(
      typeof config === "object" && config !== null && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : null,
    );
    // intentionally ignored: an unparseable config is already surfaced as an
    // actionable sync error by the connector and the audience sync, which both
    // `throw new Error(parsed.error)` on it. Here it only means those channels
    // cannot be shown to have been configured, so their label is withheld —
    // the fail-closed outcome. Counted below so "why is every label opaque?" is
    // a log line rather than an inference.
    if (!parsed.ok) {
      unparseableConfigs++;
      continue;
    }
    for (const channelId of parsed.channels) channels.add(channelId);
  }
  if (unparseableConfigs > 0) {
    log.debug(
      { workspaceId, requestId, unparseableConfigs, configuredChannels: channels.size },
      "brain oversight: some install configs did not parse — their channels cannot be shown as configured, so those audiences report an opaque handle",
    );
  }
  if (channels.size > 0) bySource.set(SLACK_HISTORY_SOURCE, channels);
  return bySource;
}

/** What a grant token is, and whether it may be named. */
interface TokenClass {
  readonly kind: BrainFactOversightBucketKind;
  readonly labelPolicy: BrainFactOversightLabelPolicy;
}

/**
 * Classify one stored grant token for display.
 *
 * Parsing goes through `acl.ts`'s `parsePrincipal` rather than a shape check of
 * this module's own: that parser is the single source of truth for the grammar,
 * and a second one here would eventually disagree about which tokens are real —
 * on the surface whose job is to tell an admin what is real.
 *
 * The policy per arm, and why:
 *
 *   - **`org`, `role:*` → `intrinsic`, named.** A fixed, public vocabulary
 *     ("everyone", "owners") that identifies no channel and no person. Naming
 *     it discloses nothing, which is why it is neither configured nor
 *     discovered — stretching either word to cover it is how the rule gets
 *     applied loosely to the arms where it matters.
 *   - **`audience:chat-channel:<source>:<id>` → `configured`** when the admin
 *     put `<id>` in the install form, else **`discovered`**. See
 *     {@link ConfiguredChannels}. An audience id in a namespace this module
 *     does not know how to parse is `discovered` by construction — the fallback
 *     M3's sources inherit if nobody makes a decision, and the fail-closed one.
 *   - **`user:*` → `discovered`, withheld.** Atlas RESOLVED that person from a
 *     source roster; no admin named them. An org admin can already list members
 *     at `/admin/users`, but "this named person is the sole audience for N
 *     facts" is a new disclosure, and this surface has no reason to make it.
 *   - **anything else → `malformed`, withheld.** Outside the grammar
 *     (`everyone`, `ROLE:admin`, a NULL element), so it grants nobody access.
 *     Reported rather than dropped, because a bucket of facts whose grant is
 *     junk is a real backlog. Withheld because an out-of-grammar token is
 *     arbitrary text from an import bundle, and this is not the surface to
 *     render arbitrary stored text on.
 *
 * Note a `malformed` bucket does NOT mean "invisible to everyone": one bucket
 * is one TOKEN, and a fact can carry a usable token alongside a junk one. The
 * entirely-unusable class is `lib/brain/grant-sweep.ts`'s remit (#4797).
 *
 * ## Case sensitivity, stated because it is load-bearing and invisible
 *
 * `parseSlackHistoryConfig` upper-cases channel ids at parse
 * (`.trim().toUpperCase()`); `deriveChatChannelGrant` only trims, and the
 * comparison below is a case-SENSITIVE `Set.has`. Slack ids are uppercase, so
 * the two agree today. A vendor whose ids are not would fall through to
 * `discovered` — fail-closed, and undiagnosable from the UI, so a source that
 * adds one owns normalising both sides.
 */
export function classifyToken(
  token: string,
  configured: ConfiguredChannels,
  meta?: CountMeta,
): TokenClass {
  const principal = parsePrincipal(token);
  // Outside the grammar. `discovered` here means WITHHELD rather than
  // "Atlas discovered it" — a junk token was neither configured nor
  // discovered, and inventing a fourth policy value for it would put a word on
  // the wire that only ever means "not the other two".
  if (!principal) return { kind: "malformed", labelPolicy: "discovered" };

  switch (principal.kind) {
    case "org":
      return { kind: "org", labelPolicy: "intrinsic" };
    case "role":
      return { kind: "role", labelPolicy: "intrinsic" };
    case "user":
      return { kind: "user", labelPolicy: "discovered" };
    case "audience": {
      const parts = parseChatChannelAudienceId(principal.audienceId);
      const named =
        parts !== null && (configured.get(parts.source)?.has(parts.channelId) ?? false);
      return { kind: "audience", labelPolicy: named ? "configured" : "discovered" };
    }
    default: {
      // Compile error if the grammar gains a fifth arm without a disclosure
      // decision here. Runtime deny for anything arriving through a cast:
      // withholding an unrecognised principal's label is the fail-closed
      // reading, and it is loud rather than a silent fall-through.
      const unexpected: never = principal;
      log.warn(
        { ...meta, kind: (unexpected as { kind?: unknown }).kind },
        "brain oversight: unrecognised principal kind — withholding its label",
      );
      return { kind: "malformed", labelPolicy: "discovered" };
    }
  }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * The five state counters, spelled once.
 *
 * `retracted` is filtered on `invalidated_at` ALONE and every other arm ANDs
 * `invalidated_at IS NULL`, so the tombstone axis and the status axis never
 * double-count the same fact. `archived` has no counter: retraction is a
 * tombstone rather than a demotion (ADR-0036 — supersession is not deletion),
 * so no in-region path writes that status and a counter for it would report a
 * permanent zero as if it meant something.
 *
 * The arms therefore do NOT sum to a bucket's fact total, and nothing on the
 * wire claims they do.
 *
 * `valid_to` is DELIBERATELY not an axis here (#4912): a superseded fact stays
 * in the `published` arm. These counters account for the workspace by REVIEW
 * STATE and tombstone, and a superseded fact's review verdict stands — it is
 * published, merely no longer current. That makes this `published` figure
 * legitimately LARGER than the review page's `publishedTotal`, which is an
 * as-of-now read and hides superseded rows; the divergence is by design, not
 * drift, and `oversight.test.ts` pins the absence of the predicate. The
 * supersession story is disclosed on this same surface by `willSupersede`
 * instead of by shrinking a counter.
 */
const STATE_COUNTERS = `COUNT(*) FILTER (WHERE f.status = 'draft' AND f.invalidated_at IS NULL)::int AS awaiting_review,
         COUNT(*) FILTER (WHERE f.status = 'published' AND f.invalidated_at IS NULL)::int AS published,
         COUNT(*) FILTER (WHERE f.invalidated_at IS NOT NULL)::int AS retracted,
         COUNT(*) FILTER (WHERE f.status = 'draft' AND f.invalidated_at IS NULL
                            AND ${PROVISIONAL_PREDICATE})::int AS provisional,
         COUNT(*) FILTER (WHERE f.status = 'draft' AND f.invalidated_at IS NULL
                            AND ${TENSION_EXISTS_SELECT})::int AS in_tension`;

/**
 * Per-grant-token counts for one workspace. NO reader predicate — see the
 * module header for why that is the feature rather than the bug.
 *
 * `SELECT DISTINCT` inside the lateral because `visible_to` is a plain `text[]`
 * with no uniqueness at rest: a grant of `['org', 'org']` would otherwise count
 * its fact twice in the same bucket, inflating exactly the number an admin is
 * being asked to trust. `COALESCE(t, '')` mirrors `parseGrant`, which normalises
 * a NULL element to `''` — so a NULL grant element lands in the same
 * `malformed` bucket through both paths instead of vanishing from one.
 *
 * ORDER BY + LIMIT push truncation into the database: ordering by the counters
 * keeps the buckets that matter, and asking for one more than the cap is how
 * overrun is DETECTED rather than assumed. The tiebreak on `token` only makes
 * the cut deterministic — display order is decided in TypeScript, where the
 * withheld labels are.
 *
 * Selects no claim, no provenance, no episode. That is the contract.
 */
export const OVERSIGHT_BUCKETS_SQL = `SELECT g.token AS token,
         ${STATE_COUNTERS}
    FROM brain_facts f
    CROSS JOIN LATERAL (
           SELECT DISTINCT COALESCE(t, '') AS token FROM unnest(f.visible_to) AS t
         ) g
   WHERE f.workspace_id = $1
   GROUP BY g.token
   ORDER BY awaiting_review DESC, published DESC, retracted DESC, g.token ASC
   LIMIT $2`;

/**
 * Workspace-wide counts, per FACT rather than per token.
 *
 * A separate statement rather than a rollup of the buckets, because a fact
 * counted in three buckets must count once here — and because the buckets are
 * capped while this is not, so the top-line disclosure survives truncation.
 */
export const OVERSIGHT_TOTALS_SQL = `SELECT ${STATE_COUNTERS}
    FROM brain_facts f
   WHERE f.workspace_id = $1`;

/**
 * How many distinct grant tokens the workspace holds — the TRUE audience
 * cardinality, with no cap.
 *
 * Run only when {@link OVERSIGHT_BUCKETS_SQL} was clipped. `buckets.length`
 * reads as this number and stops being it under truncation, and "across 200
 * audiences" presented as fact is the clipped-breakdown-reads-as-complete
 * failure the cap's own comment forbids.
 *
 * Mirrors the bucket query's lateral exactly, `SELECT DISTINCT` included, so
 * the two cannot disagree about what one token is.
 */
export const OVERSIGHT_DISTINCT_TOKENS_SQL = `SELECT COUNT(DISTINCT g.token)::int AS n
    FROM brain_facts f
    CROSS JOIN LATERAL (
           SELECT DISTINCT COALESCE(t, '') AS token FROM unnest(f.visible_to) AS t
         ) g
   WHERE f.workspace_id = $1`;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Set when any counter failed to read back — see {@link count}.
 *
 * A mutable cell rather than a result union because `count` is called from three
 * places over a dozen fields, and threading a wrapper through all of them would
 * bury the one line that matters. It reaches the wire as
 * `countsConsistent: false`.
 */
interface DegradedCounters {
  hit: boolean;
}

/**
 * A counter off `pg`, or 0 — and loudly, VISIBLY 0.
 *
 * Every column here is `::int` over a `COUNT(*)`, so a value that will not read
 * back as a non-negative number is query drift, not data.
 *
 * ## Why a log is not enough, and this clears `countsConsistent`
 *
 * The fallback direction is the reassuring one, and this surface's whole product
 * is a single delta — so a silent 0 does not merely understate, it FABRICATES.
 * Both directions are reachable and both are worse than saying nothing:
 *
 *   - `reviewableAwaitingReview` degrades to 0 against a real 32 ⇒ the panel
 *     announces "32 drafts are not in your queue. They belong to audiences you
 *     are not part of" — a confident, invented explanation for a column rename.
 *   - every counter degrades to 0 ⇒ no alert renders at all and the table is
 *     zeros. A complete, confident, false all-clear on the one surface that
 *     exists to prevent one.
 *
 * So the degradation TRAVELS: `degraded.hit` clears `countsConsistent`, and the
 * panel's existing "can't work out the delta right now" arm covers it with no
 * second wire field. It is not a throw, unlike the missing-totals-row case — a
 * drifted column still yields a usable per-audience breakdown, and taking the
 * page down would remove more disclosure than it protects.
 */
function count(
  value: unknown,
  field: string,
  meta: CountMeta,
  degraded: DegradedCounters,
): number {
  // NOT a bare `Number(value)`. That coerces `null`, `""`, `false` and `[]` all
  // to 0 — finite and non-negative, so they would sail through this guard as a
  // confident zero with no log and no `degraded.hit`, which is precisely the
  // fabrication the docstring above exists to close. `undefined` is already
  // caught (`Number(undefined)` is NaN); the falsy-but-coercible set is the
  // hole. A `string` arm stays because `pg` hands back `int8` as text — `::int`
  // makes that unreachable here, but the cast is one edit away from `::bigint`.
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n) || n < 0) {
    degraded.hit = true;
    log.warn(
      { ...meta, field, rawType: typeof value },
      "brain oversight: a counter did not read back as a non-negative number — reporting 0 and marking the delta untrustworthy; the aggregate's query shape changed",
    );
    return 0;
  }
  return Math.trunc(n);
}

function totalsFrom(
  row: Record<string, unknown>,
  meta: CountMeta,
  degraded: DegradedCounters,
): BrainFactOversightTotals {
  return {
    awaitingReview: count(row.awaiting_review, "awaiting_review", meta, degraded),
    published: count(row.published, "published", meta, degraded),
    retracted: count(row.retracted, "retracted", meta, degraded),
    provisional: count(row.provisional, "provisional", meta, degraded),
    inTension: count(row.in_tension, "in_tension", meta, degraded),
  };
}

/** A bucket before its display identity is assigned. */
interface RawBucket extends BrainFactOversightTotals {
  readonly token: string;
  readonly kind: BrainFactOversightBucketKind;
  readonly labelPolicy: BrainFactOversightLabelPolicy;
}

/**
 * Stable ordering key for a withheld bucket.
 *
 * Hashed with the workspace id so it cannot be compared across tenants, and —
 * the part that matters — NEVER EMITTED. It only orders the ordinal assignment,
 * so `discovered-2` is stable while the token set is, without the wire carrying
 * anything derived from the id. Emitting the hash itself would be the tempting
 * shortcut and the wrong one: a Slack channel id is ten characters of `[A-Z0-9]`
 * and the salt is a workspace id the admin already holds, which is a brute-force
 * range rather than a one-way function.
 */
function orderingKey(workspaceId: string, token: string): string {
  return createHash("sha256").update(`${workspaceId}:${token}`).digest("hex");
}

/**
 * Where a workspace's facts really stand, as numbers.
 *
 * Three statements, always, in parallel: the per-token buckets, the per-fact
 * workspace totals, and the reader's own reviewable count. The install configs
 * are read alongside them — a fourth read that only decides labels, and whose
 * failure costs legibility rather than correctness.
 *
 * ## They are ONE REQUEST, not one snapshot
 *
 * `db` is a pool and there is no enclosing transaction, so the statements take
 * up to four connections and read at four different LSNs. What that buys is
 * real but bounded: the two halves of the disclosure cannot drift between two
 * CLIENT fetches, which is the flicker a separate `/summary` call would cause.
 * It does NOT make them transactionally consistent, so a fact ingested between
 * the totals read and the reviewable read can legitimately produce
 * `reviewableAwaitingReview > workspaceTotals.awaitingReview`. That is what
 * `countsConsistent` reports — see below; do not upgrade it to a throw without
 * first putting all three on one client under `REPEATABLE READ`.
 *
 * @throws {BrainReaderUnresolvedError} when the reader has no usable principals.
 *   The workspace counts would still compute, but serving them to a caller
 *   whose identity did not resolve would hand an unidentified session the
 *   workspace's shape — and the paired `reviewableAwaitingReview` would be a
 *   fabricated zero, rendering as "all of it is hidden from you" for what is
 *   really an authentication fault.
 */
export async function loadFactOversight(
  db: BrainCandidateReader,
  ctx: BrainPrincipalContext,
  requestId?: string,
): Promise<BrainFactOversight> {
  const workspaceId = ctx.workspaceId;
  const acl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });
  if (acl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(workspaceId, ctx.origin, OVERSIGHT_SURFACE);
  }

  const [bucketResult, totalsResult, reviewableResult, configured] = await Promise.all([
    db.query(OVERSIGHT_BUCKETS_SQL, [workspaceId, OVERSIGHT_BUCKET_MAX + 1]),
    db.query(OVERSIGHT_TOTALS_SQL, [workspaceId]),
    db.query(
      // The current-validity term keeps this the SAME quantity as `/summary`'s
      // `draftTotal` (#4912) — the panel restates that number, and the two
      // diverging over an imported already-superseded draft would be exactly
      // the flicker carrying them in one response exists to prevent. The
      // WORKSPACE counters above deliberately do NOT carry the term (see
      // STATE_COUNTERS), so such a draft lands in the hidden-backlog delta —
      // honestly: publish still reaches it and no reader's queue shows it.
      `SELECT COUNT(*)::int AS n
         FROM brain_facts f
        WHERE ${acl.sql}
          AND f.status = 'draft'
          AND f.invalidated_at IS NULL
          AND ${brainFactCurrentClause("f")}`,
      [...acl.params],
    ),
    loadConfiguredChannels(db, workspaceId, requestId),
  ]);

  const bucketRows = bucketResult.rows;
  const truncated = bucketRows.length > OVERSIGHT_BUCKET_MAX;
  if (truncated) {
    log.warn(
      { workspaceId, requestId, cap: OVERSIGHT_BUCKET_MAX },
      "brain oversight: workspace has more distinct grant tokens than one response carries — the breakdown is clipped, the totals are not",
    );
  }

  const countMeta: CountMeta = { workspaceId, requestId };
  const degraded: DegradedCounters = { hit: false };
  const raw: RawBucket[] = [];
  // A drifted row is DROPPED, not coerced — and counted, because a dropped
  // bucket is an under-report from a surface whose product is a breakdown. The
  // tempting `?? ""` was here first and was worse than it looks: `''` parses as
  // malformed, so two unrelated drifted rows would merge into one `malformed`
  // bucket AND collide on the same `discovered-N` handle, silently rendering as
  // one row. `COALESCE` in the query makes both arms unreachable from Postgres;
  // they exist for a driver or adapter that changed shape underneath us.
  let droppedRows = 0;
  for (const row of truncated ? bucketRows.slice(0, OVERSIGHT_BUCKET_MAX) : bucketRows) {
    if (typeof row !== "object" || row === null) {
      droppedRows++;
      continue;
    }
    const r = row as Record<string, unknown>;
    if (typeof r.token !== "string") {
      droppedRows++;
      continue;
    }
    const { kind, labelPolicy } = classifyToken(r.token, configured, countMeta);
    raw.push({ token: r.token, kind, labelPolicy, ...totalsFrom(r, countMeta, degraded) });
  }
  if (droppedRows > 0) {
    // A dropped bucket also makes `distinctAudiences` too small on the
    // untruncated path (where it IS `buckets.length`), so the breakdown
    // understates itself with no banner. Same wire signal as a drifted counter.
    degraded.hit = true;
    log.warn(
      { workspaceId, requestId, droppedRows, kept: raw.length },
      "brain oversight: bucket rows came back without a readable `token` — they are missing from the breakdown, which therefore understates the workspace; the aggregate's query shape changed",
    );
  }

  // Ordinals are assigned over a HASH order rather than the display order, so a
  // withheld bucket keeps its handle while the token set is stable — display
  // order moves with the counts on every ingest cycle, and a `key` that moved
  // with it would remount a row for no reason and make "discovered-2" mean a
  // different channel between two glances at the same screen.
  const handles = new Map<string, string>();
  const withheld = raw
    .filter((b) => b.labelPolicy === "discovered")
    .toSorted((a, b) =>
      orderingKey(workspaceId, a.token).localeCompare(orderingKey(workspaceId, b.token)),
    );
  withheld.forEach((bucket, index) => {
    handles.set(bucket.token, `discovered-${index + 1}`);
  });

  const buckets: BrainFactOversightBucket[] = raw
    .toSorted(
      (a, b) =>
        b.awaitingReview - a.awaitingReview ||
        b.published - a.published ||
        b.retracted - a.retracted ||
        // Never `a.token.localeCompare(b.token)`: display order is observable,
        // so ordering withheld buckets by their own text would leak the
        // alphabetical position of an id this surface just refused to print.
        (handles.get(a.token) ?? a.token).localeCompare(handles.get(b.token) ?? b.token),
    )
    .map((bucket): BrainFactOversightBucket => {
      const counters = {
        kind: bucket.kind,
        awaitingReview: bucket.awaitingReview,
        published: bucket.published,
        retracted: bucket.retracted,
        provisional: bucket.provisional,
        inTension: bucket.inTension,
      };
      if (bucket.labelPolicy === "discovered") {
        // The withheld arm has no `label` PROPERTY, not a null one — the wire
        // type is a discriminated union so this object literally cannot carry
        // the token. `handles` covers every withheld token by construction (it
        // is built from the same filter), so a miss is a defect; it is asserted
        // rather than `??`-defaulted, because a shared fallback handle would
        // collapse two audiences into one row.
        const key = handles.get(bucket.token);
        if (!key) {
          throw new Error(
            `brain oversight: no display handle was assigned for a withheld bucket in workspace ${workspaceId} — the handle map and the withheld filter disagree`,
          );
        }
        return { ...counters, labelPolicy: "discovered", key };
      }
      return { ...counters, labelPolicy: bucket.labelPolicy, key: bucket.token, label: bucket.token };
    });

  const totalsRow = totalsResult.rows[0];
  if (typeof totalsRow !== "object" || totalsRow === null) {
    // An aggregate with no GROUP BY always returns exactly one row, so this is
    // unreachable from Postgres. It is a THROW rather than an all-zero default
    // because all-zero renders as "0 awaiting review, nothing hidden from you"
    // — a complete, confident, false all-clear on the one surface that exists
    // to prevent one. A 500 with a requestId is the honest answer.
    throw new Error(
      `brain oversight: the workspace totals aggregate returned no row for workspace ${workspaceId} — the totals query shape changed`,
    );
  }
  const workspaceTotals = totalsFrom(totalsRow as Record<string, unknown>, countMeta, degraded);
  const reviewableAwaitingReview = count(
    (reviewableResult.rows[0] as Record<string, unknown> | undefined)?.n,
    "reviewable_n",
    countMeta,
    degraded,
  );

  // The TRUE cardinality, uncapped — `buckets.length` stops being it the moment
  // truncation bites, and the client must never infer one from the other.
  //
  // FLOORED at the number of buckets actually shipping. The buckets are a subset
  // of the distinct tokens by construction, so a smaller answer can only come
  // from `count()` degrading this one statement to 0 — and that would print
  // "across 0 audiences" over a visible 200-row table, beneath a banner
  // promising the count is exact. Note the direction: for a CARDINALITY,
  // understating is the reassuring direction, which inverts `count()`'s usual
  // posture. The floor is preferred to a throw because the breakdown is still
  // usable and `degraded.hit` has already marked the delta untrustworthy —
  // taking the page down would remove more disclosure than it protects.
  const distinctAudiences = truncated
    ? Math.max(await countDistinctTokens(db, workspaceId, countMeta, degraded), buckets.length)
    : buckets.length;

  // Two independent reasons the delta cannot be trusted, one wire signal.
  //
  //   1. A DEGRADED COUNTER. 0 is the reassuring answer, and it fabricates in
  //      both directions: 0 on the scoped half invents a hidden backlog with a
  //      confident false cause, 0 on the unscoped half erases a real one.
  //   2. AN INVERSION. The scoped count is a subset of the unscoped one at any
  //      single instant — but these are separate statements on separate
  //      connections (see the header), so a fact ingested between them that this
  //      reader CAN see legitimately inverts them. A race, not proof of a bug;
  //      a persistent or large inversion is what means the two statements
  //      disagree about the workspace.
  //
  // What must NOT happen in either case is silently clamping the delta to zero:
  // that renders as "nothing is hidden from you", which is the pre-#4825 defect
  // reproduced by its own fix. So the condition travels to the client and the
  // panel says it cannot compute the delta.
  const inverted = reviewableAwaitingReview > workspaceTotals.awaitingReview;
  if (inverted) {
    log.warn(
      { workspaceId, requestId, reviewableAwaitingReview, workspaceTotals },
      "brain oversight: the reader-scoped draft count exceeds the workspace draft count — expected only as a brief race between two non-transactional statements; if it persists, the two statements disagree about the workspace and the hidden-backlog delta is not trustworthy",
    );
  }

  return {
    buckets,
    workspaceTotals,
    reviewableAwaitingReview,
    countsConsistent: !degraded.hit && !inverted,
    distinctAudiences,
    bucketsTruncated: truncated,
  };
}

/**
 * Distinct grant tokens in the workspace, uncapped.
 *
 * Only run when the bucket list was actually clipped — on the overwhelmingly
 * common untruncated path `buckets.length` IS the cardinality, and a second
 * statement for it would be a round trip every workspace pays so that a handful
 * never render a wrong number.
 */
async function countDistinctTokens(
  db: BrainCandidateReader,
  workspaceId: string,
  meta: CountMeta,
  degraded: DegradedCounters,
): Promise<number> {
  const result = await db.query(OVERSIGHT_DISTINCT_TOKENS_SQL, [workspaceId]);
  return count(
    (result.rows[0] as Record<string, unknown> | undefined)?.n,
    "distinct_tokens",
    meta,
    degraded,
  );
}

// ---------------------------------------------------------------------------
// Will-supersede disclosure (#4912)
// ---------------------------------------------------------------------------

/** Most supersession pairs one response enumerates. A payload bound, like
 * {@link OVERSIGHT_BUCKET_MAX} — overrun is reported (`truncated`), never
 * silent, and never silently laundered into `withheld`, which means
 * something else. */
export const WILL_SUPERSEDE_PAIR_MAX = 100;

/**
 * How many supersessions the next publish will perform, workspace-wide.
 *
 * Unscoped like the count aggregates above, and content-free like them: one
 * number, no claim. It is what makes `withheld` honest — publish is
 * workspace-scoped, so the pairs a reader cannot see still happen.
 *
 * The collision join and the draft predicate are IMPORTED from the promotion
 * adapter, not restated: a disclosure that drifted from the transaction's own
 * collision rule would list one set while publish stamps another, which is
 * silent supersession through drift — the exact failure #4912 forbids.
 *
 * One accepted over-statement: this counts every colliding LIVE draft, while
 * the transaction supersedes only for drafts the classifier admits — so a
 * refused draft's collision is listed here and then not stamped. That mirrors
 * the publish preview's own posture ("the preview lists what publish will
 * CONSIDER"), over-discloses rather than under-, and the refusal itself is
 * separately disclosed; replicating the refusal rules in SQL is not worth a
 * second spelling of them.
 */
export const WILL_SUPERSEDE_TOTAL_SQL = `SELECT COUNT(*)::int AS will_supersede_total
    FROM brain_facts d
    ${supersessionCollisionJoin("d", "p")}
   WHERE d.workspace_id = $1
     AND ${supersedingDraftPredicate("d")}`;

/**
 * The reader-visible pairs, BOTH sides gated by the reader's own predicate.
 *
 * This is the one statement under `lib/brain/oversight.ts` that selects claim
 * content, and the module rule ("a number, never content") survives it intact:
 * that rule governs the UNSCOPED aggregates, and this projection is
 * reader-scoped on both aliases — a pair appears only when the reader's own
 * fail-closed predicate admits BOTH rows. Everything the ACL withholds
 * travels as the count above. Requiring BOTH sides (not just the
 * published one) is deliberate: "something you cannot see will replace X" and
 * "Y will replace something you cannot see" each disclose half a claim's
 * history to a reader the grant excluded from the other half.
 *
 * `COUNT(*) OVER ()` carries the true scoped cardinality past the LIMIT, so
 * `truncated` is detected rather than assumed — same pattern as
 * `loadFactCandidates`.
 *
 * `draftAclSql` / `publishedAclSql` are interpolated, so callers pass clauses
 * they built — same contract as `brainFactPreviewSql`.
 */
export function willSupersedePairsSql(
  draftAclSql: string,
  publishedAclSql: string,
  limitParam: number,
): string {
  return `SELECT d.id::text AS draft_id,
         d.subject || ' ' || d.predicate || ' ' || d.object AS draft_label,
         p.id::text AS superseded_id,
         p.subject || ' ' || p.predicate || ' ' || p.object AS superseded_label,
         COUNT(*) OVER ()::int AS scoped_total
    FROM brain_facts d
    ${supersessionCollisionJoin("d", "p")}
   WHERE ${draftAclSql}
     AND ${publishedAclSql}
     AND ${supersedingDraftPredicate("d")}
   ORDER BY d.ingested_at, d.id, p.ingested_at, p.id
   LIMIT $${limitParam}`;
}

/**
 * What the next publish will supersede, disclosed BEFORE the admin confirms
 * (#4912) — the temporal sibling of #4825's hidden-backlog delta.
 *
 * Promoting a `single`-cardinality draft that collides with a live published
 * fact stamps the old fact's `valid_to` inside the publish transaction, and
 * every as-of-now read then hides it. Nothing about that is wrong — it is the
 * supersession model — but it must never be SILENT: the superseded side is
 * invisible by construction afterwards, so this preview is the one moment the
 * replacement can be seen as a pair.
 *
 * ⚠️ *Collides* is narrower than it was, three times over, and this preview
 * inherits every narrowing for free because it is built from
 * `supersessionCollisionJoin`. Since #5030 a pair must be PROVABLY different,
 * not merely differently-keyed; since #5033 neither side may be tier-1 or carry
 * a source kind the region cannot classify; since #5032 the two subjects must
 * not be PROVABLY DIFFERENT ENTITIES (a homonym is not a collision at all — it
 * is two claims that never shared a slot). So a pair held back on any
 * ground correctly does not appear here — the disclosure and the transaction
 * agree, which is the property #4912 actually requires. It is NOT the same as
 * the pair being gone: BOTH claims stay live and current, related by the
 * `in-tension-with` edge `reconcile.ts` writes at ingest, and the publish logs
 * and audits a count of what it withheld. Note where the pair is NOT: after
 * this publish both rows are `published`, so neither appears in the review
 * queue's default `status = 'draft'` view — a reviewer reaches them through the
 * fact's tension cluster. And the edge is not guaranteed for every held-back
 * pair (a post-ingest re-key writes none, and `TENSION_EDGE_CAP` bounds the
 * fan-out), which is why the count exists rather than being redundant with
 * it.
 *
 * Two statements, one request: the unscoped total (a number, never content)
 * and the reader-scoped pairs. `withheld` is their difference — supersessions
 * that will happen regardless, listing rows this reader may not read.
 *
 * @throws {BrainReaderUnresolvedError} when the reader has no usable
 *   principals, for {@link loadFactOversight}'s reason.
 */
export async function loadSupersessionPreview(
  db: BrainCandidateReader,
  ctx: BrainPrincipalContext,
  requestId?: string,
): Promise<BrainFactWillSupersede> {
  const workspaceId = ctx.workspaceId;
  const draftAcl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "d",
    paramIndex: 1,
    requestId,
  });
  if (draftAcl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(workspaceId, ctx.origin, OVERSIGHT_SURFACE);
  }
  const publishedAcl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "p",
    paramIndex: draftAcl.nextParamIndex,
    requestId,
  });
  if (publishedAcl.decision === "deny-all") {
    // Unreachable — same context, same table, and the first clause already
    // resolved. Kept because a silent empty pair list under a deny would render
    // as "nothing will be superseded", the exact false all-clear this surface
    // exists to prevent.
    throw new BrainReaderUnresolvedError(workspaceId, ctx.origin, OVERSIGHT_SURFACE);
  }

  const limitParam = publishedAcl.nextParamIndex;
  const [totalResult, pairsResult] = await Promise.all([
    db.query(WILL_SUPERSEDE_TOTAL_SQL, [workspaceId]),
    db.query(willSupersedePairsSql(draftAcl.sql, publishedAcl.sql, limitParam), [
      ...draftAcl.params,
      ...publishedAcl.params,
      WILL_SUPERSEDE_PAIR_MAX + 1,
    ]),
  ]);

  const rawTotal = (totalResult.rows[0] as Record<string, unknown> | undefined)
    ?.will_supersede_total;
  const total =
    typeof rawTotal === "number"
      ? rawTotal
      : typeof rawTotal === "string" && rawTotal.trim() !== ""
        ? Number(rawTotal)
        : Number.NaN;
  if (!Number.isFinite(total) || total < 0) {
    // A THROW, not a degraded 0, for the missing-totals-row reason above: 0
    // renders as "this publish supersedes nothing", a confident false
    // all-clear fabricated from query drift, on the surface whose whole job is
    // this disclosure. `COUNT(*)` cannot return NULL, so this is unreachable
    // from Postgres.
    throw new Error(
      `brain oversight: the will-supersede total did not read back as a number for workspace ${workspaceId} — refusing to disclose a supersession scope Atlas cannot establish`,
    );
  }

  const rawRows = pairsResult.rows;
  const clipped = rawRows.length > WILL_SUPERSEDE_PAIR_MAX;
  const pairs: BrainFactWillSupersedePair[] = [];
  let scopedTotal = 0;
  let droppedRows = 0;
  let windowDriftRows = 0;
  for (const raw of clipped ? rawRows.slice(0, WILL_SUPERSEDE_PAIR_MAX) : rawRows) {
    if (typeof raw !== "object" || raw === null) {
      droppedRows++;
      continue;
    }
    const r = raw as Record<string, unknown>;
    if (
      typeof r.draft_id !== "string" ||
      typeof r.draft_label !== "string" ||
      typeof r.superseded_id !== "string" ||
      typeof r.superseded_label !== "string"
    ) {
      droppedRows++;
      continue;
    }
    // The window rides every row; reading it off each kept row rather than only
    // the first means one drifted window costs nothing — any other kept row's
    // window recovers the scoped count, and only when every window drifts do
    // the floors below take over. A row whose window will not parse is COUNTED — the
    // floor below is what keeps that drift from silently relabelling clipped
    // rows as ACL-withheld. `null` is mapped to NaN explicitly: `Number(null)`
    // is a finite 0, which would skip both the max() and the drift counter —
    // the one shape of window drift that would otherwise go unlogged.
    const windowed =
      typeof r.scoped_total === "number"
        ? r.scoped_total
        : r.scoped_total == null
          ? Number.NaN
          : Number(r.scoped_total);
    if (Number.isFinite(windowed) && windowed > scopedTotal) scopedTotal = Math.trunc(windowed);
    else if (!Number.isFinite(windowed)) windowDriftRows++;
    pairs.push({
      draftId: r.draft_id,
      draftLabel: r.draft_label,
      supersededId: r.superseded_id,
      supersededLabel: r.superseded_label,
    });
  }
  if (droppedRows > 0) {
    // Dropped, never coerced — but a dropped pair UNDERSTATES a disclosure, so
    // it is loud. The total above is a separate statement and unaffected.
    log.warn(
      { workspaceId, requestId, droppedRows, kept: pairs.length },
      "brain oversight: will-supersede pair rows came back with an unreadable column — the pair list understates what publish will supersede; the query shape changed",
    );
  }
  if (windowDriftRows > 0) {
    log.warn(
      { workspaceId, requestId, windowDriftRows },
      "brain oversight: the will-supersede scoped window did not read back as a number on some rows — truncation may be under-reported; the query shape changed",
    );
  }
  // Floors, in the order that matters. We SAW `rawRows.length` reader-visible
  // rows, so the scoped cardinality is at least that — without this floor, a
  // drifted window column under a clipped page would fold the clipped
  // remainder into `withheld`, i.e. truncation dressed as an ACL boundary,
  // which the wire type explicitly forbids.
  if (clipped && scopedTotal < rawRows.length) scopedTotal = rawRows.length;
  if (scopedTotal < pairs.length) scopedTotal = pairs.length;

  if (scopedTotal > total) {
    // The scoped pairs are a subset of the unscoped total at any instant, so
    // this is the two-statements race `loadFactOversight` documents — or drift.
    // Clamped rather than surfaced as a negative `withheld`: this number is
    // "and N more you cannot see", and under a race the honest answer is
    // "none extra that we know of". Never clamped silently.
    log.warn(
      { workspaceId, requestId, scopedTotal, total },
      "brain oversight: the reader-scoped will-supersede count exceeds the workspace count — a brief ingest race, or the two statements disagree; reporting 0 withheld",
    );
  }

  return {
    total: Math.trunc(total),
    pairs,
    withheld: Math.max(0, total - scopedTotal),
    // `clipped` is ORed in so a known page overrun is reported even if the
    // window column drifted; `scopedTotal > pairs.length` additionally covers
    // drift-dropped rows, which are also "you were entitled to more than is
    // listed".
    truncated: clipped || scopedTotal > pairs.length,
  };
}

// ---------------------------------------------------------------------------
// Will-widen disclosure (#5032)
// ---------------------------------------------------------------------------

/** Most widening entries one response enumerates — {@link WILL_SUPERSEDE_PAIR_MAX}'s bound, same posture. */
export const WILL_WIDEN_ENTRY_MAX = 100;

/**
 * Most DRAFTS {@link willWidenRowsSql} scans, before the evidence join.
 *
 * Far above {@link WILL_WIDEN_ENTRY_MAX} on purpose: this is not the display
 * cap, it is the work cap. The overwhelming majority of drafts widen NOTHING
 * (`widenGrantFromEvidence` returns `null`), so the scan has to cover many more
 * drafts than it will ever list — a bound at the entry cap would silently stop
 * looking after 100 drafts, most of which had no notice to give, and hide the
 * one that did behind them.
 *
 * Hitting it sets `incomplete`, never `truncated`: the drafts beyond it were
 * never evaluated, so they are missing from `total` as well.
 */
export const WILL_WIDEN_DRAFT_SCAN_MAX = 5_000;

/**
 * Every reader-visible draft and the grant of every episode already recorded as
 * EVIDENCE for it — the exact input {@link widenGrantFromEvidence} takes at
 * publish.
 *
 * ## Why rows and not a count
 *
 * "Will this fact's audience widen?" is decided by the GRANT GRAMMAR: a token
 * counts only if `parseGrant` reads it as a principal and `formatPrincipal`
 * round-trips it, and `impliedRoles` then makes most unions admit nobody
 * (`role:owner` added to a fact already granted `role:member` gains no reader).
 * That grammar lives in `acl.ts` and `promotion.ts` says in as many words that
 * duplicating it as a SQL predicate would let the two drift.
 *
 * So this statement does no deciding. It projects the two grants, and the
 * decision is made in TypeScript by **the same function the transaction runs**,
 * which is the only way the notice and the act cannot disagree — the property
 * `supersessionCollisionJoin`'s header argues for at the other disclosure.
 *
 * ## Scope, and the one thing this disclosure does NOT have
 *
 * Reader-scoped on the FACT, mirroring `willSupersedePairsSql`: an entry appears
 * only where the reader's own fail-closed predicate admits the draft. The
 * EPISODE is deliberately not ACL-gated — a fact's evidence grants are what
 * decides its own published grant, and a reader entitled to the fact is
 * precisely the person who must be told what publishing it will do to it.
 *
 * ⚠️ **There is no unscoped `withheld` counterpart, and that is a stated gap
 * rather than an oversight.** `willSupersede` has one because a `COUNT(*)` over
 * the collision join needs no content; the equivalent here would have to run the
 * grant grammar over `brain_episodes.visible_to` for drafts the reader cannot
 * see, and this module's header forbids an unscoped query that selects anything
 * off `brain_episodes`. The alternatives were both worse: a SQL approximation of
 * the grammar is the second spelling `promotion.ts` forbids, and projecting
 * other readers' grants to compute a number is a disclosure-policy decision no
 * issue has taken. The consequence, stated so nobody reads a clean panel as an
 * all-clear: an admin publishing a workspace whose widening drafts are all
 * invisible to them sees NOTHING here. The post-publish record
 * (`PromotionReport.widened`, and the INFO line beside it) is what covers that
 * case today, one moment too late to be notice.
 *
 * ## The bound is on DRAFTS, and the position of it is the whole design
 *
 * {@link willSupersedePairsSql} can carry a plain row `LIMIT` because each of
 * its rows IS a disclosure. Here each row is a FRAGMENT of one — the decision is
 * made after grouping — so a row `LIMIT` would cut a draft's evidence list in
 * half, hand {@link widenGrantFromEvidence} a partial input, and produce an
 * `added` that is a SUBSET of the real one. That is an under-reported ACL change
 * rendered as a confident complete notice, which is strictly worse than not
 * listing the draft at all.
 *
 * So the `LIMIT` sits inside a CTE over the DRAFTS, before the evidence join:
 * every draft that survives it carries its complete evidence list, and the ones
 * that did not survive are absent rather than wrong. Overflow is reported
 * through `incomplete`, never silently.
 *
 * ⚠️ It is a bound and not a page. There is no cursor and no ordering contract
 * with the client — `(ingested_at, id)` is here so the same drafts are chosen on
 * every call, not so a caller can walk them. A reader who hits it should treat
 * publishing as widening more than is listed.
 *
 * **Why it needs one at all**, given that publish reads the same row set:
 * `DRAFT_FACTS_SQL` × `EVIDENCE_GRANTS_SQL` run inside a deliberate, rare admin
 * action, whereas this runs on every render of the oversight page — and it
 * shares a `Promise.all` with the two older disclosures, so an unbounded scan
 * here takes the hidden-backlog delta and the supersession preview down with it.
 * The internal pool sets no `statement_timeout`, so "however long it takes" was
 * the only bound before this.
 *
 * ## ⚠️ The joins are LEFT, and that is what makes the bound OBSERVABLE
 *
 * With INNER joins a draft carrying no `provenance` edge produces no row at all
 * — and most drafts carry nothing this notice will report, which is the very
 * argument for setting the scan cap far above the entry cap. `drafts.size` in
 * the loader would then count *drafts with surviving evidence*, never *drafts
 * scanned*, so `>= WILL_WIDEN_DRAFT_SCAN_MAX` could only ever fire in the single
 * case where all 5,000 scanned drafts happened to have evidence. One
 * evidence-less draft in the window silently disabled the detector, and the
 * panel then rendered a confident complete count over a workspace whose tail was
 * never evaluated — the under-reported ACL change the CTE exists to prevent,
 * reintroduced one variable later.
 *
 * A draft with no edge is not hypothetical: a region-import bundle carries facts
 * and edges independently (`admin-migrate.ts` iterates `bundle.brainEdges ?? []`),
 * so facts without provenance edges are storable.
 *
 * LEFT means every scoped draft yields at least one row, so `drafts.size` is the
 * scanned count for every draft the loader can read at all. It is not an exact
 * equality: a fact whose `fact_grant` drifts fails on every one of its rows (the
 * column is constant per fact), so it is scanned and never counted — masked, like
 * the poison sweep below, by that path also forcing `incomplete` through
 * `droppedRows`. `brain_episodes.visible_to` is `NOT NULL` (0180), so a SQL
 * `null` in `evidence_grant` can only mean the join found nothing — which the
 * loader reads as "no evidence", NOT as drift.
 *
 * `factAclSql` is interpolated, so callers pass a clause they built — same
 * contract as {@link willSupersedePairsSql}.
 */
export function willWidenRowsSql(factAclSql: string, draftLimitParam: number): string {
  return `WITH scoped AS (
      SELECT f.id, f.ingested_at, f.subject, f.predicate, f.object, f.visible_to, f.workspace_id
        FROM brain_facts f
       WHERE ${factAclSql}
         AND ${supersedingDraftPredicate("f")}
       ORDER BY f.ingested_at, f.id
       LIMIT $${draftLimitParam}
    )
    SELECT f.id::text AS fact_id,
         f.subject || ' ' || f.predicate || ' ' || f.object AS label,
         f.visible_to  AS fact_grant,
         ep.visible_to AS evidence_grant
    FROM scoped f
    LEFT JOIN brain_edges e
      ON e.workspace_id = f.workspace_id
     AND e.edge_type = 'provenance'
     AND e.from_fact_id = f.id
    LEFT JOIN brain_episodes ep
      ON ep.workspace_id = e.workspace_id
     AND ep.id = e.to_episode_id
   ORDER BY f.ingested_at, f.id, ep.ingested_at, ep.id`;
}

/**
 * What the next publish will make VISIBLE TO MORE PEOPLE, disclosed before the
 * admin confirms (#5032, ADR-0037 §5).
 *
 * ## The gap this closes is NOTICE, not authority
 *
 * #4823 already put grant widening at the review gate and made the human the
 * authority over it. What a reviewer never got was a way to SEE it coming: they
 * publish a draft and its audience widens because of `provenance` edges written
 * by an unattended ingest pass weeks earlier. That is `status: ambiguous`'s
 * shape — surface it to a human, never silently pick.
 *
 * ## Why it exists NOW: subject homonymy
 *
 * Widening is usually correct, and its safety argument is
 * `widenGrantFromEvidence`'s *"a reader of either already saw it said"*. Subject
 * homonymy falsifies that sentence: `CORROBORATION_LOOKUP_SQL` matches on slot
 * keys, keys are a function of the SURFACE, and one surface can name two
 * entities — so a public episode about one `Acme Corp` becomes evidence for a
 * private fact about another, and this widening then hands its audience the
 * private claim's BODY. `subject_cmp` (#5032) removes that whenever a
 * warehouse-backed store can prove the two subjects are different entities. It
 * can never remove the extractor↔extractor case, for any subject, ever — which
 * is why the residue gets a disclosure instead of a fix.
 *
 * ## ⚠️ Gated on `added` being NON-EMPTY, which is the whole design
 *
 * Widening fires on legitimate corroboration too, so a disclosure that reported
 * "this publish widens grants" whenever an evidence edge existed would be
 * universal — a filter that has been fooled, and one a reviewer learns to click
 * through in a week. {@link widenGrantFromEvidence} returns `null` when the
 * evidence adds nothing, which is the common case by a wide margin
 * (role-implication makes most unions admit nobody), and this function reports
 * exactly the facts for which it does not. Rare BY CONSTRUCTION, by narrowing
 * the trigger rather than by hoping.
 *
 * ⚠️ `added` is a SYNTACTIC upper bound on readers gained, not a reader count —
 * `widenGrantFromEvidence` says so at length. A `role:owner` added to a fact
 * already granted `role:member` appears here and admits nobody new. The
 * disclosure over-states in that direction on purpose; the opposite error is a
 * silent ACL change.
 *
 * **Accepted cost, recorded because it is real:** nothing distinguishes the
 * homonym from the honest corroborations in this list. A reviewer told
 * *"publishing widens this to `org`"* can publish or not, and this may be a
 * speed bump that gets clicked through. It is VISIBLE, not prevented.
 *
 * @throws {BrainReaderUnresolvedError} when the reader has no usable
 *   principals, for {@link loadFactOversight}'s reason.
 */
export async function loadWideningPreview(
  db: BrainCandidateReader,
  ctx: BrainPrincipalContext,
  requestId?: string,
): Promise<BrainFactWillWiden> {
  const workspaceId = ctx.workspaceId;
  const factAcl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });
  if (factAcl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(workspaceId, ctx.origin, OVERSIGHT_SURFACE);
  }

  // Spread into a fresh array: `AclClause.params` is a readonly tuple and the
  // reader's `query` takes `unknown[]`. The draft cap binds after the ACL's own
  // params, so its placeholder number is whatever the clause left free.
  const result = await db.query(willWidenRowsSql(factAcl.sql, factAcl.nextParamIndex), [
    ...factAcl.params,
    WILL_WIDEN_DRAFT_SCAN_MAX,
  ]);

  // Grouped in SQL's order, so the token order this discloses is the token
  // order publish will store — `EVIDENCE_GRANTS_SQL` orders by the same two
  // columns for the same reason. A disclosure that listed `[org, audience:X]`
  // where the transaction writes `[audience:X, org]` is not wrong about the
  // outcome, but it is a difference a reviewer comparing the two would have to
  // explain to themselves.
  const drafts = new Map<
    string,
    { readonly label: string; readonly grant: StoredGrant; readonly evidence: (readonly unknown[])[] }
  >();
  let droppedRows = 0;
  /** Facts whose evidence list is known-incomplete — see the drop arm below. */
  const poisoned = new Set<string>();
  for (const raw of result.rows) {
    // ⚠️ These two arms drop WITHOUT poisoning, and the asymmetry against the
    // grant arm below is forced rather than chosen: poisoning needs a `fact_id`
    // to poison, and these are exactly the rows that failed to produce one. So
    // the "poison the whole fact, never just the row" rule stated below holds
    // for the arm that can identify its fact and CANNOT hold here.
    //
    // The residue is real and bounded: if one row of a multi-row fact lands here
    // while its siblings survive, that fact is evaluated against a partial
    // evidence list and its `added` is a SUBSET of the truth. What keeps it from
    // being the defect the poisoning exists to prevent is that `incomplete` is
    // still set (every arm increments `droppedRows`), so the panel drops the
    // confident headline and tells the reviewer to treat publishing as widening
    // more than is shown — the user-visible answer stays honest even though this
    // entry does not. Reachability is the other half: `fact_id` and `label` come
    // off the CTE and are constant per fact, so from Postgres this arm takes
    // either all of a fact's rows or none of them.
    if (typeof raw !== "object" || raw === null) {
      droppedRows++;
      continue;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.fact_id !== "string" || typeof r.label !== "string") {
      droppedRows++;
      continue;
    }
    // BOTH grants must load as arrays. `visible_to text[] NOT NULL` (0180)
    // makes a non-array impossible from Postgres, so this is query drift — and
    // it is dropped rather than coerced to `[]`, in opposite directions for the
    // two columns and deliberately: an empty FACT grant would make every
    // evidence token look newly added (a fabricated disclosure), and an empty
    // EVIDENCE grant would make a real widening vanish (a false all-clear). The
    // warn below is the only honest response to either.
    //
    // ⚠️ A `null` `evidence_grant` is NOT drift — it is the LEFT JOIN reporting
    // that this draft has no `provenance` edge. `visible_to` is `NOT NULL`, so
    // the two are distinguishable, and they must be: an evidence-less draft is
    // an ordinary, common shape that must still COUNT toward the scan bound.
    // Read ONCE into a narrowed local. `r.evidence_grant` is `unknown`, and a
    // second read of the same property does not carry the guard's narrowing —
    // which is how an unchecked value would reach `widenGrantFromEvidence`.
    const evidence: readonly unknown[] | null = isUnknownArray(r.evidence_grant)
      ? r.evidence_grant
      : null;
    const noEvidence = r.evidence_grant === null;
    if (!isUnknownArray(r.fact_grant) || (!noEvidence && evidence === null)) {
      droppedRows++;
      // ⚠️ POISON the whole fact, never just the row. `fact_id`, `label` and
      // `fact_grant` are constant per fact (they come off the CTE), but
      // `evidence_grant` is one value PER ROW — so dropping a single row and
      // keeping the rest evaluates the draft against a PARTIAL evidence list and
      // produces an `added` that is a SUBSET of the real one. That is a LISTED
      // entry with an under-stated token list, which `willWidenRowsSql`'s own
      // header calls "strictly worse than not listing the draft at all", and
      // which `BrainFactWillWiden.incomplete` promises does not happen ("that
      // draft is missing from `entries` AND from `total`").
      //
      // The transaction's `groupEvidenceGrants` skips instead, and is right to:
      // there a short list publishes the fact NARROWER, which is fail-closed. In
      // a PREVIEW the sign flips — it under-states a widening the transaction
      // will then perform in full.
      // No `typeof` re-check: the arm above already `continue`d on a non-string
      // `fact_id` and TS has narrowed it here. Re-testing read as if the
      // invariant were uncertain at the one place it is proven.
      poisoned.add(r.fact_id);
      continue;
    }
    const existing = drafts.get(r.fact_id);
    if (existing) {
      if (evidence !== null) existing.evidence.push(evidence);
      continue;
    }
    drafts.set(r.fact_id, {
      label: r.label,
      // Narrowed to `StoredGrant` the way the adapter narrows it: a `text[]`
      // element off the driver is a string or `null`, and anything else is
      // coerced to `null` rather than passed through into an ACL computation.
      grant: r.fact_grant.map((token) => (typeof token === "string" ? token : null)),
      // An evidence-less draft is recorded with an EMPTY list rather than
      // skipped: `widenGrantFromEvidence(grant, [])` returns `null`, so it lists
      // nothing — and it still counts toward `drafts.size`, which is what makes
      // the scan-cap detector correct.
      evidence: evidence === null ? [] : [evidence],
    });
  }
  // The SCANNED count, read BEFORE the poison sweep below — which is the whole
  // reason it is a separate variable and not `drafts.size` at the point of use
  // (#5032, panel round 4).
  //
  // `scanCapped` asks "did the CTE return its whole `LIMIT`", and the LEFT JOINs
  // above exist so that `drafts` answers it. The sweep then makes `drafts.size`
  // mean something else — drafts scanned MINUS drafts poisoned — so reading it
  // afterwards re-broke the detector the joins were changed to fix: at exactly
  // `WILL_WIDEN_DRAFT_SCAN_MAX` scanned drafts with one poisoned, `scanCapped`
  // was `false` and the panel rendered a confident complete count over an
  // unevaluated tail. One variable later, the same defect, in the fix for it.
  //
  // It was masked rather than harmless: `incomplete` ORs in `droppedRows`, and
  // every poisoning implies a drop, so the wire looked right for a reason that
  // has nothing to do with the cap. An undocumented coupling one edit from
  // breaking is not a guard.
  //
  // ⚠️ **This line is UNFALSIFIABLE from the wire, and that is a property rather
  // than a missing fixture.** `poisoned.add` sits in the SAME branch as
  // `droppedRows++` — there is exactly one such branch — so a non-empty `poisoned`
  // implies `droppedRows > 0`. The sweep is the only thing that shrinks `drafts`
  // between here and the use, so the two readings differ only when something was
  // deleted, which requires a drop. `scanCapped` feeds nothing but
  // `incomplete: droppedRows > 0 || scanCapped`, so the differing input reports
  // `true` under both readings and there is no fourth wire field to leak through.
  //
  // Verified two ways rather than argued once: reverting this to `drafts.size` at
  // the point of use kills zero tests, and the four sharpest candidate fixtures
  // (`MAX` with 1 poisoned, with 10 poisoned, with a `fact_grant`-drift fact, and
  // `MAX+5` with 10 poisoned) return byte-identical envelopes under both readings.
  // Separating them needs a new wire field, which this disclosure does not need
  // and should not grow for a diagnostic.
  //
  // So it is held by the argument above and by this note, and a future edit that
  // makes the two readings distinguishable — a `scanCapped` on the wire, a
  // per-reason `incomplete` — should add the fixture at the same time.
  const scannedDrafts = drafts.size;
  // Applied AFTER the loop, so a fact poisoned by its third row is removed even
  // though its first two built a plausible entry.
  for (const factId of poisoned) drafts.delete(factId);
  if (droppedRows > 0) {
    // LOUD, because every drop UNDERSTATES this disclosure — the failure
    // direction is a reviewer publishing an ACL change they were not shown.
    log.warn(
      { workspaceId, requestId, droppedRows, kept: drafts.size },
      "brain oversight: will-widen rows came back with an unreadable column — the widening notice UNDERSTATES what publish will disclose; the query shape changed",
    );
  }

  const entries: BrainFactWillWidenEntry[] = [];
  for (const [factId, draft] of drafts) {
    // THE gate, and the one line that must stay `widenGrantFromEvidence`: a
    // reimplementation here — "the evidence has a token the fact lacks" — would
    // fire on malformed evidence tokens the transaction drops, and this notice
    // would list widenings that never happen.
    const widening = widenGrantFromEvidence(draft.grant, draft.evidence);
    if (widening === null) continue;
    entries.push({ factId, label: draft.label, added: widening.added });
  }

  const total = entries.length;
  // The scan cap is detected by counting the DRAFTS the statement returned, not
  // the rows: the CTE limits drafts, and one draft is many rows. `>=` rather
  // than `>` because the statement cannot exceed its own `LIMIT` — hitting it
  // exactly is the only observable, and the honest reading of "we stopped
  // looking" is that there may be more.
  const scanCapped = scannedDrafts >= WILL_WIDEN_DRAFT_SCAN_MAX;
  if (scanCapped) {
    // LOUD, for the `droppedRows` warn's reason and with more force. Every other
    // degradation in this file logs — bucket truncation, dropped bucket rows, the
    // count inversion, dropped will-widen rows, will-supersede window drift — and
    // this is the one that says *Atlas stopped looking at this workspace's
    // drafts*, on the only pre-publish ACL disclosure there is. Reaching the wire
    // as one bit of `incomplete` meant an operator could learn it only if an admin
    // happened to render the page and reported the wording.
    log.warn(
      { workspaceId, requestId, scannedDrafts, cap: WILL_WIDEN_DRAFT_SCAN_MAX },
      "brain oversight: the will-widen draft scan hit its cap — the widening notice UNDERSTATES what publish will widen for this workspace; the tail was never evaluated",
    );
  }
  return {
    total,
    // Capped AFTER the total is taken, so `total` is the real cardinality and
    // `truncated` is a statement about the LIST — never a number the client has
    // to infer from an array length.
    entries: entries.slice(0, WILL_WIDEN_ENTRY_MAX),
    // TWO signals, deliberately not one. `truncated` means the list is short and
    // `total` still counts the remainder; `incomplete` means Atlas could not
    // evaluate some drafts at all, so `total` understates too. They have
    // different remedies — paginate versus diff the query / treat publishing as
    // widening more than is listed — and a single boolean forces the UI to state
    // one of them unconditionally, which is a confident, specific, WRONG
    // explanation on the surface whose entire product is honest notice.
    truncated: total > WILL_WIDEN_ENTRY_MAX,
    incomplete: droppedRows > 0 || scanCapped,
  };
}
