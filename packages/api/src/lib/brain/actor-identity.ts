/**
 * The vendor handle on a claim, resolved to a PERSON (#5440, ADR-0036 §T5
 * `Amendment (2026-08-25, #5440)`).
 *
 * Finish condition 2 reads *"every authoritative claim has a human name on
 * it… you can point at THE PERSON"*. `provenance.actor` holds
 * `slack:U0AQW6KF2EM`, and until this module nothing in the record mapped it to
 * anybody: the audience resolver matches source emails against users Atlas
 * already has and, by design, persists nothing about the ones it does not.
 *
 * ## Read the amendment first
 *
 * This module PERSISTS a directory snapshot for people who are not Atlas users.
 * That reverses a documented privacy posture, and the argument for it is
 * ADR-0036 §T5's amendment and `audience/resolver.ts`'s "THE POSTURE MOVED"
 * header — not this file. What is settled there and is not re-derivable from
 * the code: the bound is AUTHORSHIP (not the roster), the name rides #4836's
 * attribution gate and gains none of its own, snapshots travel on the region
 * bundle, and erasure returns a claim to `opaque` rather than deleting it.
 *
 * ## The three states, and why not a nullable id
 *
 * The rejected design was `provenance.actorUserId` — the resolved Atlas user
 * id, joined live for an always-current name. It attributes the MINORITY.
 * Measured in us prod on a four-person dogfood workspace (the most favourable
 * case available): 4 Atlas users, 1 resolved audience member, 2 distinct source
 * actors already producing claims. Contractors, guests, people who never signed
 * up and people who have left all speak in ingested channels, and the SSO-domain
 * narrowing REFUSES to resolve a guest on a personal address rather than guess.
 *
 * A nullable id also collapses two different facts into one NULL — *not yet
 * resolved* (transient) and *resolved, no Atlas account* (permanent, and a
 * legitimate state of a real person). Migration 0187's header names that
 * conflation on slot keys. So:
 *
 *   `atlas`     — a live join to `"user"`. Renaming the account changes every
 *                 surface with no re-ingest. NOTHING is snapshotted.
 *   `directory` — a DATED snapshot, because there is no live join to make.
 *   `opaque`    — Atlas cannot name them, and the record says so.
 *
 * ## Two handles are answered from the HANDLE, with no stored row (#5454)
 *
 * The table above exists for one population: **someone with no Atlas account,
 * named by a vendor's directory.** Two of the handles in the record are not
 * that, and #5454 found both rendering `opaque` — a positive claim that Atlas
 * looked for a person and could not name them, and false in both cases.
 *
 *   `user:<id>`   — the correction lane. `correctFact` stamps
 *                   `` `user:${ctx.userId}` `` as the replacement claim's
 *                   `provenance.actor`, so the payload after the colon IS a
 *                   `"user".id`. There is a live join to make, and it is the
 *                   same join the `atlas` arm makes — {@link derivableActor}
 *                   makes it without a row in between.
 *   `warehouse:…` — a machine. ADR-0042's producer is attributed to
 *                   `system:warehouse-producer` deliberately ("the honest
 *                   answer is the machine, because the machine is what read the
 *                   warehouse"), and there is no person to name. It renders
 *                   `machine`, not `opaque`.
 *
 * ⚠️ **Neither is a capture.** Nothing is written, nothing is snapshotted, no
 * directory is read, and no vendor is involved — so ADR-0036 §T5's amendment,
 * which reversed a privacy posture to persist a name Atlas would otherwise not
 * hold, does not reach either lane. That asymmetry is the whole argument for
 * deriving rather than capturing; `audience/identity-capture.ts`'s header
 * carries the rest of it, on the path a reader of the capture code will meet.
 *
 * ## Reading is by ACTOR and only by actor
 *
 * {@link loadActorIdentities} is the only read, it takes the handles a page of
 * claims already carries, and there is no query here that goes the other way.
 * ADR-0036: *"Nothing may query these rows to FIND a person; they are readable
 * only as the rendering of a specific claim's `actor`, under that claim's own
 * attribution gate."* Migration 0208 declines to index the name columns for the
 * same reason — an unsupported access path should not also be a cheap one.
 */

import type {
  BrainActorIdentityAtlas,
  BrainActorIdentityDirectory,
  BrainActorIdentityMachine,
  BrainActorIdentityOpaque,
  BrainActorIdentityView,
} from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import { USER_PREFIX } from "@atlas/api/lib/brain/acl";

/**
 * The prefix every non-human principal in this codebase carries.
 *
 * Not a grant-grammar prefix like {@link USER_PREFIX} — it never appears in an
 * ACL. It is the spelling the scheduler and producer lanes have used for every
 * actor they stamp, and the thing that makes "no person did this" readable off
 * the handle alone.
 */
const SYSTEM_PREFIX = "system:";
import {
  WAREHOUSE_CLASS,
  WAREHOUSE_SOURCES,
  episodeSourceArraySql,
  episodeSourceClassOf,
} from "@atlas/api/lib/brain/sources";

const log = createLogger("brain.actor-identity");

/**
 * The stored discriminator. Mirrors `ck_brain_actor_identity_state`;
 * `__tests__/actor-identity.test.ts` fails if the two drift.
 */
export const BRAIN_ACTOR_IDENTITY_STATES = ["atlas", "directory", "opaque"] as const;
export type BrainActorIdentityState = (typeof BRAIN_ACTOR_IDENTITY_STATES)[number];

/**
 * The one `opaque` value every non-answer degrades to.
 *
 * Frozen and shared rather than constructed per row: it is reached on the
 * commonest path by a wide margin (every claim on a workspace whose capture
 * pass has not run), and an accidental mutation of it would be a workspace-wide
 * wrong answer rather than a one-row one.
 */
export const OPAQUE_IDENTITY: BrainActorIdentityOpaque = Object.freeze({
  state: "opaque",
  erased: false,
});

/** The `opaque` arm an operator's erasure produces. */
const ERASED_IDENTITY: BrainActorIdentityOpaque = Object.freeze({
  state: "opaque",
  erased: true,
});

/**
 * The one `machine` value (#5454). Frozen and shared for {@link OPAQUE_IDENTITY}'s
 * reason: every warehouse claim in a workspace reaches it, so an accidental
 * mutation would be a corpus-wide wrong answer rather than a one-row one.
 */
export const MACHINE_IDENTITY: BrainActorIdentityMachine = Object.freeze({ state: "machine" });

// ---------------------------------------------------------------------------
// The SOURCE of a claim — one spelling, in SQL (#5487)
// ---------------------------------------------------------------------------

/**
 * The table aliases the SQL builders below may be spliced under.
 *
 * A closed union rather than `string`, and the reason is the one
 * {@link episodeSourceArraySql} states for its own splice: *"Nothing
 * user-supplied reaches it: every element is a compile-time key … validated at
 * this module's load."* These builders concatenate their argument straight into
 * SQL text, so the same guarantee has to be made here — and a literal union
 * makes the compiler the enforcement rather than a paragraph asking a future
 * caller to be careful. Add a member deliberately; never widen this to `string`.
 */
export type BrainSqlAlias = "e" | "ep" | "f";

/**
 * The authoring principal of an episode, in SQL — `NULL` when it has none.
 *
 * `` `${source}:${btrim(source_actor)}` ``, which is the SAME composition
 * {@link AUTHORING_PRINCIPALS_SQL} projects and `resolvedPrincipal`
 * (`reconcile.ts`) builds in TypeScript. It is a BUILDER rather than a literal
 * because #5487 gave the handle a third reader — the reviewer's corroboration
 * count — under a different table alias, and `AUTHORING_PRINCIPALS_SQL`'s own
 * header already names the failure a second spelling produces: *"a claim whose
 * handle does not match a captured row renders `opaque` silently, which is the
 * failure mode that would be hardest to notice."*
 *
 * ⚠️ `btrim` in BOTH the projection and the predicate, for that header's
 * reason: `resolvedPrincipal` trims, so an episode stored with
 * `source_actor = ' U123'` must compose `slack:U123` here too or the two never
 * join.
 *
 * `<> ''` after the trim rather than before it — `IS NOT NULL` alone admits
 * `' '`, which composes a handle naming nobody.
 */
export function authoringPrincipalSql(alias: BrainSqlAlias): string {
  return `CASE WHEN ${alias}.source_actor IS NOT NULL AND btrim(${alias}.source_actor) <> ''
                    THEN ${alias}.source || ':' || btrim(${alias}.source_actor)
               END`;
}

/**
 * The **distinct source** of a claim, in SQL — ADR-0036 §T9 lock 5's unit, and
 * the whole of #5487's definitional choice.
 *
 * ## The definition
 *
 * > A claim's **source** is its episode's authoring principal
 * > ({@link authoringPrincipalSql}), and only when that principal names a
 * > **person**. A MACHINE principal, and an episode with no principal at all,
 * > have NO distinct source: each such episode counts on its own.
 *
 * Three candidates were available and only one of them is the unit lock 5
 * names. **Episode** is what the count used to use and is the gap #5487
 * reports: two episodes from one person read as two corroborations. **Episode
 * source** (`slack`, `zoom`) and **source class** (`chat`, `email`) both
 * over-correct in the same direction and by a wide margin — every Slack user in
 * the workspace would collapse into one voice, which is not self-echo, it is
 * erasure of genuinely independent testimony. The **authoring principal** is
 * the unit that makes *"the same person saying the same thing on Monday and
 * again on Friday"* one and two different people two, which is the sentence
 * lock 5 is written in.
 *
 * ⚠️ This governs the **weighting only**, never whether a `provenance` edge is
 * written. `INSERT_PROVENANCE_EDGE_SQL`'s header carries that argument at
 * length: the edge set is also the decay anchor, the grant-widening input and
 * the audit record, and suppressing an edge to fix a counting bug breaks all
 * three. Lock 5 says the edge is added and the *weighting* is by source.
 *
 * ## Why a MACHINE is exempt, which is the part that is NOT obvious
 *
 * ⚠️ Without this arm the count is a REGRESSION, not a fix, and the shape of it
 * is worth stating: `warehouse-producer.ts` stamps every snapshot episode with
 * the SAME `source_actor` — the constant `WAREHOUSE_PRODUCER_PRINCIPAL` — so a
 * principal-keyed count with no machine arm reports **one** corroboration for
 * every warehouse reading a workspace has ever taken, permanently.
 *
 * The exemption is not a carve-out to dodge that; it is what self-echo MEANS.
 * Self-echo is a property of **testimony**: a person restating on Friday what
 * they said on Monday has told you nothing new, because the claim's warrant is
 * that they said it. A machine re-reading the world is not restating itself —
 * it is a fresh reading of a world that may have changed, and `reconcile.ts`
 * says so at the corroboration branch already: *"a warehouse re-read of the
 * same row, where 'one more piece of evidence' is exactly what the edge means"*.
 *
 * ## Machine is decided the way {@link derivableActor} decides it
 *
 * Deliberately the same test, and it reduces to ONE arm here. `derivableActor`
 * has two machine arms — the `system:` PREFIX and the warehouse CLASS — and a
 * composed `source:actor` handle can only ever take the second: the prefix arm
 * needs `source = 'system'`, and `system` is not in `EPISODE_SOURCE_SPECS` (nor
 * could it be — `sources.ts` refuses a member that is not a bare slug). So the
 * warehouse-source test below IS the machine test for every handle this builder
 * can produce.
 *
 * ⚠️ Membership in {@link WAREHOUSE_SOURCES} is POSITIVE evidence, and an
 * unrecognised `source` — `snowflake`, a value a region import restored
 * verbatim — is NOT machine and therefore keeps its principal. That inherits
 * `WAREHOUSE_SOURCES`' own three-population rule verbatim and it is the safe
 * direction here: the cost of wrongly calling a row machine is a corroboration
 * that never collapses (the pre-#5487 number), while the cost of wrongly
 * calling it human is a genuine second source silently suppressed.
 *
 * ## NULL is the abstain, and it abstains OUT
 *
 * Every arm that cannot answer yields SQL NULL, and the consumer is
 * NULL-hostile: {@link corroborationCountSql} keys such an episode on its own
 * id rather than merging it with another. That is the same posture
 * `TENSION_CANDIDATES_SQL` documents at length — *"a row with no identity
 * abstains OUT"* — and it is what makes this change safe on the existing
 * corpus: every episode whose source Atlas cannot attribute counts exactly as
 * it did before.
 */
export function distinctSourceSql(alias: BrainSqlAlias): string {
  return `CASE WHEN ${alias}.source <> ALL (${episodeSourceArraySql(WAREHOUSE_SOURCES)})
                    THEN ${authoringPrincipalSql(alias)}
               END`;
}

/**
 * How many DISTINCT SOURCES back a fact — the number lock 5 requires be
 * *"surfaced to the reviewer"*, and since #5487 the number that actually is.
 *
 * ## What it replaced, and why that was wrong
 *
 * `COUNT(DISTINCT ed.to_episode_id)`, written out three times (the review
 * queue, `searchBrain`, and the tension counterpart). That counts EPISODES. It
 * was described honestly in the type — *"DISTINCT provenance edges"* — and then
 * rendered to humans as **"Sources"** in five places, including the review
 * queue's own column header and the chat card's *"N sources"* caption. A
 * reviewer reading *"5 corroborating sources"* over five messages from one
 * person was reading an inflated number, which is the whole of #5487.
 *
 * ⚠️ This is the ONLY behaviour #5487 changes. The edges themselves are
 * untouched — see `INSERT_PROVENANCE_EDGE_SQL`'s header for why leaving them
 * alone is the deliberate half of the fix rather than the unfinished half.
 *
 * ## The COALESCE is the whole of the counting rule
 *
 * A source-less episode ({@link distinctSourceSql} NULL — a machine, an
 * unattributed row) counts as ITSELF, keyed on its own episode id, because
 * `COUNT(DISTINCT …)` drops NULLs outright and dropping them would report
 * **zero** sources for a fact whose entire evidence is warehouse snapshots.
 * Zero is a worse lie than the inflation this fixes: it reads as *unsupported*.
 *
 * The `edge:` prefix keeps the two key spaces disjoint for every `source` in
 * the vocabulary — no `EPISODE_SOURCE_SPECS` key is `edge`, and `sources.ts`
 * validates that set at load. ⚠️ Not an absolute, though:
 * `brain_episodes.source` carries no CHECK (a region import restores it
 * verbatim), so a row stored with `source = 'edge'` whose `source_actor` equals
 * some sibling episode's uuid would collide. That is the same
 * unrecognised-source residue the arm above records, and its price is one
 * merged key in one count rather than anything at rest.
 *
 * ## The JOIN, and what it costs
 *
 * `brain_episodes` is reached for `source`/`source_actor` only — neither is
 * projected, so this discloses strictly LESS about the evidence than the edge
 * count it replaces did (a coarser aggregate over the same rows), which is the
 * direction that matters on a read surface `staleness.ts` already notes
 * *"discloses a COUNT over the same edges to the same readers"*. It cannot drop
 * a row either: `fk_brain_edges_to_episode` is a composite FK, so a provenance
 * edge's episode provably exists. One unique-index probe
 * (`uq_brain_episodes_workspace_id`) per edge, after the same
 * `idx_brain_edges_from_fact` scan as before.
 *
 * Takes the FACT's alias because the three call sites correlate it differently
 * (`f` in the review queue and in search, an aliased inner `f` in the tension
 * counterpart) — which is also why it is now one builder rather than the three
 * near-identical literals it replaced. `distinct-source-corroboration-pg.test.ts`
 * runs this exact expression against real Postgres.
 */
export function corroborationCountSql(factAlias: BrainSqlAlias): string {
  return `(SELECT COUNT(DISTINCT COALESCE(${distinctSourceSql("ep")}, 'edge:' || ed.to_episode_id::text))
             FROM brain_edges ed
             JOIN brain_episodes ep
               ON ep.workspace_id = ed.workspace_id
              AND ep.id = ed.to_episode_id
            WHERE ed.workspace_id = ${factAlias}.workspace_id
              AND ed.edge_type = 'provenance'
              AND ed.from_fact_id = ${factAlias}.id)::int`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The read surfaces' shared `pg`-ish handle — same shape as `BrainCandidateReader`. */
export interface ActorIdentityReader {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: readonly unknown[]; rowCount?: number | null }>;
}

/**
 * Identity by actor, with the `atlas` arm's name joined LIVE.
 *
 * The `LEFT JOIN "user"` is what makes the `atlas` state mean what it claims:
 * the name is read at every request, so renaming an Atlas user changes the
 * review surface and `searchBrain` with no re-ingest and no backfill. A
 * snapshot in that state would have been strictly worse — stale, with no
 * re-derivation path — which is why the column does not exist.
 *
 * LEFT and not INNER: a `user_id` whose account has since been deleted must
 * come back as a row with a null name, so the projection can degrade it to
 * `opaque`. An INNER join would drop the row entirely and report the same
 * thing, but by accident — and it would silently start reporting `opaque` for a
 * live user the day someone scopes the join wrong.
 *
 * ⚠️ NO workspace scope on the `"user"` side, deliberately, and this is the one
 * place that needs saying. Better-Auth's `"user"` is global (ADR-0024), and
 * `user_id` here was written by the audience resolver, whose email join is
 * already `member`-scoped to the workspace in ONE SQL statement precisely so an
 * unscoped id can never be produced. Re-scoping here would be a second
 * implementation of that containment; checking the id's provenance at the write
 * is the enforcement.
 *
 * Exported so the real-Postgres test runs this exact string against the live
 * schema rather than a paraphrase of it.
 */
export const LOAD_ACTOR_IDENTITIES_SQL = `SELECT ai.actor,
              ai.state,
              ai.user_id,
              ai.display_name,
              ai.real_name,
              ai.email,
              ai.snapshot_at,
              ai.erased_at,
              u.name AS user_name,
              u.email AS user_email
         FROM brain_actor_identity ai
         LEFT JOIN "user" u ON u.id = ai.user_id
        WHERE ai.workspace_id = $1
          AND ai.actor = ANY($2::text[])`;

/**
 * The Atlas accounts named DIRECTLY by a `user:<id>` handle (#5454).
 *
 * The same `"user"` read the `atlas` arm's join makes, keyed on the id the
 * handle already carries instead of on a stored pointer — so the two states are
 * the same state, reached with one indirection fewer.
 *
 * ⚠️ **WORKSPACE-SCOPED through `member`, and an earlier draft was not.**
 *
 * That draft argued containment at the write: *"the id in this handle was
 * written by `correctFact`, which refuses every verb unless `ctx.role` is `owner`
 * or `admin` ON THIS WORKSPACE."* True of the correction lane, and `correctFact`
 * is not the only writer. `admin-migrate.ts` binds a region bundle's
 * `provenance` VERBATIM, and its only actor check is `bundleFactNamesAPerson` —
 * `typeof actor === "string" && actor.trim() !== ""`. A bundle carrying
 * `user:<foreign-id>` passes that, lands published, and an unscoped read of
 * Better-Auth's global `"user"` would then disclose that person's NAME AND EMAIL
 * to any reader entitled to `actor` in the importing workspace, with no
 * membership check anywhere.
 *
 * The stored path never had this hole — its row is `workspace_id`-scoped. So the
 * derived path is scoped the same way, mirroring
 * `RESOLVE_PRINCIPAL_EMAILS_SQL`'s `JOIN member m ON m."userId" = u.id` rather
 * than arguing its way out of one. A handle naming somebody who is not a member
 * here resolves to nothing and renders `opaque`, which is the honest answer:
 * Atlas cannot name them *to this reader*.
 *
 * Exported so the real-Postgres test runs this exact string.
 */
export const LOAD_DERIVED_ATLAS_USERS_SQL = `SELECT u.id,
              u.name,
              u.email
         FROM "user" u
         JOIN member m ON m."userId" = u.id
        WHERE m."organizationId" = $1
          AND u.id = ANY($2::text[])`;

/**
 * An identity readable from the HANDLE ITSELF, with no captured row (#5454).
 *
 * Both arms exist because the stored table answers ONE question — *what is this
 * vendor's directory name for a person who has no Atlas account* — and two
 * handles in the record are not asking it. Left to the table both came back
 * `opaque`: *Atlas looked for a person and could not name them*, which for a
 * `user:<id>` is false (the id IS the answer) and for a machine is false twice
 * over (there is nobody to name).
 *
 * `atlas-user` still needs the `"user"` read; `machine` needs no database at
 * all, which is why it holds on a deployment whose capture cycle has never run.
 */
export type DerivedActor =
  | { readonly kind: "atlas-user"; readonly userId: string }
  | { readonly kind: "machine" };

/**
 * What a handle says about itself, or `null` — the table has to answer.
 *
 * ## `user:` is the GRANT grammar's prefix, imported rather than respelled
 *
 * `correctFact` builds the handle as `` `${USER_PREFIX}${ctx.userId}` `` and
 * calls it a *"grammar-valid principal"*; this reads it back with the same
 * constant. Two spellings of one prefix is the failure
 * `AUTHORING_PRINCIPALS_SQL` (`audience/identity-capture.ts`) composes its handle in SQL to avoid — a
 * handle that does not match renders `opaque` SILENTLY, which is the hardest
 * failure mode here to notice.
 *
 * It cannot collide with a composed `${source}:${actor}` handle: `user` is not
 * in `EPISODE_SOURCES` and `sources.ts` refuses a member that is not a bare
 * slug, so no episode source can ever be spelled `user`. `actor-identity.test.ts`
 * pins that, because the day one is added this function starts naming the wrong
 * person rather than failing.
 *
 * ## `machine` is decided by the `system:` PREFIX, and by ADR-0036 class
 *
 * ⚠️ **An earlier draft of this function tested the class alone, and the arm was
 * dead on every real row.** It assumed the stored handle was
 * `warehouse:system:warehouse-producer`; it is not. `reconcile.ts` short-circuits
 * on an explicit principal *before* composing the `${source}:${actor}` prefix, and
 * `warehouse-producer.ts` passes `WAREHOUSE_PRODUCER_PRINCIPAL` — so what lands in
 * `provenance.actor` is the bare `system:warehouse-producer`. `system` is not in
 * `EPISODE_SOURCE_SPECS`, so `episodeSourceClassOf` answered `null` and every
 * machine claim rendered `opaque`, exactly as before the arm existed. Thirteen
 * fixtures in this repo store the bare string and none store the prefixed form;
 * the tests passed only because they hand-built a handle production never writes.
 *
 * So the primary test is the **`system:` prefix**, which is this codebase's
 * established spelling for a principal that is not a person — nine of them today
 * (`system:warehouse-producer`, `system:brain-extraction`, `system:scheduler`,
 * `system:audit-purge-scheduler`, …), every one a scheduler or a producer. It
 * generalises where a literal would not: `system:brain-extraction` can reach
 * `provenance.actor` too, and it is no more a person than the warehouse fiber is.
 *
 * The class test is KEPT beside it rather than replaced, for a handle that really
 * was composed from an episode source. The warehouse CLASS carries the property
 * independently: it has
 * no vendor (`sources.ts`: *"neither comes from a connector"*), its facts are
 * read out of the customer's own tables by a scheduled fiber, and
 * `warehouse-producer.ts` attributes them to a system principal deliberately
 * because *"the machine is what read the warehouse"*. A warehouse-class handle
 * has no person behind it by construction.
 *
 * ⚠️ The class is read from the handle's PREFIX, which is `brain_episodes.source`
 * — a column with no CHECK, restorable verbatim by a region import. An
 * unrecognised prefix is therefore NOT machine: {@link episodeSourceClassOf}
 * answers `null` for a kind this deployment's vocabulary does not know, and
 * declining to claim a class it cannot see is the same posture
 * `isWarehouseDerivedSource` takes on the correction gate.
 */
export function derivableActor(actor: string): DerivedActor | null {
  if (actor.startsWith(USER_PREFIX)) {
    const userId = actor.slice(USER_PREFIX.length);
    return userId === "" ? null : { kind: "atlas-user", userId };
  }
  // The shape production actually writes. Checked FIRST because it is the only
  // one that has ever appeared in a stored row.
  if (actor.startsWith(SYSTEM_PREFIX) && actor.length > SYSTEM_PREFIX.length) {
    return { kind: "machine" };
  }
  const separator = actor.indexOf(":");
  if (separator <= 0) return null;
  return episodeSourceClassOf(actor.slice(0, separator)) === WAREHOUSE_CLASS
    ? { kind: "machine" }
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/**
 * One row → one view, or `opaque` with a reason logged.
 *
 * Every degradation lands on `opaque` rather than on a blank or on the handle,
 * because those are the two renderings finish condition 2 explicitly refuses.
 * `opaque` is a claim about the world Atlas can actually stand behind: *we
 * cannot name this person*.
 */
function projectIdentityRow(
  row: Record<string, unknown>,
  workspaceId: string,
  requestId: string | undefined,
): BrainActorIdentityView {
  const actor = str(row.actor);
  const state = str(row.state);

  if (state === "atlas") {
    const userId = str(row.user_id);
    // The join answered nothing: the account was deleted after the pointer was
    // written. Deleting an account is not a licence to assert a name Atlas can
    // no longer stand behind, so it degrades rather than rendering the stored
    // id as if it were a person.
    if (userId === null || (str(row.user_name) === null && str(row.user_email) === null)) {
      log.debug(
        { workspaceId, actor, requestId },
        "brain actor identity: `atlas` row whose live `\"user\"` join answered nothing — the account was deleted; reporting the actor as opaque rather than asserting a name",
      );
      return OPAQUE_IDENTITY;
    }
    return {
      state: "atlas",
      userId,
      name: str(row.user_name),
      email: str(row.user_email),
    } satisfies BrainActorIdentityAtlas;
  }

  if (state === "directory") {
    const snapshotAt = iso(row.snapshot_at);
    const displayName = str(row.display_name);
    const realName = str(row.real_name);
    const email = str(row.email);
    // `ck_brain_actor_identity_directory_shape` makes both of these unreachable
    // from the database. Reaching one means the row arrived some other way — a
    // region import, a hand-written INSERT — and a snapshot with no date is the
    // exact failure the date exists to prevent: a stale name asserted as
    // current. Degrade and log; do not render half a snapshot.
    if (snapshotAt === null || (displayName === null && realName === null && email === null)) {
      log.warn(
        { workspaceId, actor, requestId, hasSnapshotAt: snapshotAt !== null },
        "brain actor identity: `directory` row is missing its snapshot date or every name field — reporting the actor as opaque rather than rendering an undated or nameless snapshot",
      );
      return OPAQUE_IDENTITY;
    }
    return {
      state: "directory",
      displayName,
      realName,
      email,
      snapshotAt,
    } satisfies BrainActorIdentityDirectory;
  }

  if (state === "opaque") {
    return row.erased_at !== null && row.erased_at !== undefined ? ERASED_IDENTITY : OPAQUE_IDENTITY;
  }

  // Outside the vocabulary. `ck_brain_actor_identity_state` makes it
  // unreachable from the database, so this is drift — and an unknown state must
  // never present as a name.
  log.warn(
    { workspaceId, actor, requestId, state },
    "brain actor identity: stored `state` is outside the vocabulary — reporting the actor as opaque",
  );
  return OPAQUE_IDENTITY;
}

/**
 * The identities for a page of claims' actors.
 *
 * Takes the handles the caller already holds, so it adds a BOUNDED number of
 * queries per page rather than one per row — the property that lets it sit on
 * the `searchBrain` hot path beside `loadEpisodes`. The bound is two, and the
 * second is issued only when the page carries at least one `user:<id>` handle;
 * a page of pure connector claims still costs exactly one query, as it always
 * did. The two are independent reads and run CONCURRENTLY.
 *
 * ## Three sources of an answer, and their precedence (#5454)
 *
 *   1. **`machine`, from the handle.** Decided before any query — a
 *      warehouse-class handle has no person behind it, and that is true whether
 *      or not this deployment has a database to ask. Those handles are not sent
 *      to either statement.
 *   2. **The stored row**, for everything else.
 *   3. **`user:<id>`, from the handle**, for the handles step 2 did not answer.
 *
 * ⚠️ **The stored row WINS over the `user:` derivation, and `machine` wins over
 * the stored row.** Not an inconsistency — the two questions differ. A stored
 * row is a deliberate act with an erasure path attached, so anywhere one could
 * exist it is authoritative and the derivation only fills a gap; nothing writes
 * `user:` rows today, and this ordering is what keeps that true if something
 * ever does. Machine-ness is not an act at all — it is what the handle IS — so
 * a row asserting a person behind a warehouse producer would be wrong on its
 * face, and there is no erasure question to preserve because none of it is
 * personal data.
 *
 * ⚠️ There is NO ACL predicate here, and that is correct rather than an
 * omission. The gate on a name is the gate on `actor`, which the caller has
 * already evaluated through `attributionDecision`; a reader who is withheld
 * never reaches `projectProvenance`'s visible arm and therefore never reaches
 * this map's contents. Adding a second, different predicate here would be a
 * second ACL to keep in agreement with the first — the failure `attribution.ts`
 * exists to avoid by being the ONE place the decision is made.
 *
 * A missing row is `opaque`, silently: the commonest cause is a workspace whose
 * capture pass has not run yet, and one log line per unnamed actor per page
 * would be a flood that says nothing an operator can act on.
 *
 * ## ⚠️ A failed READ degrades to `opaque` rather than failing the page
 *
 * This is the one catch in this module, and it is deliberate rather than
 * defensive habit. The direction of failure decides it: a name that cannot be
 * loaded renders as *"we cannot name this person"*, which is honest and is a
 * state the surface already has copy for — while a rejection here would fail
 * the whole review page and every `searchBrain` answer, over a SIDE table that
 * grants nothing and gates nothing. It is not the `catch { return false }`
 * shape CLAUDE.md forbids: nothing here is a security check, and the fallback
 * is the more restrictive answer, not the more permissive one.
 *
 * The reachable cause is not hypothetical. The `atlas` arm joins Better Auth's
 * `"user"`, which is created by the auth migrations — so a deployment running
 * `ATLAS_AUTH_MODE=none` may not have that relation at all, and before this
 * catch such a deployment lost `searchBrain` entirely the moment one claim
 * carried an actor.
 *
 * It is LOGGED at `warn` with the error, because a workspace whose names have
 * all silently gone `opaque` is exactly the condition an operator has to be
 * able to find.
 *
 * The `machine` arm is the one answer that SURVIVES that failure, and it does so
 * for free rather than by special pleading: it never needed a row, so there is
 * nothing about it a failed read could have lost.
 */
export async function loadActorIdentities(
  db: ActorIdentityReader,
  workspaceId: string,
  actors: readonly string[],
  requestId?: string,
): Promise<ReadonlyMap<string, BrainActorIdentityView>> {
  const out = new Map<string, BrainActorIdentityView>();
  const wanted: string[] = [];
  /** `user:<id>` handle → the id, for the ones the stored read leaves unanswered. */
  const derivedUsers = new Map<string, string>();

  for (const actor of new Set(actors.filter((a) => typeof a === "string" && a !== ""))) {
    const derived = derivableActor(actor);
    if (derived?.kind === "machine") {
      // Decided, and deliberately not sent to either statement — there is no
      // person here for a row to be about.
      out.set(actor, MACHINE_IDENTITY);
      continue;
    }
    if (derived?.kind === "atlas-user") derivedUsers.set(actor, derived.userId);
    wanted.push(actor);
  }
  if (wanted.length === 0) return out;

  const [stored, users] = await Promise.all([
    // Two independent reads, run together rather than in sequence: neither
    // feeds the other, and a waterfall would double this function's latency on
    // exactly the page — a review queue full of corrections — that needs both.
    readRows(db, LOAD_ACTOR_IDENTITIES_SQL, [workspaceId, wanted], {
      workspaceId,
      requestId,
      actors: wanted.length,
      what: "the identity read",
    }),
    derivedUsers.size === 0
      ? Promise.resolve<readonly unknown[]>([])
      : readRows(db, LOAD_DERIVED_ATLAS_USERS_SQL, [workspaceId, [...new Set(derivedUsers.values())]], {
          workspaceId,
          requestId,
          actors: derivedUsers.size,
          what: "the `user:` handle read",
        }),
  ]);

  for (const raw of stored) {
    const row = raw as Record<string, unknown>;
    const actor = str(row.actor);
    if (actor === null) continue;
    out.set(actor, projectIdentityRow(row, workspaceId, requestId));
  }

  if (derivedUsers.size > 0) {
    const byId = new Map<string, { name: string | null; email: string | null }>();
    for (const raw of users) {
      const row = raw as Record<string, unknown>;
      const id = str(row.id);
      if (id === null) continue;
      byId.set(id, { name: str(row.name), email: str(row.email) });
    }
    for (const [actor, userId] of derivedUsers) {
      // Step 2's answer stands — see the precedence note in the header.
      if (out.has(actor)) continue;
      const account = byId.get(userId);
      // No such account. The same degradation `projectIdentityRow` applies to a
      // dangling stored pointer, for the same reason: a deleted account is not
      // a licence to assert a name Atlas can no longer stand behind, and
      // rendering the id as if it were a person is what `opaque` exists against.
      if (account === undefined || (account.name === null && account.email === null)) {
        log.debug(
          { workspaceId, actor, requestId },
          'brain actor identity: a `user:` handle names an account the live `"user"` read did not return — the account was deleted; reporting the actor as opaque rather than asserting a name',
        );
        out.set(actor, OPAQUE_IDENTITY);
        continue;
      }
      out.set(actor, {
        state: "atlas",
        userId,
        name: account.name,
        email: account.email,
      } satisfies BrainActorIdentityAtlas);
    }
  }

  return out;
}

/**
 * One read, or `[]` with the failure logged — the degrade-to-`opaque` posture
 * the header argues for, in ONE place so both statements take it.
 *
 * Returning rows rather than throwing is what keeps the two reads independent:
 * a deployment with no `"user"` relation fails BOTH, and a `Promise.all` over
 * rejecting promises would lose whichever answer did come back.
 */
async function readRows(
  db: ActorIdentityReader,
  sql: string,
  params: unknown[],
  ctx: {
    readonly workspaceId: string;
    readonly requestId: string | undefined;
    readonly actors: number;
    readonly what: string;
  },
): Promise<readonly unknown[]> {
  try {
    const result = await db.query(sql, params);
    return result.rows;
  } catch (err) {
    log.warn(
      {
        workspaceId: ctx.workspaceId,
        requestId: ctx.requestId,
        actors: ctx.actors,
        error: err instanceof Error ? err.message : String(err),
      },
      `brain actor identity: ${ctx.what} failed — those claims report "cannot name this person". A missing \`"user"\` relation means this deployment runs without Better Auth's tables`,
    );
    return [];
  }
}

/**
 * The lookup `projectProvenance` takes — a map, or the empty one.
 *
 * Named so the required parameter reads as a decision at every call site rather
 * than as an incidental `Map`. See `candidates.ts`'s argument for why the
 * parameter is required and undefaulted.
 */
export type BrainActorIdentityLookup = ReadonlyMap<string, BrainActorIdentityView>;

/**
 * The `actor` handle out of a stored `brain_facts.provenance` payload.
 *
 * The column is `jsonb`, so `unknown` in practice. Reads exactly the key
 * `projectProvenance` reads and applies the same non-empty-string test, so the
 * handles a page LOOKS UP and the handles it RENDERS cannot come apart — a
 * mismatch there would show as a claim whose name is silently `opaque` while an
 * identical claim beside it resolves.
 */
export function provenanceActor(provenance: unknown): string | null {
  if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) {
    return null;
  }
  const actor = (provenance as Record<string, unknown>).actor;
  return typeof actor === "string" && actor !== "" ? actor : null;
}

/** Every distinct actor handle across a page of stored provenance payloads. */
export function actorsIn(provenances: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const p of provenances) {
    const actor = provenanceActor(p);
    if (actor !== null) out.add(actor);
  }
  return [...out];
}

/** No identities to hand over — every actor renders `opaque`. */
export const NO_ACTOR_IDENTITIES: BrainActorIdentityLookup = new Map();

/**
 * The identity for one handle, defaulting to `opaque`.
 *
 * The default is the whole reason this is a function rather than a `.get()` at
 * the call site: an absent entry must become the NAMED "cannot name this
 * person" state, never `undefined` — which would render as a blank, which is
 * what finish condition 2 refuses.
 */
export function identityFor(
  lookup: BrainActorIdentityLookup,
  actor: string | null,
): BrainActorIdentityView | null {
  // Null IFF there is no actor. No author means no identity question to answer,
  // which is a different thing from an author Atlas cannot name.
  if (actor === null || actor === "") return null;
  return lookup.get(actor) ?? OPAQUE_IDENTITY;
}

// ---------------------------------------------------------------------------
// Writing — capture
// ---------------------------------------------------------------------------

/**
 * The principals this workspace's ingested episodes were AUTHORED by.
 *
 * ⚠️ This predicate is the bound ADR-0036 §T5 draws, and it is the whole of the
 * reversal. Capturing from `users.list` directly would persist the customer's
 * directory, which the ADR refuses BY NAME. Reading the authors out of
 * `brain_episodes` instead keeps the stored set to *people whose words are
 * already in the record*.
 *
 * The composed handle is built here rather than in TypeScript so the SQL and
 * `reconcile.ts`'s `resolvedPrincipal` cannot disagree about the separator —
 * `` `${episode.source}:${actor}` `` is the one spelling, and a claim whose
 * handle does not match a captured row renders `opaque` silently, which is the
 * failure mode that would be hardest to notice.
 *
 * ⚠️ `btrim`, in the projection AND the predicate, because agreeing about the
 * separator is not enough — the two also have to agree about WHITESPACE.
 * `resolvedPrincipal` trims (`episode.sourceActor?.trim()`), so an episode
 * stored with `source_actor = ' U123'` produces the claim handle `slack:U123`.
 * Without the trim here this query would key a row `slack: U123`, and the two
 * would never join: the claim renders `opaque` permanently while a junk
 * identity row sits beside it naming nobody. The predicate needs it too —
 * `<> ''` admits `' '`, which `ck_brain_actor_identity_key_present` also
 * admits, so an all-whitespace actor would otherwise be captured as a real one.
 *
 * Exported so the real-Postgres test runs this exact string.
 */
export const AUTHORING_PRINCIPALS_SQL = `SELECT DISTINCT ${authoringPrincipalSql("e")} AS actor,
              e.source,
              btrim(e.source_actor) AS vendor_user_id
         FROM brain_episodes e
        WHERE e.workspace_id = $1
          AND e.source = $2
          AND e.source_actor IS NOT NULL
          AND btrim(e.source_actor) <> ''`;

/** One captured identity, ready to write. */
export interface ActorIdentityCapture {
  readonly actor: string;
  readonly source: string;
  readonly vendorUserId: string;
  readonly state: BrainActorIdentityState;
  /** `atlas` only. */
  readonly userId?: string | null;
  /** `directory` only. */
  readonly displayName?: string | null;
  readonly realName?: string | null;
  readonly email?: string | null;
}

/**
 * Upsert one identity, leaving an operator's erasure alone.
 *
 * ## The `WHERE ai.erased_at IS NULL` on the UPDATE is the erasure guarantee
 *
 * Without it every erasure would last until the next 30-minute audience cycle
 * re-captured the name, and it would fail SILENTLY — the operator would see the
 * erasure take, and the name would come back. This one predicate is what makes
 * `brain_actor_identity` a tombstone table rather than a cache.
 *
 * ## `snapshot_at` is stamped by the DATABASE, on the transition only
 *
 * `now()` rather than an application clock so the date on a snapshot is the
 * date the row was written; and `CASE` rather than an unconditional stamp so a
 * cycle that re-captures an UNCHANGED name does not advance the date. A
 * snapshot whose date moves every 30 minutes reports itself as fresh forever,
 * which is precisely the "stale name asserted as current" the date exists to
 * prevent.
 *
 * ⚠️ Comparison against `IS DISTINCT FROM` and not `<>`, because every snapshot
 * column is nullable and `NULL <> NULL` is NULL — a name arriving where there
 * was none would compare as "unchanged" and keep the older date.
 *
 * ## A capture pass may UPGRADE an identity; it may never DESTROY one
 *
 * The second predicate on the `DO UPDATE` refuses `directory → opaque`, and it
 * closes a defect that would have quietly undone the whole feature. An author
 * who is in `users.list` today gets a dated snapshot; if they later drop OUT of
 * the directory entirely — a Slack Connect guest whose connection ends, a Grid
 * member moved to another workspace — {@link ActorIdentityCapture} for them
 * decides `opaque`, and an unguarded upsert would overwrite the snapshot with
 * a nameless row on the next 30-minute cycle. That is EXACTLY the person this
 * module's header says the snapshot exists for ("for someone who has left both
 * the chat vendor and the company, a name captured at ingest is the only record
 * that will ever name them"), and the loss is irreversible.
 *
 * So the vendor going quiet about someone is not evidence that Atlas should
 * forget them. The ONE path that removes a snapshot is an operator's erasure,
 * which is a deliberate act with its own audit row.
 *
 * Every other transition is still allowed, because each is a strict
 * improvement: `opaque → directory` (the directory started naming them),
 * `opaque → atlas` and `directory → atlas` (they signed up — a live join beats
 * a snapshot), `atlas → directory` (the account went away but the vendor still
 * names them), and `directory → directory` (a fresh vendor reading, which the
 * complete-or-abort directory read guarantees is not a truncated one).
 *
 * `atlas → opaque` is also allowed and is not the same case: that row held a
 * POINTER and no name, so nothing is destroyed — and the reader already
 * degrades a dangling pointer to `opaque` anyway.
 */
export function captureActorIdentitySql(rowCount: number): string {
  // One `$n` group per row. `workspace_id` is `$1` and shared; every row then
  // takes eight of its own, so row `i` starts at `2 + i * 8`.
  const tuples: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const b = 2 + i * 8;
    tuples.push(
      `($1, $${b}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, ` +
        `CASE WHEN $${b + 3} = 'directory' THEN now() ELSE NULL END, now(), now())`,
    );
  }
  return `INSERT INTO brain_actor_identity
         (workspace_id, actor, source, vendor_user_id, state,
          user_id, display_name, real_name, email, snapshot_at,
          captured_at, updated_at)
       VALUES ${tuples.join(",\n              ")}
       ON CONFLICT (workspace_id, actor) DO UPDATE
          SET state = EXCLUDED.state,
              user_id = EXCLUDED.user_id,
              display_name = EXCLUDED.display_name,
              real_name = EXCLUDED.real_name,
              email = EXCLUDED.email,
              snapshot_at = CASE
                WHEN EXCLUDED.state <> 'directory' THEN NULL
                WHEN brain_actor_identity.state <> 'directory'
                  OR brain_actor_identity.display_name IS DISTINCT FROM EXCLUDED.display_name
                  OR brain_actor_identity.real_name IS DISTINCT FROM EXCLUDED.real_name
                  OR brain_actor_identity.email IS DISTINCT FROM EXCLUDED.email
                  THEN now()
                ELSE brain_actor_identity.snapshot_at
              END,
              updated_at = now()
        WHERE brain_actor_identity.erased_at IS NULL
          AND NOT (brain_actor_identity.state = 'directory' AND EXCLUDED.state = 'opaque')
    RETURNING actor`;
}

/**
 * The one-row form, kept so the clause assertions in
 * `__tests__/actor-identity.test.ts` read against a stable string rather than a
 * generated one.
 */
export const CAPTURE_ACTOR_IDENTITY_SQL = captureActorIdentitySql(1);

/**
 * Rows per statement.
 *
 * The bound that matters is Postgres's 65,535-parameter cap, which at eight
 * parameters a row is ~8,000 — so 200 is nowhere near it and is chosen for the
 * other reason: it keeps one statement's row lock set small enough that a slow
 * cycle does not sit across a whole workspace's identities at once.
 */
const CAPTURE_BATCH_SIZE = 200;

/**
 * Write a set of captures, batched.
 *
 * ⚠️ BATCHED rather than one round trip per author, and the difference grows
 * with the corpus rather than with the change. This runs every 30 minutes per
 * workspace over every principal who has ever authored an ingested episode —
 * a population that only ever grows — so a per-row loop is O(authors)
 * round-trips forever, against a table that changes almost never.
 *
 * Returns the actors actually WRITTEN. Everything requested and not returned
 * was refused by the `WHERE`: an operator's erasure holding, or the
 * `directory → opaque` downgrade being declined. Both are normal outcomes and
 * neither is an error; the caller counts them rather than logging each one.
 *
 * The caller must hand over DISTINCT actors. Two rows with the same key in one
 * statement is a Postgres error (`ON CONFLICT DO UPDATE command cannot affect
 * row a second time`), not a silent last-writer-wins — which is the safe
 * direction, and `AUTHORING_PRINCIPALS_SQL` (`audience/identity-capture.ts`)'s `SELECT DISTINCT`
 * guarantees it upstream.
 */
export async function captureActorIdentities(
  db: ActorIdentityReader,
  workspaceId: string,
  captures: readonly ActorIdentityCapture[],
): Promise<ReadonlySet<string>> {
  const written = new Set<string>();
  for (let offset = 0; offset < captures.length; offset += CAPTURE_BATCH_SIZE) {
    const batch = captures.slice(offset, offset + CAPTURE_BATCH_SIZE);
    const params: unknown[] = [workspaceId];
    for (const c of batch) {
      params.push(
        c.actor,
        c.source,
        c.vendorUserId,
        c.state,
        c.userId ?? null,
        c.displayName ?? null,
        c.realName ?? null,
        c.email ?? null,
      );
    }
    const result = await db.query(captureActorIdentitySql(batch.length), params);
    // `RETURNING` and the row set, not `rowCount`: the two internal-DB handles
    // disagree about `rowCount` (the `@effect/sql` client answers rows only),
    // and a silently-zero count here would report every write as refused.
    for (const raw of result.rows) {
      const actor = str((raw as Record<string, unknown>).actor);
      if (actor !== null) written.add(actor);
    }
  }
  return written;
}

/**
 * Write one capture.
 *
 * A thin wrapper over {@link captureActorIdentities} rather than a second
 * statement, so there is ONE spelling of the upsert — the `WHERE` clauses on it
 * are the erasure guarantee and the no-destroy guarantee, and a second copy is
 * a second place for either to be dropped.
 *
 * Returns whether the row was written; `false` means the `WHERE` refused it.
 */
export async function captureActorIdentity(
  db: ActorIdentityReader,
  workspaceId: string,
  capture: ActorIdentityCapture,
): Promise<boolean> {
  const written = await captureActorIdentities(db, workspaceId, [capture]);
  return written.has(capture.actor);
}

// ---------------------------------------------------------------------------
// Writing — erasure
// ---------------------------------------------------------------------------

/**
 * Clear a snapshot: the claim returns to `opaque`, and the claim itself stays.
 *
 * The `retract` shape — the record keeps the statement and loses the person.
 * ADR-0036 §T5: a snapshot is personal data about someone who is not an Atlas
 * user and cannot themselves ask Atlas for anything, so an operator must be
 * able to clear one, and clearing it must not delete the claim.
 *
 * ⚠️ `state = 'directory'` in the predicate, and the narrowness is the
 * argument. An `atlas` row stores no snapshot at all — its name is a live join
 * to an account whose own erasure path is account deletion — so "erasing" one
 * would remove nothing and would leave a real, current colleague rendering as
 * "cannot name this person" on every claim they made. An already-`opaque` row
 * has nothing to clear. The route reports both as a refusal rather than a
 * silent no-op, so an operator learns which case they are in.
 */
export const ERASE_ACTOR_IDENTITY_SQL = `UPDATE brain_actor_identity
          SET state = 'opaque',
              user_id = NULL,
              display_name = NULL,
              real_name = NULL,
              email = NULL,
              snapshot_at = NULL,
              erased_at = now(),
              erased_by = $3,
              updated_at = now()
        WHERE workspace_id = $1
          AND actor = $2
          AND state = 'directory'
    RETURNING actor`;

/** Why an erasure did not happen. Each arm is a different thing to tell the operator. */
export type ActorIdentityEraseOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not-found" }
  | { readonly ok: false; readonly reason: "not-a-snapshot" };

export const ERASE_LOOKUP_SQL = `SELECT state, erased_at FROM brain_actor_identity
        WHERE workspace_id = $1 AND actor = $2`;

/**
 * Erase one directory snapshot.
 *
 * Two statements rather than one because the refusals have to be
 * DISTINGUISHABLE: a zero-row UPDATE alone cannot tell "no such actor" from
 * "this actor resolves live and has no snapshot to clear", and those call for
 * opposite operator actions. The read is not a TOCTOU hazard worth a
 * transaction — the worst race re-reports a state that changed underneath, and
 * the UPDATE's own predicate is what enforces the rule.
 */
export async function eraseActorIdentity(
  db: ActorIdentityReader,
  workspaceId: string,
  actor: string,
  erasedBy: string,
): Promise<ActorIdentityEraseOutcome> {
  const result = await db.query(ERASE_ACTOR_IDENTITY_SQL, [workspaceId, actor, erasedBy]);
  if (result.rows.length > 0) {
    log.info(
      { workspaceId, actor, erasedBy },
      "brain actor identity: directory snapshot erased — the claim keeps its statement and returns to opaque",
    );
    return { ok: true };
  }
  const existing = await db.query(ERASE_LOOKUP_SQL, [workspaceId, actor]);
  const row = existing.rows[0] as Record<string, unknown> | undefined;
  return row === undefined
    ? { ok: false, reason: "not-found" }
    : { ok: false, reason: "not-a-snapshot" };
}
