/**
 * The brain ingest seam (#4770, ADR-0036 §Ingestion & connectors) — the
 * FORKED half of the ADR-0030 connector architecture.
 *
 * ## What is reused and what is forked
 *
 * ADR-0036 §T6 is explicit: **reuse the ADR-0030 connector engine verbatim**
 * (scheduling / high-water marks / incremental-vs-reconcile cadence / 429
 * backoff / caps) and **fork the ingest core**. This module is the fork's
 * vocabulary; `episode-sync.ts` is the fork's engine, and it imports the
 * reused halves (`withRateLimitBackoff`, `SYNC_OVERLAP_WINDOW_MS`,
 * `getKnowledgeSyncReconcileIntervalMs`, the `knowledge_sync_state`
 * bookkeeping) from `lib/knowledge/connector-sync.ts` rather than
 * reimplementing them. Dispatch onto one engine or the other happens in
 * `lib/knowledge/sync.ts`'s cycle walk, keyed on which registry a catalog id
 * belongs to — that is the "engine dispatch on ingest-target" fork point.
 *
 * The ingest core is forked because the two targets are structurally
 * different, not merely differently-shaped:
 *
 *   - a knowledge document is IDENTIFIED BY PATH and is MUTABLE — the engine's
 *     `ingestDocuments` upserts by path and, on a coverage-complete
 *     reconciliation crawl, ARCHIVES paths absent from the vendor's full set;
 *   - an episode is IDENTIFIED BY SOURCE-ID and is IMMUTABLE — a Slack message
 *     edited upstream is a NEW episode, not a mutation of the old one, because
 *     an episode is EVIDENCE and evidence that can be edited after the fact
 *     cannot back a provenance claim (migration 0180's header).
 *
 * So the episode path deliberately has **no upsert and no archive**. The only
 * write is `INSERT … ON CONFLICT (workspace_id, source, source_id) DO NOTHING`
 * (`episodes.ts`), and nothing in `lib/brain/ingest/` imports
 * `ingestDocuments` — `episode-sync-archive.test.ts` pins both.
 *
 * ## Why there is no `fetchChanges` / `fetchAll` pair
 *
 * ADR-0030's client interface splits enumeration in two because the
 * reconciliation crawl is the CORRECTNESS ANCHOR for subtractive archiving:
 * `fetchAll` promises a full set, and paths missing from it get archived. An
 * episode source archives nothing, so a "full set" contract would promise
 * something no caller consumes — and a contract nobody enforces is a contract
 * that quietly rots. One method takes the mode instead. What `reconciliation`
 * then means is the source's business: ADR-0036 §Ingestion repurposes the
 * cadence to **re-run extraction** (#4771), and a source may additionally widen
 * its own fetch window — but it never means "enumerate everything so absences
 * can be deleted".
 */

import {
  claimCatalogIngestTarget,
  _resetCatalogIngestClaims,
} from "@atlas/api/lib/knowledge/catalog-claims";
import type { BrainGrant } from "@atlas/api/lib/brain/types";
import { EPISODE_SOURCES, isEpisodeSource, type EpisodeSource } from "@atlas/api/lib/brain/sources";

/**
 * One record a source produced, ready to become a tier-3 episode row.
 *
 * Deliberately NOT `BrainEpisode` from `lib/brain/types.ts`: that type is the
 * stored row (it carries `id`, `ingestedAt`, `createdAt`, `extractedAt`), and
 * a connector must not be able to name any of them. `extractedAt` in
 * particular is #4771's work-queue marker and MUST stay NULL at ingest — a
 * connector that could set it would take episodes off the extraction queue
 * before anything extracted them, and the design's "NULL forever is a visible
 * backlog, not a silent drop" would become a silent drop.
 */
export interface BrainEpisodeRecord {
  /**
   * The source's own stable identifier. THE dedupe key, and a per-connector
   * CONTRACT: it must be byte-identical from the polling path and from the
   * webhook fast-path (M3), or the two writers duplicate every record they
   * race on. Each connector documents its construction next to its client —
   * see `slack/config.ts` for the Slack chat contract.
   */
  readonly sourceId: string;
  /** Source-side author principal (e.g. a Slack user id); null when none. */
  readonly sourceActor: string | null;
  /**
   * The record's content, stored BY VALUE. Chat is by-value on purpose: Slack
   * may delete the message out from under us and the evidence must survive
   * (migration 0180). Never `''` — `chk_brain_episodes_body_xor_locator`
   * refuses an empty string outright rather than treating it as absent, so
   * the ingest core drops blank records rather than letting the CHECK reject
   * a whole batch.
   *
   * There is no `locator` field here. Episodes stored BY REFERENCE
   * (warehouse-derived, KB-derived) come from entry points that are not
   * connectors, and admitting both halves of the XOR into a chat connector's
   * record type would make "which one backs the provenance claim" a per-call
   * question instead of a per-source one.
   */
  readonly body: string;
  /** Event time at the source. Null when the source exposes none. */
  readonly occurredAt: Date | null;
  /**
   * The derived ACL grant (ADR-0036 §T5). Must contain at least one principal
   * that `parseGrant` finds USABLE — see `grant.ts` for why a grant the 0180
   * CHECK admits can still be a permanent trap.
   */
  readonly visibleTo: BrainGrant;
}

/** The two cadences, carried through to the client. */
export type BrainSourceFetchMode = "incremental" | "reconciliation";

/** What the engine hands a client for one fetch. */
export interface BrainSourceFetchParams {
  /**
   * `incremental` — fetch what changed since `since`.
   * `reconciliation` — the wider-window cadence. It is NOT a full enumeration
   * and NOTHING is archived from its absences; a source that has nothing wider
   * to fetch may treat it identically to `incremental` (the Slack source
   * does — see its client's header for why).
   */
  readonly mode: BrainSourceFetchMode;
  /**
   * The persisted high-water mark minus the engine's overlap window, or null
   * when the source has never synced successfully. Re-fetched records no-op in
   * the source-id dedupe, so the overlap costs bandwidth and never correctness
   * — the same property that lets ADR-0030 rewind its incremental window.
   */
  readonly since: string | null;
  /** The opaque per-source cursor from the last successful sync, or null. */
  readonly cursor: string | null;
  /**
   * The maximum number of episodes this fetch may return — the engine's
   * EFFECTIVE per-sync cap (`min(platform ceiling, plan tier)`), resolved once
   * per cycle and shared with the ingest stage. Required, not optional, for
   * the same reason ADR-0030 made it required: a client that silently fell
   * back to the raw platform ceiling would burn a Starter workspace's vendor
   * rate limit pulling 20× what it can ever ingest.
   */
  readonly maxEpisodes: number;
}

/** One fetch's result — records plus the bookkeeping to persist on success. */
export interface BrainSourceChanges {
  readonly episodes: readonly BrainEpisodeRecord[];
  /**
   * The newest source-side event time this fetch covered (ISO-8601), or null
   * when the fetch covered nothing new. Persisted on success as the source's
   * high-water mark. Return the SOURCE's clock, never the local one.
   */
  readonly highWaterMark: string | null;
  /** Opaque per-source continuation, persisted verbatim and echoed back. */
  readonly cursor?: string | null;
  /**
   * True when the client KNOWS this pass left part of its window uncovered
   * (a per-cycle budget ran out, a sub-source errored) while the records it
   * DID return are sound. The engine still ingests them and still advances the
   * high-water mark the client returned — but it does NOT advance the
   * reconcile clock, so the wider re-crawl stays due. Omit / false on a
   * complete pass.
   *
   * Correctness rests on the CLIENT, not the engine: a client that reports
   * incomplete coverage must return a high-water mark (and cursor) that covers
   * only the CONTIGUOUS part of the window it actually enumerated, or it will
   * skip the gap forever. `slack/client.ts` does that per channel.
   */
  readonly coverageIncomplete?: boolean;
  /**
   * Human-readable, non-fatal notes from the pass (a channel that exceeded the
   * budget, a sub-source the source refused). Surfaced in the sync state
   * report so a partially-covered "success" is never silently green.
   */
  readonly warnings?: readonly string[];
}

/**
 * The per-source client the engine drives. May throw — a
 * `ConnectorRateLimitError` (imported from the ADR-0030 seam
 * `lib/knowledge/connectors.ts`, so both halves speak ONE throttle vocabulary
 * and the shared backoff applies unchanged) gets the engine's bounded backoff;
 * anything else becomes that source's error outcome, isolated and never
 * cycle-fatal.
 */
export interface BrainSourceVendorClient {
  fetchEpisodes(params: BrainSourceFetchParams): Promise<BrainSourceChanges>;
}

/** What a connector gets to build a client from — the install row, no more. */
export interface BrainSourceInstallContext {
  readonly workspaceId: string;
  /** The install's `workspace_plugins.install_id`. */
  readonly installId: string;
  /** The install row's config (scope fields; never secrets). */
  readonly config: Record<string, unknown> | null;
}

/**
 * A registered brain ingest source: one catalog row → one client factory.
 *
 * `createClient` may throw (bad config, a disconnected upstream OAuth install)
 * — the engine turns that into the source's error outcome with the message
 * surfaced to the admin, so make it actionable.
 */
export interface BrainSourceConnector {
  /** The catalog row this connector serves — the cycle-walk dispatch key. */
  readonly catalogId: string;
  /**
   * The connector class stamped into `brain_episodes.source` — ADR-0036 is
   * class-major, vendor-minor, and the closed vocabulary lives in
   * `lib/brain/sources.ts`.
   *
   * A CLOSED type rather than a slug pattern, because downstream predicates
   * read this value as a discriminator: `isWarehouseDerived` refuses tier-1
   * correction on `WAREHOUSE_SOURCE` alone, so a warehouse connector that
   * named its class `"snowflake"` would fail that ADR-level invariant OPEN and
   * nothing would go red. `sources.ts`'s header carries the full argument.
   */
  readonly source: EpisodeSource;
  createClient(
    ctx: BrainSourceInstallContext,
  ): Promise<BrainSourceVendorClient> | BrainSourceVendorClient;
}

// ---------------------------------------------------------------------------
// Registry — catalog id → connector, read by the shared sync cycle walk
// ---------------------------------------------------------------------------

const SOURCE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

const registry = new Map<string, BrainSourceConnector>();

/**
 * Register a brain source for its catalog row. Called once per source at
 * wiring time. Duplicate catalog ids, malformed source slugs, and classes
 * outside the vocabulary all fail loudly — a silent overwrite would let one
 * source shadow another's installs, a malformed slug would land unqueryable
 * garbage in `brain_episodes.source`, and an unknown class would land a value
 * that every downstream discriminator silently declines to recognise.
 */
export function registerBrainSourceConnector(connector: BrainSourceConnector): void {
  if (!SOURCE_SLUG.test(connector.source)) {
    throw new Error(
      `Brain source slug "${connector.source}" is invalid — expected a lowercase alphanumeric slug matching ${SOURCE_SLUG.source} (it is stored verbatim in brain_episodes.source)`,
    );
  }
  // The runtime half of the closed vocabulary. `source` is typed
  // `EpisodeSource`, which covers every in-repo connector at compile time —
  // but a plugin is compiled separately and arrives here as data, so the
  // check has to exist at runtime too. Failing loudly is the whole point: the
  // alternative is a novel class flowing into `provenance.source`, where
  // `isWarehouseDerived` would simply stop matching and tier-1 correction
  // refusal would fail OPEN without a single red test.
  if (!isEpisodeSource(connector.source)) {
    throw new Error(
      `Brain source class "${connector.source}" is not in the episode-source vocabulary (${EPISODE_SOURCES.join(", ")}) — add it to lib/brain/sources.ts, and if it is warehouse-shaped it must BE "warehouse" or tier-1 correction refusal stops applying to it`,
    );
  }
  if (registry.has(connector.catalogId)) {
    throw new Error(
      `Brain source connector for catalog id "${connector.catalogId}" is already registered`,
    );
  }
  // One catalog id, one ingest target. Both registries claim through the same
  // module so the check is ORDER-INDEPENDENT — an earlier one-sided peek at the
  // knowledge registry only covered the direction that cannot happen (brain
  // sources register last today) and missed the one that can.
  claimCatalogIngestTarget(connector.catalogId, "brain-episodes");
  registry.set(connector.catalogId, connector);
}

export function getBrainSourceConnector(catalogId: string): BrainSourceConnector | undefined {
  return registry.get(catalogId);
}

/** The catalog ids with a registered brain source — the cycle walk's filter. */
export function listBrainSourceCatalogIds(): string[] {
  return [...registry.keys()];
}

/** Test-only: clear the registry (tests register fixtures per-suite). */
export function _resetBrainSourceConnectors(): void {
  registry.clear();
  _resetCatalogIngestClaims("brain-episodes");
}
