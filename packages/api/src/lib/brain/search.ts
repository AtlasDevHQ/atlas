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
 * ## The trap: three gates, and the one that is not a gate
 *
 * A current-belief fact read composes THREE predicates, and composing only the
 * two advertised seams is wrong:
 *
 *   1. `aclVisibilityClause` — the fail-closed push-down grant predicate (#4768)
 *   2. `brainFactStatusClause` — content mode, i.e. REVIEW STATUS ONLY (#4769)
 *   3. `f.invalidated_at IS NULL` — the tombstone axis, which (2) explicitly
 *      does not cover
 *
 * ADR-0036 keeps retracted facts READABLE so "what we believed on Monday" still
 * answers, and #4772 made retraction the review gate's reject verb — so
 * retracted rows are routine, not hypothetical. A read that ANDs only (1) and
 * (2) serves withdrawn claims to the agent as current belief.
 * `idx_brain_facts_subject` is partial on exactly `invalidated_at IS NULL`, so
 * the index is built for the correct predicate.
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
 *     group, this is the seam that grows a fourth clause.
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
 * path here to switch on. `asOf` bi-temporal point reads are M2's, alongside
 * the rest of the conflict machinery; this read is as-of-now. `in-tension-with`
 * is surfaced in BOTH directions and never ranked.
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  aclVisibilityClause,
  logGrantAnomalies,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import { projectProvenance } from "@atlas/api/lib/brain/candidates";
import { fuseRankedLists, type RankedList } from "@atlas/api/lib/brain/fusion";
import { brainFactStatusClause } from "@atlas/api/lib/content-mode/adapters/brain-facts";
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
  BrainFactTensionDirection,
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
  /** Include the 1-hop KB link-graph expansion of matched documents. */
  readonly expand: boolean;
  readonly limit: number;
  readonly requestId?: string;
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
  options: { query?: string; limit: number; aclSql: string; aclParams: readonly unknown[] },
): { sql: string; params: unknown[] } {
  const params: unknown[] = [...options.aclParams];
  const where: string[] = [
    options.aclSql,
    brainFactStatusClause(mode, "f"),
    // NOT redundant with the mode clause — see the module header. Without it
    // the agent is served retracted claims as current belief.
    "f.invalidated_at IS NULL",
  ];

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
  const sql = `SELECT ${FACT_COLUMNS},
         ${CORROBORATION_SELECT} AS corroboration_count,
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
 * narrowing — the ONE place in this module that trusts a column, justified by
 * `text NOT NULL` in migration 0180. Stated because the file is otherwise
 * uniformly `unknown`-in, and because `loadTensions` reads the same three
 * columns off the same table and narrows them: that asymmetry existed by
 * accident and is now deliberate on both sides, with the tension path narrowing
 * only because its rows arrive through a differently-shaped projection.
 */
interface FactRow {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly status: unknown;
  readonly predicate_cardinality: unknown;
  readonly visible_to: unknown;
  readonly provenance: unknown;
  readonly source_episode_id: string | null;
  readonly valid_from: unknown;
  readonly valid_to: unknown;
  readonly invalidated_at: unknown;
  readonly ingested_at: unknown;
  readonly corroboration_count: unknown;
  readonly snippet: unknown;
}

/**
 * `tier` and `trustTier` are written here, at the one seam every fact row
 * passes through. The type makes an unlabeled row unrepresentable; this makes
 * it unconstructible in practice too.
 */
function toFactResult(
  row: FactRow,
  workspaceId: string,
  tensions: readonly BrainSearchTensionView[],
): BrainFactResult {
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
    provenance: projectProvenance(row.provenance, row.source_episode_id),
    corroborationCount: count(row.corroboration_count, "corroboration_count", workspaceId),
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

interface TensionPair {
  readonly owner: string;
  readonly other: string;
  readonly direction: BrainFactTensionDirection;
}

/**
 * `in-tension-with` counterparts for the facts on this page — both directions,
 * never ranked.
 *
 * Two statements: the edges (ungated — `brain_edges` carries no grant of its
 * own), then the counterpart FACTS through a FRESH fact predicate, applied
 * independently. A counterpart the reader may not see is reported as
 * `visible: false` rather than dropped: "there is a rival you cannot see" is
 * precisely what should stop an agent asserting the claim as settled, and an
 * omitted row reads as "nothing contradicts this".
 *
 * `invalidated_at` is deliberately NOT filtered on the counterpart — a rival
 * that was retracted is still why this claim was contested — but it IS carried,
 * because retraction never writes `status` and an unlabeled withdrawn rival is
 * indistinguishable from a live one.
 */
async function loadTensions(
  db: BrainSearchReader,
  factIds: readonly string[],
  ctx: BrainPrincipalContext,
  requestId: string | undefined,
): Promise<{ views: Map<string, BrainSearchTensionView[]>; truncated: boolean }> {
  const views = new Map<string, BrainSearchTensionView[]>();
  if (factIds.length === 0) return { views, truncated: false };
  if (!ctx.workspaceId) {
    // Unreachable — a workspace-less context denies at the caller. Loud rather
    // than a bare return, because this guard's failure mode is a page that
    // silently reports no conflicts at all.
    log.warn(
      { requestId, origin: ctx.origin },
      "brain search: contradiction lookup reached with no workspace — reporting no conflicts, which is wrong; this is an Atlas bug",
    );
    return { views, truncated: false };
  }

  // `DISTINCT` because 0180 puts no unique index on the edge tuple —
  // `reconcile.ts` dedupes with `WHERE NOT EXISTS`, which two concurrent passes
  // can race, and a duplicate edge would surface as two identical conflicts.
  const edgeResult = await db.query(
    `SELECT DISTINCT from_fact_id::text AS from_id, to_fact_id::text AS to_id
       FROM brain_edges
      WHERE workspace_id = $1
        AND edge_type = 'in-tension-with'
        AND (from_fact_id = ANY($2::uuid[]) OR to_fact_id = ANY($2::uuid[]))
      ORDER BY from_id, to_id
      LIMIT $3`,
    [ctx.workspaceId, [...factIds], TENSION_FANOUT_CAP + 1],
  );
  const edges = edgeResult.rows as ReadonlyArray<{ from_id: string | null; to_id: string | null }>;
  if (edges.length === 0) return { views, truncated: false };

  const truncated = edges.length > TENSION_FANOUT_CAP;
  const usable = truncated ? edges.slice(0, TENSION_FANOUT_CAP) : edges;
  if (truncated) {
    log.warn(
      { workspaceId: ctx.workspaceId, requestId, cap: TENSION_FANOUT_CAP, facts: factIds.length },
      "brain search: in-tension-with fan-out exceeded the per-page cap — some contradiction hints are omitted from this result set",
    );
  }

  const onPage = new Set(factIds);
  const pairs: TensionPair[] = [];
  for (const edge of usable) {
    const from = edge.from_id;
    const to = edge.to_id;
    if (!from || !to) continue;
    // An edge with both ends on the page yields two entries — each fact names
    // the other. Symmetric on purpose: neither end is the authority.
    if (onPage.has(from)) pairs.push({ owner: from, other: to, direction: "to" });
    if (onPage.has(to)) pairs.push({ owner: to, other: from, direction: "from" });
  }
  if (pairs.length === 0) return { views, truncated };

  const counterpartIds = [...new Set(pairs.map((p) => p.other))];
  const acl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });
  if (acl.decision === "deny-all") {
    // Unreachable — the caller already threw on this decision, against the same
    // table with the same context. Throwing rather than skipping the query,
    // because skipping leaves every counterpart unresolved and therefore
    // rendered as "a conflicting claim you are not allowed to see" — fabricated
    // ACL withholding, which a caller cannot tell from the real thing.
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, SEARCH_SURFACE);
  }

  const params: unknown[] = [...acl.params, counterpartIds];
  const result = await db.query(
    `SELECT f.id::text AS id, f.subject, f.predicate, f.object, f.invalidated_at
       FROM brain_facts f
      WHERE ${acl.sql}
        AND f.id = ANY($${params.length}::uuid[])`,
    params,
  );
  const visible = new Map<string, Record<string, unknown>>();
  for (const raw of result.rows) {
    const r = raw as Record<string, unknown>;
    if (typeof r.id === "string") visible.set(r.id, r);
  }

  for (const pair of pairs) {
    const row = visible.get(pair.other);
    const view: BrainSearchTensionView = row
      ? {
          visible: true,
          factId: pair.other,
          edgeDirection: pair.direction,
          subject: typeof row.subject === "string" ? row.subject : "",
          predicate: typeof row.predicate === "string" ? row.predicate : "",
          object: typeof row.object === "string" ? row.object : "",
          invalidatedAt: iso(row.invalidated_at),
        }
      : { visible: false, factId: pair.other, edgeDirection: pair.direction };
    const list = views.get(pair.owner);
    if (list) list.push(view);
    else views.set(pair.owner, [view]);
  }

  // Deterministic, and deliberately NOT by time, status, or corroboration —
  // any of those would be a ranking, and refusing to arbitrate is the point.
  for (const list of views.values()) list.sort((a, b) => a.factId.localeCompare(b.factId));

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
  // reach `loadTensions`' `$2::uuid[]` and fail the whole read with the generic
  // message, and would collapse every malformed row onto one `fact:undefined`
  // fusion key.
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
    return toFactResult(row, ctx.workspaceId, tensions.views.get(row.id) ?? []);
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
  };
}
