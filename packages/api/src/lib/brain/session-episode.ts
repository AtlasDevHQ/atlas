/**
 * Lazy session-episode materialization (#5486, ADR-0036 §T9 lock 3).
 *
 * A chat session becomes a tier-3 raw episode ONLY at propose-time: when a
 * human confirms a `proposeFact` claim that originated in a conversation, the
 * conversation is minted as a `brain_episodes` row so the proposed fact has a
 * session to derive from. Nothing materializes a session eagerly — lock 3
 * rejected eager per-session episoding outright, and the source scan in
 * `__tests__/session-episode.test.ts` pins {@link materializeSessionEpisode}
 * to the proposal path so an eager caller fails a test before it ships.
 *
 * ## By-reference, per T3
 *
 * The episode carries a `locator` and a NULL `body` (0180's body-XOR-locator
 * CHECK), the same split `warehouse-producer.ts` uses: the conversation is
 * already stored — the `conversations`/`messages` tables hold every turn, and
 * ADR-0020's durable runs key on the same conversation id — so copying the
 * transcript into the episode would fork the truth ADR-0036 §T3 says stays at
 * its authoritative home. The locator names that home
 * ({@link sessionLocator}); the dedupe identity is the session itself
 * ({@link sessionSourceId}).
 *
 * ## Lazy AND idempotent — one episode per session, minted at first propose
 *
 * `ON CONFLICT (workspace_id, source, source_id) DO NOTHING` on 0180's dedupe
 * key, exactly as the connector ingest path writes episodes: a second proposal
 * from the same conversation reuses the episode it minted the first time
 * rather than duplicating it. Because the episode is by-reference, it always
 * names the conversation's current stored state — there is nothing stale to
 * refresh.
 *
 * ## `extracted_at` is stamped AT INSERT
 *
 * Copied from `CORRECTION_EPISODE_INSERT_SQL` / `PROPOSAL_EPISODE_INSERT_SQL`
 * deliberately, because this is the trap §T9's grill named: an episode left on
 * the extraction queue (`extracted_at IS NULL`) is drained by the LLM
 * extraction fiber, which would re-derive the human's own proposal as a
 * second, machine-produced claim. The propose path IS this episode's
 * processing — the fact commits in the same transaction — so the row never
 * belongs on that queue.
 *
 * ## The grant seed — lock 3's actual text, applied directly
 *
 * The candidate "inherits the session's ACL context as the T5 grant seed —
 * defaulting to the narrowest defensible audience (the actor plus what the
 * source episode already carried), never a silent `[org]`; widening happens
 * only at the review gate." {@link sessionGrantSeed} is that sentence as code:
 * the actor's own grant token unioned with whatever the session episode
 * already carries. It NEVER introduces {@link ORG_PRINCIPAL} for an
 * authenticated actor — `org` appears in the seed only when the carried
 * grants already contain it, which is the explicit widening the rule permits.
 * The one deployment whose seed IS `org` is `unauthenticated-local`, where
 * `acl.ts` declares the org principal the only identity there is — a
 * disclosed single-principal deployment, not a silent default.
 *
 * This supersedes `proposalGrantTokens()`'s disclosed-`[org]` for
 * session-carrying proposals, exactly as that function's own header forecast:
 * "When the session-episode path lands, it brings its own derivation and lock
 * 3 governs it directly." The `[org]` derivation remains the documented,
 * card-disclosed fallback for a proposal with no session to inherit from.
 *
 * ## The edge the fact takes to this episode is `derives-from`, NOT `provenance`
 *
 * Written by `proposal.ts` (via `correction.ts`'s idempotence-guarded
 * `DERIVES_FROM_EDGE_SQL`), and the choice is load-bearing rather than
 * stylistic. `provenance` edges feed the distinct-source corroboration count
 * and reset the staleness decay anchor; the proposal episode — the human's
 * vouch — already carries that edge through `reconcileFacts`. If the session
 * episode carried one too, a single act of testimony would count as TWO
 * sources for the claim it asserts, which is precisely the self-echo
 * inflation §T9 lock 5 (and #5487) exists to discount. The session is the
 * LINEAGE of the claim — where it came from, what a retraction should flag —
 * and lineage is what `derives-from` records.
 *
 * ## The ADR-0020 boundary (lock 2) — read-only, inbound-only
 *
 * The session is READ to mint an episode; nothing is written back into
 * durable memory and no write-through cache appears. This module touches only
 * the `conversations` table (the session's durable home) and never imports
 * from `durable-session.ts` / `durable-state.ts` — and those modules hold
 * zero brain references in return, a state the boundary scan in
 * `__tests__/session-episode.test.ts` keeps that way.
 */

import {
  ORG_PRINCIPAL,
  USER_PREFIX,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import type { ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";

/**
 * The session's dedupe identity under the `human` source. Shares a namespace
 * with `correction:` and `proposal:` prefixed ids; the prefixes are what keep
 * the three producers' ids from colliding on 0180's
 * `(workspace_id, source, source_id)` unique index.
 *
 * `human` rather than a new vocabulary member, deliberately: the episode is
 * minted by a human's own propose act, the same entry class as the correction
 * and proposal episodes beside it, and adding a stored source kind is the
 * deliberate one-line-PR-plus-two-axis-test decision `sources.ts`'s header
 * reserves for a connector with its own id grammar — which this is not.
 */
export const SESSION_SOURCE_ID_PREFIX = "session:";

/** `session:<conversationId>` — one episode per session, whatever proposes from it. */
export function sessionSourceId(conversationId: string): string {
  return `${SESSION_SOURCE_ID_PREFIX}${conversationId}`;
}

/**
 * The by-reference pointer to the session's authoritative home: the
 * `conversations` row (and its `messages`) under this id — the same id
 * ADR-0020's durable runs key on when durability is enabled. Distinct from
 * {@link sessionSourceId} on purpose: the source id names WHAT the episode is
 * (the dedupe identity), the locator names WHERE the stored source lives.
 */
export function sessionLocator(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/**
 * The ownership gate, run in-transaction BEFORE any write.
 *
 * A session ref arrives from a confirm POST, and the confirm endpoint is not a
 * trusted fast-path — so the check lives here, where the write is, and every
 * future caller inherits it rather than having to remember it (the same
 * placement argument `correction.ts` makes for its audit row). Three
 * predicates, each refusing a real attack or defect:
 *
 *   - `org_id = $2` — strict, with NO legacy-NULL branch: `conversations.ts`'s
 *     `scopeClause` admits pre-`org_id` rows for reads, but a brain write
 *     seeded from a conversation nothing ties to this workspace is exactly the
 *     cross-tenant inheritance the ACL exists to prevent. Narrower than the
 *     read path, on the read path's own "narrower is safer" grounds.
 *   - `deleted_at IS NULL` — a deleted conversation is not evidence anyone can
 *     follow the locator back to.
 *   - `($3::text IS NULL OR user_id = $3)` — the actor must OWN the session
 *     whose ACL context the proposal inherits. `$3` is NULL only for
 *     `unauthenticated-local`, the deployment that has declared it has no user
 *     ids to compare.
 */
export const CONVERSATION_OWNERSHIP_SQL = `SELECT id::text AS id
     FROM conversations
    WHERE id = $1::uuid
      AND org_id = $2
      AND deleted_at IS NULL
      AND ($3::text IS NULL OR user_id = $3::text)`;

/**
 * The session episode — by-reference (`body` NULL, `locator` bound), lazily
 * minted, idempotent on 0180's dedupe key.
 *
 * `extracted_at` is stamped at insert with the SAME `$5` the row's
 * `occurred_at` binds — see the module header for why leaving it NULL would
 * hand the session to the extraction fiber to be re-derived as a second,
 * machine-produced claim. `ON CONFLICT … DO NOTHING` (the connector ingest
 * path's exact shape) makes a re-propose from the same session a no-op here;
 * {@link SESSION_EPISODE_SELECT_SQL} then reads the episode the first propose
 * minted, so the RETURNING-empty case is a reuse signal rather than an error.
 */
export const SESSION_EPISODE_INSERT_SQL = `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, locator, occurred_at, visible_to, extracted_at)
       VALUES ($1, 'human', $2, $3, NULL, $4, $5::timestamptz,
               ARRAY(SELECT jsonb_array_elements_text($6::jsonb)), $5::timestamptz)
       ON CONFLICT (workspace_id, source, source_id) DO NOTHING
       RETURNING id::text AS id`;

/**
 * The reuse read: the episode a previous propose from this session minted.
 * Projects `visible_to` because that is "what the source episode already
 * carried" — the half of lock 3's seed the fresh-mint path derives and the
 * reuse path must READ rather than re-derive.
 */
export const SESSION_EPISODE_SELECT_SQL = `SELECT id::text AS id, visible_to
     FROM brain_episodes
    WHERE workspace_id = $1
      AND source = 'human'
      AND source_id = $2`;

/**
 * Raised when the referenced conversation does not exist in this workspace,
 * is deleted, or is not the actor's own — the three are deliberately
 * indistinguishable, on `correction.ts`'s not-found reasoning: a distinct
 * answer would confirm the existence of a conversation the caller may not
 * see. Thrown INSIDE the propose transaction so the throw is what rolls any
 * partial work back; `proposeFact` catches it and returns an ordinary
 * refusal.
 */
export class SessionEpisodeNotFoundError extends Error {
  constructor(readonly conversationId: string) {
    super(
      "The conversation this proposal references was not found in this workspace — nothing was recorded.",
    );
    this.name = "SessionEpisodeNotFoundError";
  }
}

/** A materialized (or reused) session episode, plus what its grant carries. */
export interface MaterializedSessionEpisode {
  readonly episodeId: string;
  /** The episode's stored grant — the "already carried" half of the seed. */
  readonly visibleTo: readonly string[];
  /** False when a previous propose from this session already minted it. */
  readonly created: boolean;
}

/**
 * The actor's own grant token — the "the actor" half of lock 3's seed.
 *
 * `user:<id>` for an authenticated actor. For `unauthenticated-local` it is
 * {@link ORG_PRINCIPAL}, because that deployment's declared principal set IS
 * `[org]` and only `[org]` (`acl.ts`'s `principalTokens`) — a `user:` token
 * would name an identity the deployment has declared does not exist, and the
 * resulting draft would be visible to nobody at all. `unresolved` throws: a
 * caller reaching here without an established identity is a programmer error
 * (`proposeFact` refuses that origin before any session work), and granting
 * from it would attribute an ACL decision to nobody.
 */
export function sessionActorGrantToken(ctx: BrainPrincipalContext): string {
  if (ctx.origin === "unresolved") {
    throw new Error(
      "session grant seed requested for an unresolved principal — the propose path refuses this origin before any session work",
    );
  }
  return ctx.userId !== null ? `${USER_PREFIX}${ctx.userId}` : ORG_PRINCIPAL;
}

/**
 * Lock 3's seed: the actor plus what the source episode already carried.
 *
 * Pure, and deliberately incapable of introducing `org` on its own: for an
 * authenticated actor the output contains {@link ORG_PRINCIPAL} only when
 * `carried` already does — that is the "explicit widening" the acceptance
 * criterion tests for, and `__tests__/session-episode.test.ts` pins it. Order
 * is actor-first then carried order, deduplicated; non-string and empty
 * elements are dropped (the stored array is legally messier than the grammar,
 * per `acl.ts`'s at-rest rules, and an empty token grants nobody while
 * matching `ARRAY['']` overlap).
 */
export function sessionGrantSeed(
  ctx: BrainPrincipalContext,
  carried: readonly unknown[],
): readonly string[] {
  const seed = [sessionActorGrantToken(ctx)];
  for (const token of carried) {
    if (typeof token === "string" && token !== "" && !seed.includes(token)) {
      seed.push(token);
    }
  }
  return seed;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MaterializeSessionEpisodeRequest {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly ctx: BrainPrincipalContext;
  /** The propose timestamp — the episode's `occurred_at` AND its `extracted_at`. */
  readonly at: Date;
}

/**
 * Mint the session's tier-3 episode, or reuse the one a previous propose
 * minted — inside the caller's transaction, so the episode and the fact that
 * derives from it commit together or not at all.
 *
 * Runs the ownership gate first ({@link CONVERSATION_OWNERSHIP_SQL}); a
 * conversation this actor cannot claim throws
 * {@link SessionEpisodeNotFoundError} before anything is written. The uuid
 * pre-check exists because `$1::uuid` on a malformed id is a Postgres cast
 * error — a 500 naming an internal expression — where the honest answer is
 * the same not-found the ownership gate gives.
 *
 * A FRESH episode's grant is `[the actor's own token]`: the conversation's
 * audience is its owner, and that is the narrowest defensible audience a
 * session has. On reuse the stored grant is read back verbatim — what the
 * episode already carried is a fact about the row, never re-derived
 * (`correction.ts`'s #5037 lesson, applied to grants).
 *
 * A SHARED conversation (`conversations.share_mode = 'org'`, or a share
 * token) still seeds `[the actor]`, deliberately: a share link is revocable
 * ACCESS to a rendering, not audience membership, and deriving a durable
 * grant from it would freeze an ephemeral state into an immutable episode
 * row. Anyone the claim should reach is the reviewer's widening decision
 * (#5483), not this seed's.
 */
export async function materializeSessionEpisode(
  tx: ReconcileExecutor,
  request: MaterializeSessionEpisodeRequest,
): Promise<MaterializedSessionEpisode> {
  const { workspaceId, conversationId, ctx, at } = request;

  if (!UUID_RE.test(conversationId)) {
    throw new SessionEpisodeNotFoundError(conversationId);
  }

  const owned = await tx.query(CONVERSATION_OWNERSHIP_SQL, [
    conversationId,
    workspaceId,
    ctx.userId,
  ]);
  if (owned.rows.length === 0) {
    throw new SessionEpisodeNotFoundError(conversationId);
  }

  const actorToken = sessionActorGrantToken(ctx);
  const sourceId = sessionSourceId(conversationId);
  const inserted = await tx.query(SESSION_EPISODE_INSERT_SQL, [
    workspaceId,
    sourceId,
    ctx.userId ?? "local-operator",
    sessionLocator(conversationId),
    at.toISOString(),
    JSON.stringify([actorToken]),
  ]);
  const insertedId = firstId(inserted.rows);
  if (insertedId !== null) {
    return { episodeId: insertedId, visibleTo: [actorToken], created: true };
  }

  // ON CONFLICT DO NOTHING returned no row — a previous propose from this
  // session already minted the episode. Read it back, grant included.
  const existing = await tx.query(SESSION_EPISODE_SELECT_SQL, [workspaceId, sourceId]);
  const row = existing.rows[0];
  const existingId = firstId(existing.rows);
  if (existingId === null) {
    // The insert conflicted yet the row is unreadable — only reachable if the
    // dedupe key's shape moved underneath this module. An incident, not a
    // refusal.
    throw new Error(
      `brain session episode: insert conflicted but no episode row exists for ${sourceId} (workspace ${workspaceId})`,
    );
  }
  const visibleTo = readVisibleTo(row);
  return { episodeId: existingId, visibleTo, created: false };
}

/** First `id` off a `RETURNING id` / SELECT result, or `null`. */
function firstId(rows: readonly unknown[]): string | null {
  const row = rows[0];
  if (row === undefined || row === null || typeof row !== "object") return null;
  const id = (row as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The stored grant, narrowed to strings — the driver hands `text[]` back untyped. */
function readVisibleTo(row: unknown): readonly string[] {
  if (row === null || typeof row !== "object") return [];
  const raw = (row as Record<string, unknown>).visible_to;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && t !== "");
}
