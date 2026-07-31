/**
 * `searchBrain` — the fused, trust-labeled read over the three fuzzy stores
 * (#4773, ADR-0036 §Retrieval & agent interface).
 *
 * ONE read, three stores, every row labeled:
 *
 *   - **tier-2 reviewed facts** (`brain_facts`) — authoritative for their class
 *   - **tier-3 raw episodes** (`brain_episodes`) — what was actually said
 *   - **KB documents** (`knowledge_documents`, ADR-0028) — descriptive prose,
 *     deliberately outside the truth ordering
 *
 * Tier-1 warehouse facts are NOT here and never will be: they resolve live
 * through the semantic layer under warehouse RLS, and they are `executeSQL`'s.
 * `searchBrain` never silently runs metric SQL. Routing between the two is
 * agent-side, through the tool descriptions — quantitative/governed →
 * `executeSQL`, decision/rationale/ownership → `searchBrain` — with no hidden
 * classifier in the middle.
 *
 * ## The trap: four predicates, and the two that are not ADR gates
 *
 * (Distinct from "the four ADR-0036 gates" one section down — those are the
 * ADR's governance axes; these are the WHERE-clause terms one statement must
 * compose.) A current-belief fact read composes FOUR predicates, and composing
 * only the two advertised seams is wrong:
 *
 *   1. `aclVisibilityClause` — the fail-closed push-down grant predicate (#4768)
 *   2. `brainFactStatusClause` — content mode, i.e. REVIEW STATUS ONLY (#4769)
 *   3. `f.invalidated_at IS NULL` — the tombstone axis, which (2) explicitly
 *      does not cover
 *   4. `brainFactCurrentClause` — the SUPERSESSION axis (#4912), which neither
 *      (2) nor (3) covers: a superseded fact is still `published` and still
 *      not retracted; its `valid_to` is simply in the past
 *
 * ADR-0036 keeps retracted facts READABLE so "what we believed on Monday" still
 * answers, and #4772 made retraction the review gate's reject verb — so
 * retracted rows are routine, not hypothetical. A read that ANDs only (1) and
 * (2) serves withdrawn claims to the agent as current belief; one that skips
 * (4) serves SUPERSEDED claims — the belief a human explicitly replaced at the
 * publish gate — which on a trust-labeled surface is strictly worse.
 * `idx_brain_facts_subject` is partial on exactly `invalidated_at IS NULL`;
 * superseded rows stay IN the index (they are not tombstoned), so the same
 * index serves the four-predicate read with (4) applied as a filter over the
 * narrow candidate set the key columns already produced.
 *
 * ## How the four ADR-0036 gates land here, honestly
 *
 *   - **ACL grant** — composed explicitly via `aclVisibilityClause` on the two
 *     BRAIN stores. The document store has none, and that is ADR-0028's
 *     position rather than an omission here: `knowledge_documents` carries no
 *     per-row grant column to push a predicate against (see the header on
 *     `lib/knowledge/search.ts`). So a fused page mixes rows gated on two
 *     different axes — which is precisely why every row carries its tier: the
 *     label IS the statement of what gated the row. An unresolvable reader is
 *     still refused for the whole read, documents included.
 *   - **Residency** — invariant by construction; the process is the region.
 *   - **Content mode** — `brainFactStatusClause` for facts,
 *     `knowledgeStatusClause` for documents. Episodes have NO status column:
 *     they are immutable evidence, never review-gated, so there is nothing to
 *     compose and their absence from the mode axis is by design rather than by
 *     omission.
 *   - **Org/group reach (ADR-0022)** — NOT composed. A brain fact, an episode,
 *     and a KB document are all workspace-scoped with no connection-group
 *     binding, so there is no reach dimension to gate on. Composing one would
 *     mean inventing a group for rows that have none. If M2 gives a fact a
 *     group, this is the seam that grows a fifth clause (the supersession
 *     predicate took the fourth slot, #4912).
 *
 * ## Push-down, and why the fail-closed test is written as a negative
 *
 * Every predicate above is in the WHERE of its store's statement, and the FTS
 * match, the ranking expression, and the LIMIT all sit above that same WHERE. A
 * filter applied after ranking leaks existence through result counts and
 * latency even when the rows never render, which is why "no post-fetch
 * filtering" is an ACL requirement and not a performance note. The corollary
 * for tests: a reader who should see nothing must produce a query that CAN
 * return nothing.
 *
 * ## The episode is gated in its own right
 *
 * `brain_episodes` carries its own grant, derived independently of any fact's.
 * A claim extracted from a private channel can be granted `org` while the
 * message stays restricted to that channel's audience. This slice RETURNS
 * episodes as a TOP-LEVEL result class rather than as evidence attached to a
 * fact, so the episode predicate now decides what appears at all, not merely
 * what is redacted inside a row. It is a fresh `aclVisibilityClause` against
 * `brain_episodes`, never the fact's decision carried over — the same posture
 * `candidates.ts` takes for the review surface's evidence view.
 *
 * ## Scope
 *
 * FTS-first, per the M1 cut. Embeddings, RRF over dense lists, and rerank are
 * M4 — `fusion.ts` is the seam they extend, and there is no disabled embedding
 * path here to switch on. `in-tension-with` is surfaced as a conflict CLUSTER
 * (#4913): both directions, each visible counterpart with its own provenance,
 * invisible ones as a withheld count — and never ranked; arbitration belongs
 * to the human gate.
 *
 * ## `asOf` — the bi-temporal point read (#4916, ADR-0036 §Temporal)
 *
 * T4/T7's "what did we believe Monday": an optional `asOf` instant switches the
 * FACT store's temporal predicate from as-of-now to the point read
 * `valid_from <= asOf < COALESCE(valid_to, ∞)`, so a fact a later promotion
 * superseded answers again inside its own validity window — that is the point
 * of keeping superseded rows readable. Four boundary rules, all deliberate:
 *
 *   - **Tombstones stay hidden under ANY `asOf`.** Retraction is the only verb
 *     that hides history, and hiding history is what it is FOR (it is also the
 *     GDPR-erasure path) — so `invalidated_at IS NULL` survives in both
 *     branches, unconditionally.
 *   - **The ACL is the row's own frozen grant against as-of-NOW membership.**
 *     Each version carries the immutable `visible_to` it was published with,
 *     and `aclVisibilityClause` evaluates exactly that column per row — so
 *     "Monday's belief" is gated by Monday's grant with no code here doing
 *     anything: the bi-temporal ACL (T5) falls out of grant immutability. The
 *     reader's tokens, by contrast, are always resolved as of now — a member
 *     who since left an audience does not keep historical access through the
 *     read; membership is the live half and the revocation path.
 *   - **A NULL `valid_from` is an unrecorded start, not a late one.** The
 *     as-of-now read has no `valid_from` predicate at all — a fact with no
 *     recorded start IS served as current belief — so the point read must
 *     admit it too, or `asOf ≈ now()` would diverge from the default read.
 *   - **The default read is byte-identical to before #4916** — same clauses,
 *     same order, regression-pinned — and a malformed or future `asOf` is
 *     REJECTED with {@link BrainAsOfInvalidError}, never silently ignored: a
 *     caller who asked for history and silently got current belief would
 *     attribute today's claims to Monday.
 *
 * The episode and document stores are untouched by `asOf`: an episode is
 * append-only evidence of what was SAID (it has no validity window to point
 * into), and a KB document is deliberately outside the truth ordering. Only
 * the fact store makes claims about what was BELIEVED, so it is the only store
 * with a temporal axis to read against — and an `asOf` read that EXCLUDES the
 * fact store is refused outright, because echoing `asOf` over current-only
 * content would label it historical.
 *
 * One scope limit, stated so nobody reads more into the point read than it
 * does: metadata computed AT READ TIME — the decay signal, the corroboration
 * count, and the tension cluster — is evaluated as of NOW even on a historical
 * page. Those are advisory framing about the row as it stands today (how stale
 * it has since become, what has since come to contradict it), not part of the
 * belief being reported, and rewinding them would require versioned edges the
 * substrate does not keep.
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  aclVisibilityClause,
  logGrantAnomalies,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import { projectProvenance } from "@atlas/api/lib/brain/candidates";
import { attributionDecision } from "@atlas/api/lib/brain/attribution";
import { loadTensionClusters } from "@atlas/api/lib/brain/tensions";
import { computeDecaySignal, LAST_OBSERVED_AT_SELECT } from "@atlas/api/lib/brain/staleness";
import { fuseRankedLists, type RankedList } from "@atlas/api/lib/brain/fusion";
import {
  brainFactCurrentClause,
  brainFactStatusClause,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import {
  searchKnowledgeDocuments,
  type KnowledgeQueryExec,
  type KnowledgeSearchFilters,
} from "@atlas/api/lib/knowledge/search";
import { BRAIN_RESULT_TIERS } from "@useatlas/schemas";
import type { AtlasMode } from "@useatlas/types/auth";
import type {
  BrainDocumentNeighbor,
  BrainEpisodeExtraction,
  BrainEpisodeResult,
  BrainFactResult,
  BrainResultTier,
  BrainSearchResponse,
  BrainSearchResult,
  BrainSearchStoreReport,
  BrainSearchTensionView,
} from "@useatlas/types";

const log = createLogger("brain-search");

/** Surface tag on this module's `BrainReaderUnresolvedError` throws. */
const SEARCH_SURFACE = "search";

/** Default page size when the caller omits `limit`. */
export const DEFAULT_SEARCH_LIMIT = 10;
/** Hard cap on fused results returned. */
export const MAX_SEARCH_LIMIT = 50;

/**
 * Longest episode body served inline. Mirrors the review surface's cap for the
 * same reason — nothing at rest bounds an episode body, and clipping is
 * reported via `bodyTruncated` rather than done silently.
 */
export const EPISODE_BODY_MAX_CHARS = 4_000;

/**
 * Most `in-tension-with` edges resolved for one fused page.
 *
 * Smaller than the review surface's cap (500) on purpose: this budget is spent
 * on at most {@link MAX_SEARCH_LIMIT} facts feeding an LLM context window, not
 * on a 200-row admin table. When it bites, `tensionsTruncated` reaches the
 * caller AND the log — a truncated conflict list reads as "nothing contradicts
 * this", which is the one thing a trust-labeled surface must never imply.
 * Both caps feed the shared `loadTensionClusters` (`lib/brain/tensions.ts`).
 */
export const TENSION_FANOUT_CAP = 200;

/**
 * The database handle this module needs.
 *
 * Structurally satisfied by `InternalPoolClient`, `pg.Pool`, and
 * `pg.PoolClient`, so callers pass their existing handle straight through and
 * tests pass a literal — no `mock.module()`, no singleton to mutate. Mirrors
 * `BrainCandidateReader` / `AudienceMembershipReader`.
 *
 * `searchBrainCore` issues its three store reads concurrently, which assumes a
 * POOL. `node-postgres` serializes queries on a single client, so passing a
 * `PoolClient` silently degrades the fan-out to sequential — correct, just
 * slower, and worth knowing before blaming the query.
 */
export interface BrainSearchReader {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

export interface BrainSearchOptions {
  readonly ctx: BrainPrincipalContext;
  /** Content mode for the review-gated stores (facts, documents). */
  readonly mode: AtlasMode;
  /** Free-text lexical query. Blank/absent ⇒ recency-ordered browse per store. */
  readonly query?: string;
  /**
   * Which stores to read. Defaults to all three; an empty list reads none.
   *
   * NOTE the tool wrapper overrides that last case: `normalizeSearchInput`
   * turns an empty or fully-unrecognized `include` into `undefined` (all
   * three), because a typo returning an empty page is indistinguishable from an
   * empty brain. A non-tool caller passing `[]` gets the literal reading.
   */
  readonly include?: readonly BrainResultTier[];
  /** OKF frontmatter narrowing — document store only. */
  readonly type?: string;
  readonly tags?: readonly string[];
  readonly collection?: string;
  readonly since?: string;
  /**
   * Bi-temporal point read (#4916): the ISO-8601 instant to answer for.
   * Fact store only — see the module header. Validated by
   * {@link parseBrainAsOf}; malformed or future values THROW rather than fall
   * through to as-of-now. Absent ⇒ current belief, unchanged.
   */
  readonly asOf?: string;
  /** Include the 1-hop KB link-graph expansion of matched documents. */
  readonly expand: boolean;
  readonly limit: number;
  readonly requestId?: string;
}

// ---------------------------------------------------------------------------
// asOf validation (#4916)
// ---------------------------------------------------------------------------

/**
 * A caller-supplied `asOf` this read refuses to honor.
 *
 * A dedicated class rather than a bare `Error` so the tool wrapper can map it
 * to its machine-readable reason (`invalid_as_of`) by `instanceof`, the same
 * seam `BrainReaderIdentityError` rides — never by matching the prose, which
 * is user-facing and free to change.
 */
export class BrainAsOfInvalidError extends Error {
  override readonly name = "BrainAsOfInvalidError";
  constructor(message: string) {
    super(message);
  }
}

declare const brainAsOfBrand: unique symbol;
/**
 * An instant that has been through {@link parseBrainAsOf} — normalized
 * ISO-8601 UTC, in the past, inside `timestamptz` range. The brand makes
 * "validated" a compile-time property of {@link buildFactQuery}'s input rather
 * than a doc-comment precondition, and keeps the UNVALIDATED sibling params
 * (`since`, the documents filter) unpassable where `asOf` belongs.
 */
export type BrainAsOfInstant = string & { readonly [brainAsOfBrand]: true };

/**
 * The accepted spellings: a bare ISO date (`YYYY-MM-DD`, read as UTC midnight
 * per ECMA-262 — deterministic), or a timestamp with an EXPLICIT zone.
 *
 * Deliberately stricter than `new Date()`, which this feeds: bare `Date`
 * parsing admits `"July 2026"` and — worse — reads a zone-less
 * `"2026-07-27T09:00"` in the SERVER's local timezone, so the same call would
 * answer a different instant per deployment. A silent hours-scale shift of the
 * point read is the same class of failure as the silent fall-through this
 * function exists to refuse, so a time without a zone is malformed here.
 */
const AS_OF_SHAPE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|z|[+-]\d{2}:?\d{2}))?$/;

/**
 * Everything `timestamptz` can hold starts here: Postgres admits no year zero
 * (and no negative years in ISO input), so a JS-parseable instant below this
 * would pass validation only to fail the bind at query time — surfacing as a
 * retryable internal fault when it is really the caller's argument.
 */
const AS_OF_FLOOR_MS = Date.parse("0001-01-01T00:00:00Z");

/** Longest slice of a rejected value echoed back — a bound on message/log size, not a policy. */
const AS_OF_ECHO_CAP = 64;

/**
 * Validate and normalize a caller-supplied `asOf`, or throw
 * {@link BrainAsOfInvalidError}.
 *
 * FAIL CLOSED, per the issue's boundary rule: a value the caller plainly meant
 * as a point-read instant but that cannot be honored must never degrade to the
 * as-of-now read — the caller would attribute today's beliefs to the instant
 * they asked about, silently. So blank, non-ISO, zone-less, out-of-range, and
 * FUTURE values are all refusals with a message naming the value and the fix.
 * Future bounds are refused rather than clamped because `valid_from` can
 * legitimately sit in the future (a region import restores it verbatim), so a
 * future point read is not "the same as now" — it is a question about beliefs
 * not yet held, which this surface does not answer.
 *
 * Returns the instant normalized to ISO-8601 UTC: it is bound as a
 * `timestamptz` parameter and echoed on the response, and both should carry
 * the canonical spelling rather than whatever the caller typed.
 */
export function parseBrainAsOf(raw: string, now: () => number = Date.now): BrainAsOfInstant {
  const trimmed = raw.trim();
  // The caller's own input, so echoing it back is safe — but it is unbounded,
  // so the echo is capped rather than pasted verbatim into an error message
  // and a warn line.
  const shown =
    trimmed.length > AS_OF_ECHO_CAP ? `${trimmed.slice(0, AS_OF_ECHO_CAP)}…` : trimmed;
  if (trimmed === "") {
    throw new BrainAsOfInvalidError(
      "asOf was blank. Pass an ISO-8601 instant (e.g. 2026-07-27T09:00:00Z) for a historical read, or omit asOf entirely for current beliefs.",
    );
  }
  if (!AS_OF_SHAPE.test(trimmed)) {
    throw new BrainAsOfInvalidError(
      `asOf ${JSON.stringify(shown)} is not an ISO-8601 instant. Pass a date (2026-07-27) or a timestamp with an explicit zone (2026-07-27T09:00:00Z) — a time without a zone would be read in the server's timezone, so it is rejected. Omit asOf for current beliefs.`,
    );
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    // Shape-valid but field-invalid — a 13th month, a 25th hour.
    throw new BrainAsOfInvalidError(
      `asOf ${JSON.stringify(shown)} is not a real instant — a field is out of range. Pass a valid ISO-8601 instant (e.g. 2026-07-27T09:00:00Z), or omit asOf for current beliefs.`,
    );
  }
  if (parsed.getTime() < AS_OF_FLOOR_MS) {
    throw new BrainAsOfInvalidError(
      `asOf ${JSON.stringify(shown)} is before 0001-01-01, which the database cannot represent. Pass an instant on or after 0001-01-01T00:00:00Z.`,
    );
  }
  if (parsed.getTime() > now()) {
    throw new BrainAsOfInvalidError(
      `asOf ${parsed.toISOString()} is in the future. As-of reads answer what was believed at a past instant; omit asOf for current beliefs.`,
    );
  }
  return parsed.toISOString() as BrainAsOfInstant;
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Counter off `pg`, with the drift arm LOGGED.
 *
 * `0` is the conservative value but not a harmless one: `corroborationCount: 0`
 * on a corroborated claim understates the evidence behind it, which on a
 * trust-labeled surface is the same class of harm the `cardinality` fallback
 * logs for.
 */
function count(value: unknown, field: string, workspaceId: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  log.warn(
    { workspaceId, field, value },
    "brain search: counter column did not decode as a non-negative number — reporting 0, which understates it",
  );
  return 0;
}

/**
 * Fact status off `pg`, narrowed without a cast.
 *
 * `chk_brain_facts_status` makes an out-of-vocabulary value unreachable from
 * the database, so a hit is query drift — logged, and coerced to the
 * conservative arm. `draft` is conservative here: an unknown status must never
 * present to an agent as reviewed.
 */
function factStatus(value: unknown, rowId: string, workspaceId: string) {
  if (value === "draft" || value === "published" || value === "archived") return value;
  log.warn(
    { rowId, workspaceId, status: value },
    "brain search: fact carries a status outside the vocabulary — labelling it a draft",
  );
  return "draft" as const;
}

/** Cardinality off `pg`. `multi` is the fallback and UNDERSTATES conflict — hence the log. */
function cardinality(value: unknown, rowId: string, workspaceId: string) {
  if (value === "single" || value === "multi") return value;
  log.warn(
    { rowId, workspaceId, cardinality: value },
    "brain search: fact carries a predicate cardinality outside the vocabulary — reporting `multi`, which understates any conflict",
  );
  return "multi" as const;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Corroboration = DISTINCT `provenance` edges (fact → episode), never a row
 * count. Re-observing a claim adds an edge; it never duplicates the fact, so a
 * row count would report 1 forever. Same derivation as the review surface.
 */
const CORROBORATION_SELECT = `(
    SELECT COUNT(DISTINCT ed.to_episode_id)
      FROM brain_edges ed
     WHERE ed.workspace_id = f.workspace_id
       AND ed.edge_type = 'provenance'
       AND ed.from_fact_id = f.id
  )::int`;

const FACT_COLUMNS = `f.id::text AS id,
         f.subject,
         f.predicate,
         f.object,
         f.status,
         f.predicate_cardinality,
         f.visible_to,
         f.pre_widening_visible_to,
         f.provenance,
         f.source_episode_id::text AS source_episode_id,
         f.valid_from,
         f.valid_to,
         f.invalidated_at,
         f.ingested_at`;

/**
 * The tier-2 statement.
 *
 * `aclSql` is already parenthesised and carries the reader's bound tokens; it
 * is AND-ed into the WHERE alongside the mode clause and the tombstone filter
 * — never applied to the rows afterwards. The lexical match, `ts_rank`, and the
 * LIMIT all sit above the same WHERE, so an unreadable row is never ranked,
 * never counted, and never contributes latency.
 */
export function buildFactQuery(
  mode: AtlasMode,
  options: {
    query?: string;
    limit: number;
    aclSql: string;
    aclParams: readonly unknown[];
    /**
     * A point-read instant, or absent for the as-of-now read. The brand means
     * it can only come from {@link parseBrainAsOf} — "validated" is a
     * compile-time property here, not a doc-comment plea.
     */
    asOf?: BrainAsOfInstant;
  },
): { sql: string; params: unknown[] } {
  const params: unknown[] = [...options.aclParams];
  const where: string[] = [
    options.aclSql,
    brainFactStatusClause(mode, "f"),
    // NOT redundant with the mode clause — see the module header. Without it
    // the agent is served retracted claims as current belief. Deliberately in
    // BOTH temporal branches: a tombstone is hidden under any `asOf`, because
    // retraction is the one verb whose JOB is hiding history (#4916).
    "f.invalidated_at IS NULL",
  ];
  if (options.asOf !== undefined) {
    // The bi-temporal point read (#4916): the facts valid AT the instant —
    // `valid_from <= asOf < COALESCE(valid_to, ∞)`. A superseded fact answers
    // again inside its window (that is the point of keeping it readable); a
    // NULL `valid_from` is an unrecorded start and is admitted, matching the
    // default read's treatment of the same rows — see the module header.
    // One bound parameter, referenced by both bounds, so the two sides of the
    // window cannot be handed different instants.
    params.push(options.asOf);
    const asOfParam = `$${params.length}::timestamptz`;
    where.push(
      `(f.valid_from IS NULL OR f.valid_from <= ${asOfParam})`,
      `(f.valid_to IS NULL OR f.valid_to > ${asOfParam})`,
    );
  } else {
    // The FOURTH predicate (#4912): a fact whose `valid_to` has passed was
    // superseded at the publish gate and is no longer current belief. Hidden
    // exactly as tombstones are — the row stays readable to the `asOf` branch
    // above, and this default read is as-of-now.
    where.push(brainFactCurrentClause("f"));
  }

  const trimmed = options.query?.trim();
  let tsq: string | null = null;
  if (trimmed) {
    params.push(trimmed);
    tsq = `websearch_to_tsquery('english', $${params.length})`;
    where.push(`f.fts @@ ${tsq}`);
  }

  // The claim is short, so the headline runs over the reconstructed sentence
  // rather than a body column — it is what a caller reads to see WHY the row
  // matched, and a fact has no prose to excerpt.
  const snippetExpr = tsq
    ? `ts_headline('english', f.subject || ' ' || f.predicate || ' ' || f.object, ${tsq},
        'StartSel=**, StopSel=**, MaxFragments=1, MaxWords=28, MinWords=4')`
    : `NULL`;
  const rankExpr = tsq ? `ts_rank(f.fts, ${tsq})` : `NULL`;
  const orderBy = tsq
    ? `rank DESC NULLS LAST, f.ingested_at DESC, f.id DESC`
    : `f.ingested_at DESC, f.id DESC`;

  params.push(options.limit);
  // `last_observed_at` feeds the read-time decay signal (#4914). It is a
  // SELECTed column only — never in this WHERE and never in ORDER BY, because
  // retrieval ranking by age would be exactly the arbitration decay is
  // forbidden to do. The agent is handed the age and told to present it.
  const sql = `SELECT ${FACT_COLUMNS},
         ${CORROBORATION_SELECT} AS corroboration_count,
         ${LAST_OBSERVED_AT_SELECT} AS last_observed_at,
         ${snippetExpr} AS snippet,
         ${rankExpr} AS rank
    FROM brain_facts f
   WHERE ${where.join("\n     AND ")}
   ORDER BY ${orderBy}
   LIMIT $${params.length}`;

  return { sql, params };
}

/**
 * The tier-3 statement.
 *
 * No content-mode clause: `brain_episodes` has no `status` column. Episodes are
 * append-only evidence and are never review-gated — the ACL grant is the whole
 * gate, and it is a FRESH clause against `brain_episodes`, never the fact
 * predicate reused.
 *
 * No `extracted_at` filter either, and that is the committed behavior rather
 * than an omission: an unextracted episode is returned and LABELLED
 * `extraction: pending`. With the extraction fiber default-OFF, that is the
 * only thing the brain half of a fresh deployment can return.
 */
export function buildEpisodeQuery(options: {
  query?: string;
  limit: number;
  aclSql: string;
  aclParams: readonly unknown[];
}): { sql: string; params: unknown[] } {
  const params: unknown[] = [...options.aclParams];
  const where: string[] = [options.aclSql];

  const trimmed = options.query?.trim();
  let tsq: string | null = null;
  if (trimmed) {
    params.push(trimmed);
    tsq = `websearch_to_tsquery('english', $${params.length})`;
    where.push(`e.fts @@ ${tsq}`);
  }

  // Body XOR locator (0180's CHECK), so the coalesce picks whichever the row
  // actually has and never concatenates two sources of evidence.
  const snippetExpr = tsq
    ? `ts_headline('english', coalesce(e.body, e.locator, ''), ${tsq},
        'StartSel=**, StopSel=**, MaxFragments=2, MaxWords=28, MinWords=8')`
    : `NULL`;
  const rankExpr = tsq ? `ts_rank(e.fts, ${tsq})` : `NULL`;
  const recency = `coalesce(e.occurred_at, e.ingested_at)`;
  const orderBy = tsq
    ? `rank DESC NULLS LAST, ${recency} DESC, e.id DESC`
    : `${recency} DESC, e.id DESC`;

  params.push(options.limit);
  const sql = `SELECT e.id::text AS id,
         e.source,
         e.source_id,
         e.source_actor,
         e.body,
         e.locator,
         e.occurred_at,
         e.ingested_at,
         e.extracted_at,
         e.visible_to,
         ${snippetExpr} AS snippet,
         ${rankExpr} AS rank
    FROM brain_episodes e
   WHERE ${where.join("\n     AND ")}
   ORDER BY ${orderBy}
   LIMIT $${params.length}`;

  return { sql, params };
}

// ---------------------------------------------------------------------------
// Row projection
// ---------------------------------------------------------------------------

/**
 * A `brain_facts` row off `pg`.
 *
 * `subject` / `predicate` / `object` are typed `string` and read without
 * narrowing — trusting a column is the exception in this otherwise uniformly
 * `unknown`-in file, justified by `text NOT NULL` in migration 0180. The
 * tension path makes the identical exception through `TensionCounterpartRow`
 * (`lib/brain/tensions.ts`), so the two row shapes agree about which columns
 * are trusted and why.
 */
interface FactRow {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly status: unknown;
  readonly predicate_cardinality: unknown;
  readonly visible_to: unknown;
  /** ACL input for provenance attribution — see `AttributionRow` (#4836). */
  readonly pre_widening_visible_to: unknown;
  readonly provenance: unknown;
  readonly source_episode_id: string | null;
  readonly valid_from: unknown;
  readonly valid_to: unknown;
  readonly invalidated_at: unknown;
  readonly ingested_at: unknown;
  readonly corroboration_count: unknown;
  /** Newest corroborating observation — the decay anchor (#4914). */
  readonly last_observed_at: unknown;
  readonly snippet: unknown;
}

/**
 * `tier` and `trustTier` are written here, at the one seam every fact row
 * passes through. The type makes an unlabeled row unrepresentable; this makes
 * it unconstructible in practice too.
 *
 * Takes the whole reader CONTEXT rather than a bare `workspaceId`, which it
 * used to, because provenance attribution is now an entitlement decision
 * (#4836) and not a projection. This is the surface that makes #4836 a
 * user-visible disclosure rather than an admin-queue one: `searchBrain` feeds
 * agent chat answers, so a widened fact reaching an org reader here would hand
 * them a private channel's first speaker without anyone opening
 * `/admin/brain-facts`.
 */
function toFactResult(
  row: FactRow,
  ctx: BrainPrincipalContext,
  tensions: readonly BrainSearchTensionView[],
  requestId?: string,
): BrainFactResult {
  const workspaceId = ctx.workspaceId;
  // One decision, both consumers — provenance and decay must agree about this
  // reader's entitlement to the "when" (#4836, #4914).
  const attribution = attributionDecision(row, ctx, requestId);
  if (row.last_observed_at === undefined) {
    // Selected-column drift on the decay anchor — the classifier reports
    // "age unknown" instead of anchoring on ingest recency, and this is the
    // log line that makes that degradation findable. Same posture as
    // `attributionDecision`'s missing-column arm.
    log.warn(
      { rowId: row.id, workspaceId, requestId },
      "brain search: `last_observed_at` absent from the row — the fact query no longer selects the decay anchor; reporting age unknown",
    );
  }
  return {
    tier: "fact",
    trustTier: 2,
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    predicateCardinality: cardinality(row.predicate_cardinality, row.id, workspaceId),
    status: factStatus(row.status, row.id, workspaceId),
    validFrom: iso(row.valid_from),
    validTo: iso(row.valid_to),
    ingestedAt: iso(row.ingested_at),
    snippet: str(row.snippet),
    provenance: projectProvenance(row.provenance, row.source_episode_id, attribution),
    corroborationCount: count(row.corroboration_count, "corroboration_count", workspaceId),
    decay: computeDecaySignal(
      {
        lastObservedAt: row.last_observed_at,
        validFrom: row.valid_from,
        ingestedAt: row.ingested_at,
      },
      attribution,
    ),
    tensions,
  };
}

function toEpisodeResult(row: Record<string, unknown>, id: string): BrainEpisodeResult {
  const body = typeof row.body === "string" ? row.body : null;
  const bodyTruncated = body !== null && body.length > EPISODE_BODY_MAX_CHARS;
  const extractedAt = iso(row.extracted_at);
  // The committed edge behavior, as ONE value: `extracted_at IS NULL` ⇒ the
  // extraction pass has not run, so the row is raw and says so. Built as a pair
  // because `BrainEpisodeExtraction` is a union — the label and the timestamp
  // cannot be set to disagree.
  const extraction: BrainEpisodeExtraction =
    extractedAt === null
      ? { extraction: "pending", extractedAt: null }
      : { extraction: "complete", extractedAt };
  return {
    tier: "raw-episode",
    trustTier: 3,
    id,
    // `source` / `source_id` are `text NOT NULL`, so the fallbacks are
    // unreachable from the database. They exist so query drift degrades a label
    // rather than throwing mid-projection — and `sourceId` in particular is the
    // stable pointer ADR-0036 commits to alongside `extraction: pending`, so an
    // empty one would silently strip the caller's only handle on the record.
    source: str(row.source) ?? "",
    sourceId: str(row.source_id) ?? "",
    sourceActor: str(row.source_actor),
    body: bodyTruncated ? body.slice(0, EPISODE_BODY_MAX_CHARS) : body,
    bodyTruncated,
    locator: str(row.locator),
    occurredAt: iso(row.occurred_at),
    ingestedAt: iso(row.ingested_at),
    snippet: str(row.snippet),
    ...extraction,
  };
}

// ---------------------------------------------------------------------------
// Tension lookup
// ---------------------------------------------------------------------------

/**
 * The conflict clusters for the facts on this page — both directions, never
 * ranked (#4913).
 *
 * The walk — edges, then counterpart facts through a FRESH fact predicate,
 * never a join onto the owner row — is `loadTensionClusters`
 * (`lib/brain/tensions.ts`, shared with the review queue). What stays here is
 * the SEARCH projection, which differs from the review surface's in both arms:
 *
 *   - A VISIBLE counterpart carries the full claim WITH its provenance — the
 *     T4 stance is surfaced-both-with-provenance, so the agent can present
 *     each side with its evidence. Attribution is re-decided per counterpart
 *     row (#4836): a counterpart is a fact in its own right, fetched through
 *     its own ACL predicate, so inheriting the owner's decision would be a
 *     guess about a different row's grant. Status, corroboration, and recency
 *     travel as surfacing hints; none of them orders anything.
 *   - Counterparts the reader may NOT see collapse into ONE
 *     `{ visible: false, withheldCount }` entry, appended after the
 *     id-sorted counterparts. Aggregated because this surface feeds an LLM
 *     context window, where N identical opaque handles spend tokens without
 *     adding information — the count IS the signal, and it is never dropped:
 *     an omitted conflict reads as "nothing contradicts this".
 *
 * `invalidated_at` is deliberately NOT filtered on the counterpart — a rival
 * that was retracted is still why this claim was contested — but it IS carried,
 * because retraction never writes `status` and an unlabeled withdrawn rival is
 * indistinguishable from a live one. `valid_to` is not filtered either, for
 * the same reason on the supersession axis (#4912): a rival that was
 * superseded is still why the claim was contested.
 */
async function loadTensions(
  db: BrainSearchReader,
  factIds: readonly string[],
  ctx: BrainPrincipalContext,
  requestId: string | undefined,
): Promise<{ views: Map<string, BrainSearchTensionView[]>; truncated: boolean }> {
  const { clusters, truncated } = await loadTensionClusters(db, factIds, {
    ctx,
    cap: TENSION_FANOUT_CAP,
    surface: SEARCH_SURFACE,
    log,
    requestId,
  });

  const views = new Map<string, BrainSearchTensionView[]>();
  for (const [owner, cluster] of clusters) {
    const list: BrainSearchTensionView[] = cluster.counterparts.map(({ row, direction }) => ({
      visible: true,
      factId: row.id,
      edgeDirection: direction,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      status: factStatus(row.status, row.id, ctx.workspaceId),
      validFrom: iso(row.valid_from),
      ingestedAt: iso(row.ingested_at),
      invalidatedAt: iso(row.invalidated_at),
      corroborationCount: count(row.corroboration_count, "corroboration_count", ctx.workspaceId),
      provenance: projectProvenance(
        row.provenance,
        row.source_episode_id,
        attributionDecision(row, ctx, requestId),
      ),
    }));
    if (cluster.withheld.length > 0) {
      // DISTINCT rivals, not edge-ends: `reconcile.ts`'s `WHERE NOT EXISTS`
      // dedupes one direction only, so a raced reciprocal pair (A→B and B→A)
      // is representable and would otherwise report one hidden rival as two.
      // The count is the whole signal this arm carries; overstating it is the
      // one way it can lie.
      const withheldRivals = new Set(cluster.withheld.map((w) => w.factId)).size;
      list.push({ visible: false, withheldCount: withheldRivals });
    }
    views.set(owner, list);
  }

  return { views, truncated };
}

// ---------------------------------------------------------------------------
// Fusion inputs
// ---------------------------------------------------------------------------

/**
 * Stable identity for a fused row.
 *
 * Prefixed by class because the three stores mint ids in different namespaces:
 * a fact uuid and an episode uuid can never collide, but a document is keyed by
 * `collection/path` and an unprefixed key would let a pathological path shadow
 * a uuid. Cheap, and it makes the M4 case (one row surfaced by both a lexical
 * and a dense list) unambiguous.
 */
function resultKey(result: BrainSearchResult): string {
  switch (result.tier) {
    case "fact":
      return `fact:${result.id}`;
    case "raw-episode":
      return `episode:${result.id}`;
    case "document":
      return `document:${result.collection}/${result.path}`;
    default: {
      // Compile error if a fourth class is added without a key rule; at runtime
      // a class arriving through a cast gets a distinct key rather than
      // colliding with a real row.
      const unexpected: never = result;
      return `unknown:${JSON.stringify(unexpected)}`;
    }
  }
}

/**
 * Total order over equally-relevant rows: trust tier first, then key.
 *
 * The ONLY place trust touches ordering, and only as a tiebreak — never as a
 * score weight. See `fusion.ts` for why. `BRAIN_RESULT_TIERS` supplies the
 * order so the tuple and the tiebreak cannot disagree.
 */
function tierRank(tier: BrainResultTier): number {
  const index = BRAIN_RESULT_TIERS.indexOf(tier);
  // `-1` would sort an unknown tier FIRST — i.e. most trusted. Unreachable from
  // the type; matched to `resultKey`'s posture for a value arriving via a cast.
  return index === -1 ? BRAIN_RESULT_TIERS.length : index;
}

function tiebreak(a: BrainSearchResult, b: BrainSearchResult): number {
  const byTier = tierRank(a.tier) - tierRank(b.tier);
  if (byTier !== 0) return byTier;
  return resultKey(a).localeCompare(resultKey(b));
}

const UNQUERIED_STORE: BrainSearchStoreReport = { queried: false };

/** `matched` is the store's contribution BEFORE the global limit clamps the page. */
function queriedStore(matched: number, limit: number): BrainSearchStoreReport {
  return { queried: true, matched, truncated: matched >= limit };
}

// ---------------------------------------------------------------------------
// The fused read
// ---------------------------------------------------------------------------

/**
 * Run the fused read.
 *
 * Pure of request context and the AI SDK, so it is directly unit-testable and
 * the tool wrapper stays a thin adapter. The two brain stores share ONE
 * principal context and each derive their own clause from it.
 *
 * @throws {BrainReaderUnresolvedError} when the reader has no usable
 *   principals. Deliberately not degraded to an empty result set: an agent told
 *   "the brain holds nothing about this" answers from the model's priors, which
 *   is the failure a trust-labeled surface exists to prevent.
 * @throws {BrainAsOfInvalidError} when `asOf` is malformed or in the future —
 *   fail closed, never fall through to as-of-now (#4916).
 */
export async function searchBrainCore(
  db: BrainSearchReader,
  options: BrainSearchOptions,
): Promise<BrainSearchResponse> {
  const { ctx, mode, requestId } = options;
  const limit = Math.min(Math.max(1, Math.trunc(options.limit)), MAX_SEARCH_LIMIT);
  const include = new Set(options.include ?? BRAIN_RESULT_TIERS);

  const wantFacts = include.has("fact");
  const wantEpisodes = include.has("raw-episode");
  const wantDocuments = include.has("document");

  // Validated FIRST, before any store runs: an unusable point-read instant is
  // the caller's input problem and must be reported as such, not spent a
  // fan-out on. Throws — see parseBrainAsOf on why it never degrades.
  const asOf = options.asOf === undefined ? undefined : parseBrainAsOf(options.asOf);
  if (asOf !== undefined && !wantFacts) {
    // A temporal question aimed only at stores with no temporal axis. Serving
    // the current documents/episodes under an echoed `asOf` would label
    // as-of-now content as a historical page — mislabeling on the one surface
    // whose labels are the product — and silently dropping the parameter is
    // the fall-through this module refuses. Same fail-closed verb as every
    // other unusable asOf.
    throw new BrainAsOfInvalidError(
      'asOf was passed but `include` excludes "fact" — only reviewed facts have a validity window to read against. Add "fact" to include, or omit asOf.',
    );
  }

  // Resolved UNCONDITIONALLY, before any store runs, and the refusal is the
  // single gate for the whole read. Deliberately not scoped to
  // `wantFacts || wantEpisodes`: an unresolvable reader identity is an upstream
  // defect, not a permission boundary, and serving such a reader the document
  // store — which carries no per-row grant of its own — because they happened
  // to pass `include: ["document"]` would make the refusal a function of the
  // caller's arguments. Both brain stores derive from this same context, so one
  // decision covers all three.
  const factAcl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });
  if (factAcl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, SEARCH_SURFACE);
  }

  const documentFilters: KnowledgeSearchFilters = {
    query: options.query,
    type: options.type,
    tags: options.tags,
    collection: options.collection,
    since: options.since,
    limit,
    expand: options.expand,
  };

  // The three stores are independent reads over one internal database; running
  // them concurrently is what keeps a fused page as fast as its slowest store
  // rather than as slow as their sum.
  const [factRows, episodeRows, documentStore] = await Promise.all([
    wantFacts
      ? (async (acl: typeof factAcl) => {
          const built = buildFactQuery(mode, {
            query: options.query,
            limit,
            aclSql: acl.sql,
            aclParams: acl.params,
            asOf,
          });
          const result = await db.query(built.sql, built.params);
          return result.rows as FactRow[];
        })(factAcl)
      : null,
    wantEpisodes
      ? (async () => {
          // A FRESH clause against `brain_episodes` — the fact's decision does
          // not carry over. See the module header.
          const acl = aclVisibilityClause(ctx, {
            table: "brain_episodes",
            alias: "e",
            paramIndex: 1,
            requestId,
          });
          if (acl.decision === "deny-all") {
            throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, SEARCH_SURFACE);
          }
          const built = buildEpisodeQuery({
            query: options.query,
            limit,
            aclSql: acl.sql,
            aclParams: acl.params,
          });
          const result = await db.query(built.sql, built.params);
          return result.rows as Record<string, unknown>[];
        })()
      : null,
    wantDocuments
      ? searchKnowledgeDocuments({
          workspaceId: ctx.workspaceId,
          mode,
          filters: documentFilters,
          // `BrainSearchReader` returns `{ rows }`; the document store wants
          // the flat-array executor shape. Adapting here keeps ONE handle
          // threaded through the whole read rather than two.
          exec: ((sql, params) =>
            db.query(sql, params).then((r) => r.rows)) as KnowledgeQueryExec,
        })
      : null,
  ]);

  // Same treatment the episode rows get below, and for the same reason: `id` is
  // the PK cast to text in the SELECT, so a missing one is query drift rather
  // than tenant data. It matters MORE on this path — a non-string `id` would
  // reach `loadTensionClusters`' `$2::uuid[]` and fail the whole read with the
  // generic message, and would collapse every malformed row onto one
  // `fact:undefined` fusion key.
  const facts = (factRows ?? []).filter((row) => {
    if (typeof row.id === "string" && row.id !== "") return true;
    log.warn(
      { workspaceId: ctx.workspaceId, requestId },
      "brain search: fact row has no usable id — the fact query shape changed; dropping the row",
    );
    return false;
  });
  const factIds = facts.map((r) => r.id);
  const tensions = wantFacts
    ? await loadTensions(db, factIds, ctx, requestId)
    : { views: new Map<string, BrainSearchTensionView[]>(), truncated: false };

  // The partially-malformed-grant observation seam (`acl.ts`). These are rows
  // the reader ALREADY holds, so this costs no extra fetch — and it catches the
  // grant that passed the predicate on one valid token while carrying a second
  // the author believed was doing something. It does NOT touch #4797, whose gap
  // is the ENTIRELY malformed grant: such a row matches no reader token, so it
  // never comes back from an ACL-gated SELECT and goes unlogged here too.
  const factResults: BrainFactResult[] = facts.map((row) => {
    if (Array.isArray(row.visible_to)) {
      logGrantAnomalies(row.visible_to as readonly unknown[], {
        table: "brain_facts",
        rowId: row.id,
        workspaceId: ctx.workspaceId,
        requestId,
      });
    } else {
      // `visible_to text[] NOT NULL`, so a non-array is drift on the ACL's own
      // column. Never silent: it means the grant observation seam skipped a row
      // it was supposed to inspect.
      log.warn(
        { workspaceId: ctx.workspaceId, rowId: row.id, requestId, actualType: typeof row.visible_to },
        "brain search: fact `visible_to` did not decode as an array — the grant could not be inspected",
      );
    }
    return toFactResult(row, ctx, tensions.views.get(row.id) ?? [], requestId);
  });

  const episodeResults: BrainEpisodeResult[] = [];
  for (const raw of episodeRows ?? []) {
    const id = typeof raw.id === "string" ? raw.id : null;
    if (!id) {
      // `id` is the PK cast to text in the SELECT, so this is query drift, not
      // data. Skipped rather than fatal — one unattributable evidence row must
      // not fail a whole fused read — but never silent.
      log.warn(
        { workspaceId: ctx.workspaceId, requestId },
        "brain search: episode row has no usable id — the episode query shape changed; dropping the row",
      );
      continue;
    }
    if (Array.isArray(raw.visible_to)) {
      logGrantAnomalies(raw.visible_to as readonly unknown[], {
        table: "brain_episodes",
        rowId: id,
        workspaceId: ctx.workspaceId,
        requestId,
      });
    } else {
      log.warn(
        { workspaceId: ctx.workspaceId, rowId: id, requestId, actualType: typeof raw.visible_to },
        "brain search: episode `visible_to` did not decode as an array — the grant could not be inspected",
      );
    }
    episodeResults.push(toEpisodeResult(raw, id));
  }

  const documents = documentStore?.documents ?? [];
  const neighbors: readonly BrainDocumentNeighbor[] = documentStore?.neighbors ?? [];

  // One list per store — see `fusion.ts` on why these are rank-position fused
  // and what M4 adds. Each list is ALREADY ACL- and mode-gated by its own
  // WHERE; fusion only orders rows the reader was entitled to fetch.
  const lists: RankedList<BrainSearchResult>[] = [];
  if (wantFacts) lists.push({ label: "facts:lexical", items: factResults });
  if (wantEpisodes) lists.push({ label: "episodes:lexical", items: episodeResults });
  if (wantDocuments) lists.push({ label: "documents:lexical", items: documents });

  const fused = fuseRankedLists(lists, { key: resultKey, tiebreak }).slice(0, limit);

  return {
    results: fused,
    neighbors,
    stores: {
      fact: wantFacts ? queriedStore(factResults.length, limit) : UNQUERIED_STORE,
      "raw-episode": wantEpisodes
        ? queriedStore(episodeResults.length, limit)
        : UNQUERIED_STORE,
      // The document store reports its OWN truncation — it applies the seed
      // limit inside `searchKnowledgeDocuments`, so the row count here is
      // already post-limit and `>= limit` would be a second, redundant guess.
      document: wantDocuments
        ? { queried: true, matched: documents.length, truncated: documentStore?.truncated ?? false }
        : UNQUERIED_STORE,
    },
    tensionsTruncated: tensions.truncated,
    // Echoed ONLY on an as-of read — spreading rather than `asOf: asOf` keeps
    // the default response byte-identical to pre-#4916, and makes the field's
    // absence itself the "these are current beliefs" statement.
    ...(asOf !== undefined ? { asOf } : {}),
  };
}
