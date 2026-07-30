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
 * `brain_episodes`. There is exactly ONE statement in this module that selects
 * claim content — `willSupersedePairsSql` (#4912) — and it is reader-scoped on
 * both of its aliases, so it can only show a reader claims their own ACL
 * already entitles them to read; see its header for why that does not breach
 * this rule.
 *
 * From the UNSCOPED aggregates, TWO non-numeric values reach the wire, and an
 * auditor must check both: `label`, only when {@link classifyToken} rules the
 * token disclosable; and `key`, which is that same token on the disclosable
 * arms and a positional handle (`discovered-N`) on the withheld one.
 * Everything else there is a number or a closed enum. `oversight.test.ts` pins
 * both, because a `z.strictObject` on the wire schema can reject an unexpected
 * KEY but cannot tell a channel id from a sentence. The third place an auditor
 * must now look is `loadSupersessionPreview`'s pairs (#4912) — fact ids and
 * SPO labels, sanctioned because they are READER-scoped on both sides, not
 * workspace-wide; see its header.
 *
 * ## Why the aggregate is deliberately NOT ACL-scoped
 *
 * Composing `aclVisibilityClause` here would be the obvious-looking move and
 * would destroy the surface: the reader's own subset is what
 * `/admin/brain-facts/summary` already reports, and a view that agreed with it
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
  parsePrincipal,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
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
