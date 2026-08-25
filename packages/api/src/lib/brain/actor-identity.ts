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
  BrainActorIdentityOpaque,
  BrainActorIdentityView,
} from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";

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
 * Takes the handles the caller already holds, so it adds ONE query per page
 * rather than per row — the property that lets it sit on the `searchBrain` hot
 * path beside `loadEpisodes`.
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
 */
export async function loadActorIdentities(
  db: ActorIdentityReader,
  workspaceId: string,
  actors: readonly string[],
  requestId?: string,
): Promise<ReadonlyMap<string, BrainActorIdentityView>> {
  const out = new Map<string, BrainActorIdentityView>();
  const wanted = [...new Set(actors.filter((a) => typeof a === "string" && a !== ""))];
  if (wanted.length === 0) return out;

  let result: { rows: readonly unknown[] };
  try {
    result = await db.query(LOAD_ACTOR_IDENTITIES_SQL, [workspaceId, wanted]);
  } catch (err) {
    log.warn(
      {
        workspaceId,
        requestId,
        actors: wanted.length,
        error: err instanceof Error ? err.message : String(err),
      },
      'brain actor identity: the identity read failed — every claim on this page reports "cannot name this person". A missing `"user"` relation means this deployment runs without Better Auth\'s tables',
    );
    return out;
  }

  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const actor = str(row.actor);
    if (actor === null) continue;
    out.set(actor, projectIdentityRow(row, workspaceId, requestId));
  }
  return out;
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
export const AUTHORING_PRINCIPALS_SQL = `SELECT DISTINCT e.source || ':' || btrim(e.source_actor) AS actor,
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
 * direction, and {@link AUTHORING_PRINCIPALS_SQL}'s `SELECT DISTINCT`
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
