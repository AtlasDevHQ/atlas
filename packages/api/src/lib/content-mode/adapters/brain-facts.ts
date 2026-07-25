/**
 * Exotic adapter for the `brain_facts` table — the fact class's review gate
 * (#4769, ADR-0036 §Temporal, conflict & provenance).
 *
 * ## Why exotic, when the READ semantics are the plain ones
 *
 * `brain_facts` reads exactly like a simple entry (`status = 'published'`, or
 * `IN ('published','draft')` in developer mode), and `readFilter` below says
 * so. It is exotic entirely because of the WRITE: a `SimpleModeTable` promotes
 * with one blanket `UPDATE … WHERE status='draft'`, which has no per-row
 * opinion and therefore cannot refuse a fact or say which one it refused.
 * ADR-0036 states no-provenance-no-promotion and no-grant-no-promotion as
 * absolutes, and "refuse with an actionable error" is per-row by definition —
 * so the promote path has to be able to name a row. See `lib/brain/promotion.ts`
 * for WHICH of those rules is live and which is defense in depth.
 *
 * The alternative considered and rejected was widening `SimpleModeTable` with a
 * `refuse` SQL fragment. That restates the grant grammar in SQL — a second
 * source of truth for the thing `acl.ts` exists to be the only source of truth
 * for — and it would put table-specific machinery in the shape four other
 * tables share. Exotic keeps the cost local.
 *
 * ## Refuse the row, never the workspace
 *
 * A refused fact is left `draft` and the transaction commits. Failing the
 * shared publish transaction was considered and rejected: facts arrive
 * continuously from #4771's extraction fiber, so a single deriver bug would
 * wedge a tenant's ENTIRE publish — every prompt, entity, and connection — until
 * somebody hand-edited the database. Quarantining the row keeps the blast
 * radius at one claim, and the row stays counted in `draftCounts`, listed in
 * the publish preview, and re-offered next publish, so the refusal is a visible
 * backlog rather than a silent drop.
 */

import { Effect } from "effect";
import type { AtlasMode } from "@useatlas/types/auth";
import { createLogger } from "@atlas/api/lib/logger";
import { logGrantAnomalies } from "@atlas/api/lib/brain/acl";
import { classifyFactForPromotion, type DraftFactRow } from "@atlas/api/lib/brain/promotion";
import {
  PublishPhaseError,
  type ModeTxClient,
  type PromotionRefusal,
  type PromotionReport,
} from "@atlas/api/lib/content-mode/port";

const log = createLogger("brain-facts-publish");

/**
 * The physical table — the report's `table` and the lookup key non-registry
 * callers (e.g. `admin-publish.ts`) use to find this adapter's report.
 *
 * `tables.ts` deliberately spells the same string as a LITERAL rather than
 * importing this. `port.ts → tables.ts → adapters/* → port.ts` is a live ESM
 * cycle, and whether this module has finished initializing when the tuple is
 * constructed DEPENDS ON WHICH MODULE THE GRAPH IS ENTERED THROUGH: enter via
 * `port.ts` and the adapter body has already run, so a `const` resolves fine;
 * enter via this adapter (as `adapters/__tests__/brain-facts.test.ts` does) and
 * the tuple is built while this module is mid-initialization, putting a `const`
 * in its temporal dead zone. That entry order is not something a caller
 * controls, so the tuple may reference only hoisted function DECLARATIONS from
 * here. Do not "verify" this by importing `port.ts` first and concluding the
 * comment is wrong — that is the order that happens to work.
 *
 * (`semantic-entities.ts` also spells its key literally, but that is not
 * evidence either way: it exports no key const to import in the first place.)
 *
 * `adapters/__tests__/brain-facts.test.ts` asserts the two spellings agree,
 * which is what makes the duplication safe — a test is the only pin available
 * once the import is off the table.
 */
export const BRAIN_FACTS_TABLE = "brain_facts" as const;

/**
 * The read gate, stated once. `readFilter` below is built from it, and
 * non-Effect callers can use it directly — `resolveStatusClause` refuses exotic
 * entries by design (an exotic table's read semantics are usually an overlay
 * CTE it can't guess), so this is the fact class's equivalent seam.
 *
 * `alias` is interpolated, so callers must pass a plain identifier they control
 * — same contract as `resolveStatusClause` and `aclVisibilityClause`.
 *
 * ## It gates REVIEW STATUS ONLY — retraction is a separate axis
 *
 * This clause deliberately does NOT filter `invalidated_at`, unlike the four
 * promotion-side paths (`DRAFT_FACTS_SQL`, `PROMOTE_FACTS_SQL`,
 * `brainFactsCountSql`, and the publish preview), which all exclude retracted
 * rows. The asymmetry is intentional and load-bearing in both directions:
 * ADR-0036 keeps a retracted fact READABLE so "what we believed on Monday"
 * still answers correctly, and supersession is explicitly not deletion — so a
 * content-mode filter that also swallowed tombstones would break as-of reads.
 * Promotion is the opposite case: stamping "reviewed and trusted" on a claim
 * already withdrawn is never right.
 *
 * THE CONSEQUENCE FOR CALLERS, stated because composing the two advertised
 * seams is the obvious thing to do and is not sufficient: a CURRENT-BELIEF read
 * (#4773's `searchBrain`) must AND `invalidated_at IS NULL` itself, on top of
 * this clause and `aclVisibilityClause`. `idx_brain_facts_subject` is partial on
 * exactly that predicate, so the index is built for it. Omit it and the agent is
 * served retracted claims.
 */
export function brainFactStatusClause(mode: AtlasMode | undefined, alias: string): string {
  return mode === "developer"
    ? `${alias}.status IN ('published', 'draft')`
    : `${alias}.status = 'published'`;
}

/**
 * Draft facts awaiting review, with exactly the columns the refusal rules read.
 *
 * `FOR UPDATE` because this adapter is read-then-write, which the simple
 * entries are not: it serializes two concurrent publishes on the same
 * workspace, so the second one classifies the state the first COMMITTED rather
 * than a snapshot taken mid-flight. The lock is workspace-scoped and held only
 * for the rest of the caller's transaction.
 *
 * Be precise about what it buys, because the obvious claim is wrong and was
 * written here first: it is NOT the only thing standing between two publishers
 * and a double-promote. The promote UPDATE's own `status = 'draft'` predicate
 * is re-evaluated against the committed row version after it unblocks, so it
 * independently matches zero rows the second time. The two are REDUNDANT — a
 * live-PG race (`promotion-pg.test.ts`) confirms that removing either one alone
 * still promotes each draft exactly once, and only removing BOTH double-counts.
 * Both are kept: the guard makes the UPDATE correct standalone, and the lock
 * makes the read-then-write actually serial rather than correct-by-coincidence
 * of the guard — which also stops both publishers logging grant anomalies for
 * the same rows.
 *
 * Unbounded by design: the row set is exactly what `draftCounts.brainFacts`
 * already reports and what the publish preview already lists in full, so a
 * LIMIT here would silently promote a prefix — the one outcome a review gate
 * must never produce.
 */
export const DRAFT_FACTS_SQL = `
  SELECT id::text AS id,
         subject,
         predicate,
         object,
         source_episode_id::text AS source_episode_id,
         provenance,
         visible_to
    FROM brain_facts
   WHERE workspace_id = $1
     AND status = 'draft'
     AND invalidated_at IS NULL
   ORDER BY ingested_at
     FOR UPDATE
`;

/**
 * Promote the classified-promotable subset, by explicit id.
 *
 * The `status = 'draft'` predicate is kept alongside the id list even though
 * `FOR UPDATE` already pins the rows: it makes the statement correct on its own
 * terms, so a future refactor that drops the lock cannot turn this into a
 * republish of archived facts.
 */
export const PROMOTE_FACTS_SQL = `
  UPDATE brain_facts
     SET status = 'published', updated_at = now()
   WHERE workspace_id = $1
     AND status = 'draft'
     AND invalidated_at IS NULL
     AND id = ANY($2::uuid[])
`;

/** Draft count for the `brainFacts` segment of `/api/v1/mode` `draftCounts`. */
export function brainFactsCountSql(orgParam: string): string {
  return `SELECT 'brainFacts' AS key, COUNT(*)::int AS n FROM brain_facts WHERE workspace_id = ${orgParam} AND status = 'draft' AND invalidated_at IS NULL`;
}

/**
 * Narrow one `pg` row to the classifier's input.
 *
 * Returns `null` when the row has no usable `id`, which would make a refusal
 * unattributable and an UPDATE target unnameable. That is query drift, not
 * data: `id` is the PK and cast to text in the SELECT above. It fails the whole
 * phase rather than skipping the row, because skipping would leave a draft
 * silently unpromoted with no refusal recorded — indistinguishable from success.
 */
function toDraftFactRow(row: unknown): DraftFactRow | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") return null;
  // SPO columns are `text NOT NULL`, so the fallback is unreachable from the
  // database — it exists so a shape change degrades the refusal MESSAGE rather
  // than throwing from inside a publish transaction.
  const text = (value: unknown): string => (typeof value === "string" ? value : "?");
  return {
    id: r.id,
    subject: text(r.subject),
    predicate: text(r.predicate),
    object: text(r.object),
    source_episode_id: typeof r.source_episode_id === "string" ? r.source_episode_id : null,
    provenance: r.provenance,
    visible_to: r.visible_to,
  };
}

/**
 * Promote reviewed facts inside the caller's transaction, refusing any draft
 * that breaks a structural rule.
 *
 * The returned `PromotionReport` carries `refused` so `admin-publish.ts` can
 * surface the refusals to the admin instead of reporting an unqualified
 * success — a refused fact that only appeared in the server log would be a
 * silent partial publish from the admin's side.
 */
export function promoteBrainFacts(
  tx: ModeTxClient,
  orgId: string,
): Effect.Effect<PromotionReport, PublishPhaseError, never> {
  return Effect.gen(function* () {
    const drafts = yield* Effect.tryPromise({
      try: () => tx.query(DRAFT_FACTS_SQL, [orgId]),
      catch: (cause) =>
        new PublishPhaseError({ table: BRAIN_FACTS_TABLE, phase: "promote", cause }),
    });

    const promotableIds: string[] = [];
    const refused: PromotionRefusal[] = [];
    for (const raw of drafts.rows) {
      const row = toDraftFactRow(raw);
      if (!row) {
        return yield* Effect.fail(
          new PublishPhaseError({
            table: BRAIN_FACTS_TABLE,
            phase: "promote",
            cause: new Error(
              "promoteBrainFacts: draft row has no usable `id` — the draft-facts query shape changed",
            ),
          }),
        );
      }
      const refusal = classifyFactForPromotion(row);
      if (refusal) {
        refused.push(refusal);
        continue;
      }
      // Promotable, but its grant may still carry junk alongside a valid token
      // (`['user:u1', 'everyone']`): enforceable, so NOT a refusal — the valid
      // token does real work — yet the author plainly believed the second token
      // did something. `acl.ts` calls this the read-time seam it cannot reach
      // from a push-down predicate; promotion is the one place holding every
      // draft's grant, so it is where the observable half of that gap narrows.
      // NOT closed: #4797 stays open for `brain_episodes` (gated by the same
      // predicate, but never promoted, so it has no equivalent seam) and for
      // facts that arrive already `published` through the region import.
      if (Array.isArray(row.visible_to)) {
        logGrantAnomalies(row.visible_to as readonly unknown[], {
          table: BRAIN_FACTS_TABLE,
          rowId: row.id,
          workspaceId: orgId,
        });
      }
      promotableIds.push(row.id);
    }

    // Skip the round trip when there is nothing to promote — a workspace with
    // no brain drafts is the overwhelmingly common case and publish runs this
    // adapter on every call.
    let promoted = 0;
    if (promotableIds.length > 0) {
      const result = yield* Effect.tryPromise({
        try: () => tx.query(PROMOTE_FACTS_SQL, [orgId, promotableIds]),
        catch: (cause) =>
          new PublishPhaseError({ table: BRAIN_FACTS_TABLE, phase: "promote", cause }),
      });
      // `rowCount` is authoritative for a non-RETURNING UPDATE (`rows` is
      // empty); the `rows.length` fallback keeps test doubles that populate
      // only one of the two from reporting a false zero. Mirrors
      // `promoteSimpleTable` in the registry.
      promoted = result.rowCount ?? result.rows?.length ?? 0;
      if (promoted !== promotableIds.length) {
        // `FOR UPDATE` pins every classified row for the rest of this
        // transaction, so the UPDATE must touch exactly the ids we passed.
        // A divergence means the lock did not hold, a row changed status
        // underneath us, or the driver under-reported `rowCount` — and the
        // consequence is rows that are neither promoted-and-counted nor
        // refused-and-reported, i.e. the silent under-report this whole
        // adapter exists to prevent. Never silent.
        log.warn(
          {
            workspaceId: orgId,
            expected: promotableIds.length,
            actual: promoted,
            rowCount: result.rowCount,
          },
          "brain publish: promoted count does not match the classified-promotable set — some drafts may be unaccounted for",
        );
      }
    }

    if (refused.length > 0) {
      log.warn(
        {
          workspaceId: orgId,
          refusedCount: refused.length,
          promotedCount: promoted,
          refused: refused.map((r) => ({ rowId: r.rowId, reasons: r.reasons })),
        },
        "brain publish: refused to promote facts that break a structural rule — they remain drafts",
      );
    }

    return {
      table: BRAIN_FACTS_TABLE,
      promoted,
      // Always present (possibly empty) for this adapter: the fact class HAS a
      // refusal concept, and `[]` is the meaningful "nothing was refused this
      // run" answer, distinct from a table that cannot refuse at all.
      refused,
    } satisfies PromotionReport;
  });
}
