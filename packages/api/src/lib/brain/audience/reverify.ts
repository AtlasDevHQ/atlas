/**
 * The audience RE-VERIFIER seam (#4965) — how a source that is not Slack keeps
 * its audiences inside `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`.
 *
 * ## Why a seam rather than a second branch in `sync.ts`
 *
 * `runAudienceSyncCycle` is built around ONE source's shape: it scans
 * `slack-history` installs, reads a Slack directory, walks channel rosters, and
 * reconciles. Every step is Slack-specific, and the install scan is literally
 * parameterised by `SLACK_HISTORY_CATALOG_ID`. Adding a second `if` for Zoom
 * there would have doubled a 1,000-line function and made the third source
 * (Meet, Fireflies, email) a third branch.
 *
 * This is the same argument #4963 made for the CONNECTOR registry, applied to
 * the membership half: the cycle keeps the ONE thing every source shares — a
 * clock, isolation, and a place to report — and each source brings its own
 * re-verification. `sync.ts`'s edit is a registry drain, not a vendor branch.
 *
 * ## What a re-verifier is FOR, which is not what it sounds like
 *
 * "Re-verify" reads as "check whether the roster changed", and for a chat
 * channel that is exactly right. For a MEETING it is not: the participant list
 * is frozen the moment the meeting ends, and nobody joins a past meeting.
 *
 * The thing that changes is the RESOLUTION — which of those humans is an Atlas
 * user in this workspace right now. Someone leaves the org and must stop seeing
 * the meeting's facts; someone joins and should start. Both are membership
 * changes over an unchanged roster, and both are invisible unless something
 * re-runs the resolution.
 *
 * On top of that, `acl.ts` (#4808) suppresses any audience whose `synced_at` is
 * older than the staleness bound — default 168 hours. A meeting audience
 * written once at ingest and never touched again would therefore stop granting
 * a week later, silently, with the facts still stored and the sync still green.
 * That is the failure this seam exists to prevent, and it is the reason a
 * re-verifier is NOT optional for a source that mints `audience:` grants.
 *
 * ## The contract
 *
 * A re-verifier must be COMPLETE-OR-ABORT per audience, exactly as `sync.ts`
 * is: `reconcileAudienceMembership` deletes everyone outside the roster it is
 * handed, so a partial read revokes what it failed to fetch. Aborting touches
 * nothing and the previous membership stands. It must never throw — the cycle
 * isolates and counts, and a throw would cost the other sources their pass.
 *
 * ## And the CANDIDATE SCAN, which is shared rather than per-source (#4971)
 *
 * {@link selectReverifyCandidates} answers "which of my audiences do I look at
 * this cycle, and in what order". It lives here and not in a connector because
 * the ordering is a fairness property of the seam, not vendor knowledge — see
 * its own docstring for why the previous per-source copies starved their tails
 * and why fixing that twice was the thing #4971 was filed to prevent.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { AUDIENCE_PREFIX } from "@atlas/api/lib/brain/acl";

const log = createLogger("brain.audience.reverify");

/** What one re-verification pass accomplished. Summed into the cycle's report. */
export interface AudienceReverifyResult {
  /** Audiences whose membership was re-reconciled (including no-op re-stamps). */
  readonly reconciled: number;
  /** Audiences that aborted — a fault, an incomplete read; membership unchanged. */
  readonly failed: number;
  readonly membersAdded: number;
  readonly membersRevoked: number;
  /** Source principals that matched no Atlas user. Counted, never guessed. */
  readonly principalsUnresolved: number;
}

export const ZERO_REVERIFY: AudienceReverifyResult = Object.freeze({
  reconciled: 0,
  failed: 0,
  membersAdded: 0,
  membersRevoked: 0,
  principalsUnresolved: 0,
});

/**
 * One source's re-verification pass.
 *
 * Still takes no arguments, and #4971 sharpened rather than changed that. The
 * original claim was that "which audiences are mine and which are stalest" is
 * source-specific knowledge the seam keeps out of the cycle. Half of that was
 * wrong: WHICH ARE MINE is genuinely source-specific (a token prefix, a stored
 * source kind, a per-cycle cap), but WHICH ARE STALEST never was — both shipped
 * sources wrote the same ordering, and both inherited the same starvation from
 * it. That half now lives in {@link selectReverifyCandidates}, which a
 * re-verifier CALLS with its own three parameters.
 *
 * So the argument list stays empty because nothing here needs to reach a
 * re-verifier: the cycle still knows only "run it and sum the counts". A
 * re-verifier that needed the cycle to hand it something would deserve an
 * argument; one that needs a shared query deserves a shared function, which is
 * what it got.
 *
 * It must not throw — the drain catches anyway, but a re-verifier that relies on
 * that is one whose per-audience isolation is missing.
 */
export type AudienceReverifier = () => Promise<AudienceReverifyResult>;

/** `source` (the stored `brain_episodes.source` kind) → its re-verifier. */
const registry = new Map<string, AudienceReverifier>();

/**
 * Register a source's audience re-verifier. Called once per source at wiring
 * time, keyed by the stored source kind so a duplicate registration is a loud
 * error rather than a silent overwrite — two re-verifiers for one source would
 * each reconcile against their own roster, and the loser's members would be
 * revoked on every cycle.
 */
export function registerAudienceReverifier(source: string, reverifier: AudienceReverifier): void {
  if (registry.has(source)) {
    throw new Error(`Audience re-verifier for source "${source}" is already registered`);
  }
  registry.set(source, reverifier);
}

export function listAudienceReverifierSources(): string[] {
  return [...registry.keys()];
}

/**
 * Run every registered re-verifier and sum the results.
 *
 * Each is isolated: one source's failure costs it its own pass and nothing
 * else. A throw is counted as a single failed audience rather than swallowed,
 * because `failed > 0` is what makes the cycle report `degraded` — a
 * re-verifier that died must not leave the cycle looking clean.
 */
export async function runRegisteredAudienceReverifiers(): Promise<AudienceReverifyResult> {
  let total = ZERO_REVERIFY;
  for (const [source, reverifier] of registry) {
    try {
      const out = await reverifier();
      total = {
        reconciled: total.reconciled + out.reconciled,
        failed: total.failed + out.failed,
        membersAdded: total.membersAdded + out.membersAdded,
        membersRevoked: total.membersRevoked + out.membersRevoked,
        principalsUnresolved: total.principalsUnresolved + out.principalsUnresolved,
      };
    } catch (err) {
      log.error(
        { source, err: err instanceof Error ? err.message : String(err) },
        "brain audience: a re-verifier threw past its own isolation — that source's audiences were not re-verified this cycle and will age toward the staleness bound",
      );
      total = { ...total, failed: total.failed + 1 };
    }
  }
  return total;
}

/** Test-only: clear the registry (tests register fixtures per-suite). */
export function _resetAudienceReverifiers(): void {
  registry.clear();
}

/* ════════════════════════════════════════════════════════════════════════════
 * THE CANDIDATE SCAN (#4971)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * What fraction of a cycle's cap is reserved for MEMBER-LESS audiences.
 *
 * The second residual `zoom/audience.ts` recorded: with `has_members DESC` as an
 * ABSOLUTE priority, a workspace whose member-bearing audiences alone fill the
 * cap defers the member-less ones forever — and those are exactly the audiences
 * the "a participant joined Atlas later" repair exists for. An all-external
 * meeting or a mail to five customers grants nobody today and can only start
 * granting if something re-runs its resolution.
 *
 * A tenth, so the priority survives: member-bearing audiences — the ones whose
 * suppression costs somebody access they have RIGHT NOW — still take nine slots
 * in ten, and the repair is slow rather than absent. Nothing is wasted when a
 * workspace has no member-less audiences: the reserve is a floor on their share,
 * not a hold on the cap. See {@link REVERIFY_CANDIDATES_SQL}'s tiering.
 */
export const MEMBERLESS_RESERVE_FRACTION = 0.1;

/**
 * The per-workspace candidate scan, STALEST-ATTEMPT FIRST — one implementation
 * for every source (#4971).
 *
 * ## What was wrong with the per-source copies
 *
 * `zoom/audience.ts` (#4965) and `outlook/audience.ts` (#4966) each carried a
 * near-identical scan differing only in a `LIKE` prefix and a source kind, and
 * both ordered on `MIN(fact_audience_member.synced_at)`. Only a SUCCESSFUL
 * reconcile advances that column — by design, since it is the evidence
 * `acl.ts`'s staleness bound reads — so an audience that ABORTS every cycle
 * never rotates. It holds a slot at the front of the scan indefinitely, and past
 * the cap of them the scan returns the identical rows every cycle: no other
 * audience is re-verified at all, they all cross
 * `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`, and their facts go invisible while
 * the cycle reports `degraded` at worst.
 *
 * Both sources have a routine way to get there. Zoom's past-meeting participant
 * report ages out of retention, so old meetings abort forever; Outlook's mailbox
 * access is revocable in one Exchange admin action, which fails every audience
 * minted from that mailbox at once.
 *
 * ## The fix, and why it is a separate table
 *
 * Order on ATTEMPT, not on success. `brain_audience_reverify_attempt` (0186) is
 * stamped for every audience this scan hands back — before any vendor call, for
 * every outcome including the aborts — and the ordering keys on it. A
 * permanently-failing audience consumes one slot, rotates to the back, and the
 * next cycle reaches past it.
 *
 * The stamp is NOT a column on `fact_audience_member`, for two reasons that both
 * matter. Structurally, a member-less audience has no row there to stamp, and
 * those are the audiences most in need of rotating. Semantically, `synced_at`
 * means LAST VERIFIED and is read as evidence; a stamp that advanced on an abort
 * would fake a verification and keep a revoked grant alive past the bound. Two
 * tables makes that impossible rather than merely discouraged.
 *
 * ## The ordering, which is now three tiers and not two keys
 *
 * Membership stays the priority — an audience granting somebody real access is
 * worth more of a short cycle than one granting nobody — but it is expressed by
 * TIER PREDICATES rather than by the plain `has_members DESC` key the per-source
 * scans used, and it is no longer ABSOLUTE. Absolute priority is the second
 * residual #4971 names: member-less audiences deferred indefinitely, so the
 * "someone joined Atlas later" repair never runs. So:
 *
 *   1. member-bearing audiences, up to `limit - reserve` of them, stalest first;
 *   2. then the reserved member-less slice, up to `reserve` of them;
 *   3. then everything else, stalest first.
 *
 * `LIMIT` cuts tier 3, so a workspace with no member-less audiences spends the
 * whole cap on tier 1 + tier 3 — the reserve costs nothing when there is nothing
 * to reserve for. `row_number()` is computed per group over the SAME
 * attempt-time order the final sort uses, so the tiers slice the rotation rather
 * than fight it.
 *
 * ⚠️ Tier 3 carries NO `has_members` key, and adding one back would be adding
 * dead code rather than restoring a safeguard. The priority lives entirely in
 * the two tier predicates: they admit `limit - reserve` and `reserve` rows
 * respectively, which is exactly `limit`, so whenever both are full `LIMIT` cuts
 * before tier 3 contributes anything. Tier 3 is reached only when tier 1 took
 * EVERY member-bearing audience there was, which leaves it holding member-less
 * rows alone. A sort key there can never observe a mix and no test can cover it.
 *
 * ## The rest of the shape, carried over deliberately
 *
 * Sourced from `brain_episodes.visible_to`, not from `fact_audience_member`:
 * membership is the thing being repaired, so scanning the membership table would
 * make every member-less audience invisible to the pass meant to repair it. It
 * also means only LIVE audiences are scanned, which is what keeps the orphan
 * rows both connectors document (a de-duplicated message, a post-membership
 * skip) from costing a cycle.
 *
 * `starts_with(tok, $3)` rather than the `LIKE $3` the per-source copies used.
 * Same result for today's prefixes and no escaping question: `_` is a LIKE
 * wildcard, so a future namespace containing one would silently over-match and
 * hand a re-verifier another source's audiences to reconcile.
 *
 * `MIN(m.synced_at)` is gone from the ORDER BY but the LEFT JOIN stays, because
 * `has_members` is derived from it and `zoom/audience.ts` reads that flag to tell
 * a legally-empty roster from an unreadable one.
 *
 * Exported so the real-Postgres test executes this exact string —
 * `audience-sync-pg.test.ts` does, which closes the coverage gap both per-source
 * copies declared in their own docstrings.
 */
export const REVERIFY_CANDIDATES_SQL = `
  WITH tokens AS (
    SELECT DISTINCT tok AS token
      FROM brain_episodes e, unnest(e.visible_to) AS tok
     WHERE e.workspace_id = $1
       AND e.source = $2
       AND starts_with(tok, $3)
  ),
  scored AS (
    SELECT t.token AS token,
           count(m.user_id) > 0 AS has_members,
           MIN(a.attempted_at) AS attempted_at
      FROM tokens t
      LEFT JOIN fact_audience_member m
        ON m.workspace_id = $1
       AND m.audience_id = substr(t.token, length($4) + 1)
      LEFT JOIN brain_audience_reverify_attempt a
        ON a.workspace_id = $1
       AND a.audience_id = substr(t.token, length($4) + 1)
     GROUP BY t.token
  ),
  ranked AS (
    SELECT token,
           has_members,
           attempted_at,
           row_number() OVER (PARTITION BY has_members
                                  ORDER BY attempted_at ASC NULLS FIRST, token ASC) AS rn
      FROM scored
  )
  SELECT token, has_members
    FROM ranked
   ORDER BY (has_members AND rn <= $5::int - $6::int) DESC,
            ((NOT has_members) AND rn <= $6::int) DESC,
            attempted_at ASC NULLS FIRST,
            token ASC
   LIMIT $5::int
` as const;

/**
 * Stamp "this audience had its turn" for a whole page in one statement.
 *
 * ON SELECTION, not per outcome — the single most load-bearing decision in this
 * fix. The alternative is a stamp inside each of the re-verifiers' abort
 * branches, of which there are six across the two connectors today and more with
 * every source; one forgotten branch silently restores the exact starvation
 * #4971 is about, and it restores it invisibly, because a scan that never
 * rotates looks identical to a scan with nothing to do. Stamping the page the
 * moment it is handed out makes the omission unrepresentable: there is no code
 * path from "selected" to "attempted" that could skip it.
 *
 * Which fixes what the column MEANS, and the name has to be read that way:
 * `attempted_at` records that the audience consumed one of the cycle's slots,
 * not that any vendor call was made. That is the property the ordering needs —
 * fair-share rotation is about slot consumption — and it is deliberately weaker
 * than evidence. Nothing but the ORDER BY reads it, and nothing should.
 *
 * `now()` is transaction time, so a whole page shares one instant and the
 * within-page tie-break falls through to `token ASC`, which is stable.
 *
 * `source` is refreshed on conflict rather than kept from the first insert: the
 * column answers "which re-verifier owns this audience" for an operator staring
 * at a stalled rotation, and the current answer is more useful than the original
 * one. It cannot change in practice — audience ids are source-namespaced — so
 * this is about which fact is recorded, not about a real transition.
 */
export const TOUCH_REVERIFY_ATTEMPT_SQL = `
  INSERT INTO brain_audience_reverify_attempt (workspace_id, audience_id, source, attempted_at)
       SELECT $1, unnest($2::text[]), $3, now()
  ON CONFLICT (workspace_id, audience_id)
    DO UPDATE SET attempted_at = now(), source = EXCLUDED.source
` as const;

/** The DB surface the scan needs. Injectable so a test needs no live Postgres. */
export interface ReverifyScanDeps {
  readonly query?: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
}

export interface ReverifyCandidateScan {
  readonly workspaceId: string;
  /** The stored `brain_episodes.source` kind — this re-verifier's own. */
  readonly source: string;
  /**
   * The grant token prefix that identifies this source's audiences, INCLUDING
   * the `audience:` prefix — e.g. `audience:meeting:` for Zoom.
   *
   * Matched with `starts_with`, so metacharacters are not a concern.
   *
   * ⚠️ NAMESPACE-wide, not vendor-wide, and both shipped callers pass it that
   * way. The scan is deliberately COARSER than each source's audience-id parser,
   * so a `meeting:` token belonging to another vendor still comes back — and the
   * caller's parse check logs it rather than passing over it in silence.
   * Narrowing this to `audience:meeting:zoom:` would look tidier and would turn
   * that diagnostic into a silent skip.
   */
  readonly tokenPrefix: string;
  /** This source's per-workspace per-cycle cap. */
  readonly limit: number;
}

/** One audience this cycle should attempt. */
export interface ReverifyCandidate {
  /** The grant token as stored in `visible_to`, WITH the `audience:` prefix. */
  readonly token: string;
  /** The same id WITHOUT the prefix — what `fact_audience_member` is keyed on. */
  readonly audienceId: string;
  /**
   * Whether the audience currently grants anybody.
   *
   * Read by `zoom/audience.ts` to tell a legally-empty roster (an all-external
   * meeting) from an unreadable one. `outlook/audience.ts` deliberately does not
   * read it — an email's headers are immutable, so no zero-participant read is
   * ever legal there.
   */
  readonly hasMembers: boolean;
}

interface CandidateRow extends Record<string, unknown> {
  readonly token: string;
  readonly has_members: boolean;
}

/**
 * The audiences this source should attempt this cycle — scanned AND stamped.
 *
 * One function does both on purpose. Returning candidates without stamping them
 * is the bug (#4971); splitting the two into a scan a caller may forget to pair
 * with a stamp would put that bug one omission away in every future source. A
 * caller physically cannot obtain a candidate it has not consumed a slot for.
 *
 * THROWS if either statement fails, and the caller counts the workspace as
 * failed. Deliberately not "scan succeeded, stamp failed, carry on": attempting
 * a page without rotating it is precisely the starvation this exists to remove,
 * so a page that cannot be stamped must not be worked. It is also the cheaper
 * failure — both writes go to the internal DB that `reconcileAudienceMembership`
 * needs, so a stamp that cannot be written is a page whose reconciles would all
 * fail anyway, after a full page of vendor calls.
 */
export async function selectReverifyCandidates(
  input: ReverifyCandidateScan,
  deps: ReverifyScanDeps = {},
): Promise<readonly ReverifyCandidate[]> {
  const query = deps.query ?? internalQuery;
  // At least one slot, and never the whole cap: a reserve that swallowed the cap
  // would invert the priority and starve the member-BEARING audiences instead,
  // which is the failure with real access behind it. Both ends are clamped
  // rather than trusted because `limit` is a per-source constant a connector can
  // change without ever reading this function.
  const reserve = Math.min(
    Math.max(1, Math.floor(input.limit * MEMBERLESS_RESERVE_FRACTION)),
    Math.max(0, input.limit - 1),
  );
  const prefix = input.tokenPrefix;
  const rows = await query<CandidateRow>(REVERIFY_CANDIDATES_SQL, [
    input.workspaceId,
    input.source,
    prefix,
    AUDIENCE_PREFIX,
    input.limit,
    reserve,
  ]);
  if (rows.length === 0) return [];

  const candidates = rows.map((row) => ({
    token: row.token,
    audienceId: row.token.slice(AUDIENCE_PREFIX.length),
    hasMembers: row.has_members,
  }));
  await query(TOUCH_REVERIFY_ATTEMPT_SQL, [
    input.workspaceId,
    candidates.map((candidate) => candidate.audienceId),
    input.source,
  ]);
  return candidates;
}
