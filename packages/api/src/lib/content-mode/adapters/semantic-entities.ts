/**
 * Exotic adapter for the `semantic_entities` table (#1515 phase 2d).
 *
 * Composes the two existing publish helpers from
 * `lib/semantic/entities.ts`:
 * - `applyTombstones` — delete published rows targeted by
 *   `status = 'draft_delete'` rows, then remove the tombstones.
 * - `promoteDraftEntities` — delete published rows superseded by a
 *   same-key draft, then flip `status = 'draft' → 'published'`.
 *
 * Order matters: tombstones first, promote second. Matches the
 * existing `admin-publish.ts` ordering so the refactor preserves
 * behavior when a caller migrates to `registry.runPublishPhases`.
 *
 * Runs under the caller's `PoolClient` — never opens its own
 * transaction. The helpers are pure async functions; this module
 * wraps them in Effect + `PublishPhaseError` so the registry's
 * error channel stays uniform across simple and exotic entries.
 */

import { Effect } from "effect";
import type { PoolClient } from "pg";
import {
  applyTombstones,
  promoteDraftEntities,
  type TransactionalClient,
} from "@atlas/api/lib/semantic/entities";
import {
  PublishPhaseError,
  type PromotionReport,
} from "@atlas/api/lib/content-mode/port";

/**
 * Promote drafts for `semantic_entities` and apply tombstones in the
 * caller's transaction. Surfaces `PublishPhaseError` with the offending
 * phase (`"tombstone"` or `"promote"`) so the admin-publish handler can
 * attribute partial failures.
 */
export function promoteSemanticEntities(
  tx: PoolClient,
  orgId: string,
): Effect.Effect<PromotionReport, PublishPhaseError, never> {
  // `PoolClient.query` is compatible with the `TransactionalClient`
  // shape the helpers consume (both expose `query(sql, params) => Promise<{ rows }>`).
  const client = tx as unknown as TransactionalClient;

  return Effect.gen(function* () {
    const tombstonesApplied = yield* Effect.tryPromise({
      try: () => applyTombstones(client, orgId),
      catch: (cause) =>
        new PublishPhaseError({
          table: "semantic_entities",
          phase: "tombstone",
          cause,
        }),
    });

    const promoted = yield* Effect.tryPromise({
      try: () => promoteDraftEntities(client, orgId),
      catch: (cause) =>
        new PublishPhaseError({
          table: "semantic_entities",
          phase: "promote",
          cause,
        }),
    });

    return {
      table: "semantic_entities",
      promoted,
      tombstonesApplied,
    } satisfies PromotionReport;
  });
}
