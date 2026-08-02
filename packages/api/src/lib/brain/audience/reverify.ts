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
import type { EpisodeSource } from "@atlas/api/lib/brain/sources";

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
 * re-verifier CALLS with the three things that did stay source-specific: its
 * source kind, its token prefix, and its cap.
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
const registry = new Map<EpisodeSource, AudienceReverifier>();

/**
 * Register a source's audience re-verifier. Called once per source at wiring
 * time, keyed by the stored source kind so a duplicate registration is a loud
 * error rather than a silent overwrite — two re-verifiers for one source would
 * each reconcile against their own roster, and the loser's members would be
 * revoked on every cycle.
 */
export function registerAudienceReverifier(
  source: EpisodeSource,
  reverifier: AudienceReverifier,
): void {
  if (registry.has(source)) {
    throw new Error(`Audience re-verifier for source "${source}" is already registered`);
  }
  registry.set(source, reverifier);
}

/**
 * Is a re-verifier already registered for this source?
 *
 * Exists so a paired registration can ASK before it commits anything. A source
 * and its re-verifier are written to two different registries, and
 * {@link registerAudienceReverifier} throws on a duplicate — so a caller that
 * registers the connector first and discovers the collision second leaves the
 * connector registered and the re-verifier absent. That half-state ingests
 * content whose grants stop being re-verified, which is silent for a week and
 * then indistinguishable from the content not existing. See
 * `registerBrainSourceWithAudienceReverifier` in `ingest/types.ts`, which is the
 * only thing that should need this.
 */
export function hasAudienceReverifier(source: EpisodeSource): boolean {
  return registry.has(source);
}

export function listAudienceReverifierSources(): EpisodeSource[] {
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
 * The second residual the pre-fix `zoom/audience.ts` header recorded against
 * #4971: with `has_members DESC` as an
 * ABSOLUTE priority, a workspace whose member-bearing audiences alone fill the
 * cap defers the member-less ones forever — and those are exactly the audiences
 * the "a participant joined Atlas later" repair exists for. An all-external
 * meeting or a mail to five customers grants nobody today and can only start
 * granting if something re-runs its resolution.
 *
 * A tenth of the cap ROUNDED DOWN, and never the whole cap — so at the shipped
 * cap of 200 it is exactly 20, at 25 it is 2 (8%, not 10%), and at a cap of 1 it
 * is 0, because starving the member-BEARING side is the worse failure. The
 * priority survives: audiences whose suppression costs somebody access they have
 * RIGHT NOW keep the large majority of every cycle, and the repair is slow
 * rather than absent.
 *
 * Nothing is wasted when a workspace has no member-less audiences: this is a
 * FLOOR on their share, not a quota against the cap, so where member-bearing
 * audiences do not fill the rest the member-less ones take the remainder too.
 * See {@link REVERIFY_CANDIDATES_SQL}'s tiering.
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
 * residual — see {@link MEMBERLESS_RESERVE_FRACTION}, which states it in full.
 * So:
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
 * the two tier predicates, and tier 3 is HOMOGENEOUS whenever it is reached: a
 * mix needs both tiers over-subscribed at once, and then they admit
 * `limit - reserve` and `reserve` rows — exactly `limit` — so `LIMIT` cuts
 * before tier 3 contributes anything. When tier 3 does contribute, whichever
 * pool overflowed its slice supplies every one of its rows: member-bearing
 * leftovers when the member-less pool is smaller than the reserve, member-less
 * leftovers when tier 1 took every member-bearing audience there was. Either
 * way a sort key there cannot observe a mix, and no test could cover it.
 *
 * ## The rest of the shape, carried over deliberately
 *
 * Sourced from `brain_episodes.visible_to`, not from `fact_audience_member`:
 * membership is the thing being repaired, so scanning the membership table would
 * make every member-less audience invisible to the pass meant to repair it. It
 * also means only LIVE audiences are scanned, which is what keeps orphan
 * membership rows from costing a cycle — see `outlook/audience.ts`'s token-prefix
 * note, the one place that class is documented (a de-duplicated message, a
 * post-membership skip). Zoom does not mint them.
 *
 * `starts_with(tok, $3)` rather than the `LIKE $3` the per-source copies used.
 * Same result for today's prefixes and no escaping question: `_` is a LIKE
 * wildcard, so a future namespace containing one would silently over-match and
 * hand a re-verifier another source's audiences to reconcile.
 *
 * `MIN(m.synced_at)` is gone from the ORDER BY but the LEFT JOIN stays, because
 * `has_members` is `count(m.user_id) > 0` and needs that join. `zoom/audience.ts`
 * reads the flag to tell
 * a legally-empty roster from an unreadable one.
 *
 * ⚠️ Exported for TESTS only — the unit suites route their `query` doubles by
 * statement IDENTITY rather than by call order, which needs the string. A
 * production caller must go through {@link selectReverifyCandidates}: running
 * this SQL directly is a scan with no attempt stamp, which is #4971 itself.
 * `audience-sync-pg.test.ts` executes it against the live schema through that
 * function, closing the coverage gap both per-source copies declared.
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
           -- MIN is a GROUP BY formality: 0186's PK makes the attempt row
           -- unique per audience, and the fan-out being aggregated over is the
           -- MEMBERSHIP join's. Not the "as verified as its least recent row"
           -- reading that MIN(m.synced_at) carried.
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
            -- Redundant against the window's identical key WHENEVER the planner
            -- preserves its output order, which is why no fixture can observe
            -- it: every tier is homogeneous in has_members, so two rows tied
            -- here came from one window partition and already arrive in
            -- (attempted_at, token) order. It stays because that redundancy
            -- rests on sort STABILITY, which Postgres does not promise. The
            -- window's copy is the one under test -- audience-sync-pg.test.ts
            -- runs the scan with enable_sort = off to reach the plan where a
            -- tie is decidable at all.
            token ASC
   LIMIT $5::int
` as const;

/**
 * Stamp "this audience had its turn" for a whole page in one statement.
 *
 * ON SELECTION, not per outcome — the single most load-bearing decision in this
 * fix. The alternative is a stamp inside every branch that ends without a
 * reconcile, of which the two connectors have TEN today (Zoom: unparseable
 * token, incomplete roster, empty-roster refusal, `catch`; Outlook: those first
 * two shapes plus message-absent, digest mismatch, empty participants, `catch`)
 * — and more with every source. One forgotten branch silently restores the exact
 * starvation #4971 is about, and the `catch` arms are the ones that get
 * forgotten. It restores it invisibly, too, because a scan that never rotates
 * looks identical to a scan with nothing to do. Stamping the page the moment it
 * is handed out makes the omission unrepresentable: there is no code path from
 * "selected" to "returned" that could skip it.
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

/**
 * A token prefix that provably carries the grant prefix.
 *
 * Not decoration, but be precise about which failure it prevents — the obvious
 * example is the harmless one. `$3` is the caller's prefix and `$4` is hardcoded
 * to `AUDIENCE_PREFIX`, so a prefix-less `meeting:` simply matches NOTHING
 * (`starts_with("audience:meeting:…", "meeting:")` is false) and the source goes
 * quietly dead — bad, and the `log.debug` below is about it.
 *
 * The corrupting case is a prefix-less value that DOES match, and `visible_to`
 * offers several: `org`, `role:*`, `user:*` all live in the same array. With
 * `tokenPrefix: "user:"` the scan returns real tokens, `substr(token, 10)`
 * chops nine characters off strings that never had the grant prefix, and every
 * derived `audienceId` is garbage — membership written under a key `acl.ts`
 * never matches, `has_members` false for everything, the cycle reporting
 * `reconciled` while the facts go invisible. The slice also stops being
 * injective there, so two tokens can collapse to one id and the stamp's
 * `ON CONFLICT` aborts the whole statement.
 *
 * A template-literal type costs nothing and makes the whole class unreachable.
 * ⚠️ Call sites need `as const` on the template string — without it TS widens
 * the interpolation to `string` and the assignment is rejected.
 */
export type AudienceTokenPrefix = `${typeof AUDIENCE_PREFIX}${string}`;

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
  readonly tokenPrefix: AudienceTokenPrefix;
  /** This source's per-workspace per-cycle cap. A positive integer. */
  readonly limit: number;
}

/** One audience this cycle should attempt. */
export interface ReverifyCandidate {
  /**
   * The audience id WITHOUT the `audience:` prefix — what `fact_audience_member`
   * is keyed on, and what every caller passes to `reconcileAudienceMembership`.
   *
   * The prefixed form is deliberately NOT carried alongside it. It had no
   * consumer, and two near-identical strings differing only by a nine-character
   * prefix is precisely the pair a caller mixes up: `reconcile({ audienceId:
   * candidate.token })` would compile, write membership under a key `acl.ts`
   * never matches, and report `reconciled` while the facts stayed invisible.
   * `AUDIENCE_PREFIX + audienceId` reconstructs it if anything ever needs it.
   */
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
  // `LIMIT 0` is a page of nothing, which this function cannot tell from a
  // healthy idle workspace and which would therefore switch a source's
  // re-verification off in total silence — #4971's outcome, from a typo. The
  // type stops a bad `tokenPrefix`; nothing but this stops a bad cap.
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new Error(
      `brain audience: re-verify cap for source "${input.source}" must be a positive integer, got ${input.limit}`,
    );
  }
  // Never the whole cap, and at least one slot wherever the cap leaves room for
  // one. At `limit === 1` the second clamp wins and the reserve is 0, which is
  // the right way round: inverting the priority starves the member-BEARING
  // audiences, and those are the ones with somebody's live access behind them.
  // Clamped rather than trusted because `limit` is a per-source constant whose
  // owner never reads this function.
  const reserve = Math.min(
    Math.max(1, Math.floor(input.limit * MEMBERLESS_RESERVE_FRACTION)),
    input.limit - 1,
  );
  const rows = await query<CandidateRow>(REVERIFY_CANDIDATES_SQL, [
    input.workspaceId,
    input.source,
    input.tokenPrefix,
    AUDIENCE_PREFIX,
    input.limit,
    reserve,
  ]);
  if (rows.length === 0) {
    // Expected for an idle workspace, and also the signature of a source wired
    // with the wrong `source` kind — "I scanned and found nothing" and "this
    // workspace has nothing" are the same empty array, so the two are
    // indistinguishable here.
    //
    // `debug`, so this is OFF on a default deploy (`ATLAS_LOG_LEVEL` defaults to
    // `info`) — do not read it as a live guard against the mis-wiring. What
    // actually prevents that is a test per connector asserting the exact
    // `source` and `tokenPrefix` this seam is called with, which fails in CI
    // rather than after a week of silent staleness. This line is for an
    // operator who has already turned debug on to ask "is my source scanning?".
    log.debug(
      { workspaceId: input.workspaceId, source: input.source, tokenPrefix: input.tokenPrefix },
      "brain audience: the re-verify scan matched no live audiences",
    );
    return [];
  }

  const candidates = rows.map((row) => ({
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
