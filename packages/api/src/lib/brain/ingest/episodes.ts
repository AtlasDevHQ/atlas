/**
 * The brain ingest core (#4770, ADR-0036 §Ingestion & connectors) — the one
 * INGEST write path onto `brain_episodes`.
 *
 * ("Ingest" is load-bearing: `api/routes/admin-migrate.ts` also inserts, when a
 * region-migration bundle is imported, and deliberately preserves the
 * `extracted_at` and `locator` this module never sets. That is the import path,
 * not an ingest path, and it must stay exactly as permissive as the CHECKs —
 * see `acl.ts`'s header on why an importer stricter than the schema makes a
 * workspace unmigratable.)
 *
 * This is the forked half of ADR-0030. Everything the connector engine does
 * around it (scheduling, high-water marks, cadence, 429 backoff, caps) is
 * reused verbatim; the write itself is not, because episodes are immutable
 * append-only evidence and knowledge documents are mutable path-identified
 * content. Concretely, this module has:
 *
 *   - **no upsert.** `ON CONFLICT (workspace_id, source, source_id) DO NOTHING`
 *     — re-ingest is a NO-OP, not an update. A chat message edited upstream is
 *     a NEW episode (a new `source_id` is the source's business); mutating the
 *     old row would rewrite evidence after the fact, which is the one thing
 *     migration 0180's "there is deliberately NO `updated_at` column" is
 *     stating. The UNIQUE index is what makes that the only AVAILABLE
 *     behaviour rather than a call-site convention.
 *   - **no archive.** Nothing here (or anywhere under `lib/brain/ingest/`)
 *     imports `ingestDocuments`, so the engine's subtractive-archive path is
 *     unreachable from the episode path — an absent record is simply absent,
 *     never a deletion. `episode-sync-archive.test.ts` pins that structurally.
 *   - **no `extracted_at` write.** It stays NULL so the episode lands on
 *     #4771's extraction queue (`idx_brain_episodes_extraction_queue`). NULL
 *     forever is a VISIBLE BACKLOG; a stamped-at-ingest value would be a
 *     silent drop.
 *   - **no `status` column to write.** `brain_episodes` is deliberately NOT
 *     content-mode registered (#4769): episodes are evidence and are not
 *     review-gated — only the claims drawn from them are.
 *
 * ## Refusals happen HERE, before the batch, not at the CHECK
 *
 * A statement-fatal rejection anywhere in the batch aborts the whole INSERT and
 * loses a cycle's worth of good evidence. So each record is screened first and
 * the bad ones are dropped with a counted, logged reason — per-record
 * isolation, the same posture the ingest seam takes toward per-file rejections.
 *
 * FOUR screens run, and only two of them mirror one of `brain_episodes`'s two
 * CHECKs:
 *
 *   - blank `body` → mirrors `chk_brain_episodes_body_xor_locator`, which
 *     refuses `''` outright (evidence that is empty backs a provenance claim
 *     with nothing);
 *   - unusable grant → DELIBERATELY STRICTER than
 *     `chk_brain_episodes_grant_nonempty`, which catches the empty and
 *     all-NULL/`''` cases but admits `['everyone']`. `grant.ts`'s header
 *     explains why being stricter is legitimate on the write side and
 *     forbidden at rest or at import;
 *   - blank `source_id` → no CHECK covers it, but a blank dedupe key collapses
 *     every record from that source into one row;
 *   - invalid `occurred_at` → no CHECK can cover it, because
 *     `new Date(NaN).toISOString()` throws in JS BEFORE any SQL is sent. That
 *     one is the reason this list is a screen and not a `try` around the
 *     INSERT: a thrown record would take the batch with it, and the engine
 *     leaves the mark unmoved on an error, so the same poison record would be
 *     re-fetched and re-thrown every cycle forever.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { isUsableGrant } from "./grant";
import type { BrainEpisodeRecord } from "./types";
import type { EpisodeSource } from "@atlas/api/lib/brain/sources";

const log = createLogger("brain.ingest.episodes");

/** Bound the refused-id list in the log line — a whole bad batch must not flood it. */
const REFUSED_ID_LOG_CAP = 20;

/**
 * The append-only episode insert. Exported so the real-Postgres test executes
 * this exact string against the live schema rather than asserting a paraphrase.
 *
 * Records travel as ONE jsonb array rather than parallel `unnest` arrays
 * because `visible_to` is itself an array — parallel arrays would need
 * `text[][]`, which Postgres requires to be rectangular, so a batch mixing a
 * 1-principal and a 2-principal grant could not be bound at all.
 *
 * `->>` yields SQL NULL for a JSON `null`, so `source_actor` and `occurred_at`
 * need no coalescing; `locator` is a literal NULL because a connector record
 * is always by-value (see `BrainEpisodeRecord`), and `extracted_at` is absent
 * so the column's NULL default puts the row on the extraction queue.
 *
 * `RETURNING source_id` returns ONLY genuinely inserted rows — `DO NOTHING`
 * suppresses the conflicting ones — which is what makes the dedupe count
 * observed rather than inferred.
 */
export const INSERT_EPISODES_SQL = `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, locator, occurred_at, visible_to)
       SELECT $1,
              $2,
              rec->>'sourceId',
              rec->>'sourceActor',
              rec->>'body',
              NULL,
              (rec->>'occurredAt')::timestamptz,
              ARRAY(SELECT jsonb_array_elements_text(rec->'visibleTo'))
         FROM jsonb_array_elements($3::jsonb) AS rec
       ON CONFLICT (workspace_id, source, source_id) DO NOTHING
       RETURNING source_id`;

/** Why a record never reached the INSERT. Counted, logged, never silent. */
export type EpisodeRefusalReason =
  | "blank_source_id"
  | "blank_body"
  | "unusable_grant"
  | "invalid_occurred_at";

export interface EpisodeIngestReport {
  /** Rows the INSERT actually created. */
  readonly inserted: number;
  /**
   * Records the source produced that were ALREADY stored — the dedupe hit
   * count. This is the number an acceptance test reads to prove a re-poll of
   * the same window writes zero new rows.
   */
  readonly duplicate: number;
  /** Records dropped before the INSERT, by reason. */
  readonly refused: Readonly<Record<EpisodeRefusalReason, number>>;
  /**
   * Records the source emitted twice in ONE batch. Collapsed before the
   * INSERT: `ON CONFLICT DO NOTHING` tolerates a self-conflict, but it would
   * report the second copy as a `duplicate` against storage, which is a
   * different fact about the world (the SOURCE repeated itself) and points at
   * a different bug.
   */
  readonly batchDuplicate: number;
}

const NO_REFUSALS: Readonly<Record<EpisodeRefusalReason, number>> = Object.freeze({
  blank_source_id: 0,
  blank_body: 0,
  unusable_grant: 0,
  invalid_occurred_at: 0,
});

export interface IngestEpisodesParams {
  readonly workspaceId: string;
  /**
   * The source kind stamped into `brain_episodes.source`.
   *
   * Typed to the closed vocabulary (`lib/brain/sources.ts`) because THIS is the
   * write path: `registerBrainSourceConnector`'s check runs once at wiring
   * time, so a caller reaching `ingestEpisodes` directly — a backfill script, a
   * future producer — would otherwise bypass it entirely and land a value that
   * `isWarehouseDerived` silently declines to recognise.
   */
  readonly source: EpisodeSource;
  readonly episodes: readonly BrainEpisodeRecord[];
}

/**
 * Append a batch of episodes. Idempotent by `(workspace_id, source,
 * source_id)`: re-ingesting the same window inserts nothing and reports every
 * record as a duplicate.
 *
 * Throws on a database failure — the caller (`episode-sync.ts`) turns that
 * into the source's error outcome, which leaves the high-water mark unmoved so
 * the next cycle re-fetches exactly what this one failed to store. Swallowing
 * it here would advance the mark past evidence that never landed.
 */
export async function ingestEpisodes(
  params: IngestEpisodesParams,
): Promise<EpisodeIngestReport> {
  const { workspaceId, source, episodes } = params;
  if (episodes.length === 0) {
    return { inserted: 0, duplicate: 0, refused: NO_REFUSALS, batchDuplicate: 0 };
  }

  const refused: Record<EpisodeRefusalReason, number> = { ...NO_REFUSALS };
  const refusedIds: string[] = [];
  const seen = new Set<string>();
  let batchDuplicate = 0;
  const payload: {
    sourceId: string;
    sourceActor: string | null;
    body: string;
    occurredAt: string | null;
    visibleTo: readonly string[];
  }[] = [];

  for (const record of episodes) {
    const sourceId = record.sourceId.trim();
    if (sourceId === "") {
      refused.blank_source_id++;
      refusedIds.push("<blank>");
      continue;
    }
    // Screened on the TRIMMED value but STORED verbatim: the CHECK only
    // refuses `''`, and silently trimming evidence would edit it.
    if (record.body.trim() === "") {
      refused.blank_body++;
      refusedIds.push(sourceId);
      continue;
    }
    if (!isUsableGrant(record.visibleTo)) {
      refused.unusable_grant++;
      refusedIds.push(sourceId);
      continue;
    }
    // `Date | null` admits an INVALID Date, and `new Date(NaN).toISOString()`
    // throws `RangeError` — synchronously, before any SQL runs. One such record
    // would therefore abort the whole batch and, because the engine leaves the
    // mark unmoved on an error, the same poison record would be re-fetched and
    // re-thrown every cycle forever. Screened here with the others so
    // per-record isolation actually covers every field.
    if (record.occurredAt !== null && Number.isNaN(record.occurredAt.getTime())) {
      refused.invalid_occurred_at++;
      refusedIds.push(sourceId);
      continue;
    }
    if (seen.has(sourceId)) {
      batchDuplicate++;
      continue;
    }
    seen.add(sourceId);
    payload.push({
      sourceId,
      sourceActor: record.sourceActor,
      body: record.body,
      // Explicit rather than leaning on `JSON.stringify`'s Date handling: that
      // turns an Invalid Date into `null`, which would silently lose the event
      // time instead of refusing the record. The screen above guarantees this
      // call cannot throw.
      occurredAt: record.occurredAt === null ? null : record.occurredAt.toISOString(),
      visibleTo: [...record.visibleTo],
    });
  }

  // Summed over the record rather than hand-listed: a fifth reason that only
  // ever fired alone would otherwise leave `totalRefused` at 0, so the
  // operator-facing warn (with the refused ids) would never emit — making a
  // refused record both unrecoverable AND invisible, which is exactly the state
  // this module's header says must not exist.
  const totalRefused = Object.values(refused).reduce((sum, n) => sum + n, 0);
  if (totalRefused > 0) {
    log.warn(
      {
        workspaceId,
        source,
        ...refused,
        candidates: episodes.length,
        // A refused record is unrecoverable — the mark advances past it — so
        // "3 records refused" with no identity gives an operator nothing to
        // act on. Ids only; the bodies are the sensitive half.
        refusedSourceIds: refusedIds.slice(0, REFUSED_ID_LOG_CAP),
      },
      "brain ingest: dropped source records that could not be stored as episodes",
    );
  }

  if (payload.length === 0) {
    return { inserted: 0, duplicate: 0, refused, batchDuplicate };
  }

  const rows = await internalQuery<{ source_id: string }>(INSERT_EPISODES_SQL, [
    workspaceId,
    source,
    JSON.stringify(payload),
  ]);
  const inserted = rows.length;
  return {
    inserted,
    duplicate: payload.length - inserted,
    refused,
    batchDuplicate,
  };
}
