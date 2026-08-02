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
import {
  _resetAudienceReverifiers,
  hasAudienceReverifier,
} from "@atlas/api/lib/brain/audience/reverify";
import {
  EPISODE_SOURCES,
  episodeSourceClass,
  episodeSourceVendor,
  isEpisodeSource,
  type EpisodeSource,
  type EpisodeSourceClass,
  type EpisodeSourceVendor,
} from "@atlas/api/lib/brain/sources";

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
   * The source KIND stamped into `brain_episodes.source` — ADR-0036 is
   * class-major, vendor-minor, and the closed vocabulary lives in
   * `lib/brain/sources.ts`.
   *
   * A KIND, not a class: Slack stamps `"slack"`, which is a VENDOR within the
   * chat class. `warehouse` and `human` happen to be spelled the same on both
   * axes, which is exactly why the distinction is worth naming here.
   *
   * A CLOSED type rather than a slug pattern, because downstream predicates
   * read this value as a discriminator: `isWarehouseDerived` refuses tier-1
   * correction on the WAREHOUSE CLASS alone, so a warehouse connector whose
   * kind resolved to some other class would fail that ADR-level invariant OPEN
   * and nothing would go red. `sources.ts`'s header carries the full argument.
   *
   * This is the connector's ONE identity declaration. Its class and vendor are
   * derived from it (`episodeSourceClass` / `episodeSourceVendor`, and
   * {@link findBrainSourceConnectors} on top of them) rather than declared
   * beside it — two separately-stated fields could disagree, and then the
   * stored column and the registry lookup would answer different questions
   * about the same connector.
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
 * wiring time. Duplicate catalog ids, malformed source slugs, and kinds
 * outside the vocabulary all fail loudly — a silent overwrite would let one
 * source shadow another's installs, a malformed slug would land unqueryable
 * garbage in `brain_episodes.source`, and an unknown kind would land a value
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
  // alternative is a novel kind flowing into `provenance.source`, which no
  // region can resolve to a class. Since #4964 that fails CLOSED rather than
  // open — every fact derived from it is correction-quarantined under
  // UNRECOGNIZED_SOURCE_KIND — so the hazard is no longer a silent tier-1
  // downgrade. It is a loud one that persists until the vocabulary admits the
  // kind: until then the connector's own facts are uncorrectable everywhere,
  // which is still a class the registry must never admit. (The neighbouring
  // hazard `BrainSourceConnector.source`'s own docstring names above — a member
  // declaring the WRONG class — is unaffected and still fails open; nothing in
  // the type system knows what "warehouse-shaped" means.)
  if (!isEpisodeSource(connector.source)) {
    throw new Error(
      `Brain source "${connector.source}" is not in the episode-source vocabulary (${EPISODE_SOURCES.join(", ")}) — add it to EPISODE_SOURCE_SPECS in lib/brain/sources.ts, declaring its class. If it is warehouse-shaped it MUST declare class: "warehouse", or tier-1 correction refusal will not apply to any fact derived from it`,
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

/**
 * Register a brain source AND its audience re-verifier as one unit.
 *
 * ## Why this exists rather than two calls in a row
 *
 * A source that derives per-object grants needs BOTH: the connector to ingest,
 * and the re-verifier to keep the grants it minted from going stale. They live
 * in two registries, and both throw on a duplicate. Written as two bare
 * statements — which is how Zoom and Outlook were first wired — a throw from the
 * SECOND leaves the first committed, and the caller's idempotence gate
 * (`getBrainSourceConnector(id) !== undefined`) reads only that first registry.
 * So the retry short-circuits and the half-state is permanent for the process.
 *
 * That half-state is the worst of the three outcomes, and it is worth being
 * precise about why. Fully registered is correct. Fully absent is fail-closed
 * and loud — installs 500 at sync time and someone notices the same day. HALF
 * registered ingests normally for `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`
 * (168h by default) and only then goes wrong, at which point `acl.ts` suppresses
 * every audience the missing re-verifier was supposed to refresh and every fact
 * behind them reads as ABSENT rather than as denied. A week later, in a
 * different subsystem, with nothing pointing back here.
 *
 * So the re-verifier registry is checked BEFORE the connector is committed. That
 * ordering is the whole point: after this check the only remaining throw sites
 * are inside {@link registerBrainSourceConnector}, which validates before it
 * writes and whose own two writes (`claimCatalogIngestTarget` then
 * `registry.set`) already fail with nothing committed. Registration is
 * single-threaded boot wiring, so there is no window between the check and the
 * write for anything else to claim the source.
 *
 * A source with no per-object grants (slack-history — its grants are channel
 * scoped and reconciled by the install-driven sweep) has no re-verifier to pair
 * and calls {@link registerBrainSourceConnector} directly.
 *
 * @param connector the source to register
 * @param registerReverifier commits the re-verifier; called only once the
 *   connector is registered and the duplicate check above has passed. Keyed on
 *   `connector.source`, so the two halves cannot be wired to different sources.
 */
export function registerBrainSourceWithAudienceReverifier(
  connector: BrainSourceConnector,
  registerReverifier: () => void,
): void {
  if (hasAudienceReverifier(connector.source)) {
    throw new Error(
      `Audience re-verifier for source "${connector.source}" is already registered — refusing to register its brain source connector, because committing one without the other leaves the source ingesting content whose grants are never re-verified`,
    );
  }
  registerBrainSourceConnector(connector);
  registerReverifier();
}

export function getBrainSourceConnector(catalogId: string): BrainSourceConnector | undefined {
  return registry.get(catalogId);
}

/** Which connectors to resolve. An omitted field does not constrain. */
export interface BrainSourceConnectorQuery {
  /** ADR-0036's class-major axis — `chat`, `warehouse`, … */
  readonly sourceClass?: EpisodeSourceClass;
  /**
   * The vendor-minor axis, typed to the vendors that MEMBERS ACTUALLY NAME
   * rather than to `string`. A typo would otherwise compile and return `[]`,
   * which is indistinguishable from "that connector is not installed" — for the
   * M3 webhook fast-path, a silently dropped event rather than a crash.
   *
   * There is deliberately no `null` here, and it is not an oversight. "The
   * sources with no vendor" is not a third state to query: `EpisodeSourceSpec`
   * (`lib/brain/sources.ts`) makes vendor-ness a property OF the class, so that
   * set is exactly `sourceClass: "warehouse" | "human"` and is already
   * expressible on the other axis.
   *
   * Be exact about what dropping it bought, because it is NOT the widening.
   * This repo does not enable `exactOptionalPropertyTypes`, so `{ vendor:
   * maybeVendor }` still type-checks and an explicit `undefined` still means
   * "do not constrain" — that behaviour is retained deliberately and pinned in
   * `episode-sync-archive.test.ts`. What the two-state shape removes is the
   * ambiguity of INTENT: a caller who meant "the vendorless set" can no longer
   * express it on this axis at all, so they cannot silently receive "all
   * sources" instead.
   *
   * ⚠️ Composing this with `episodeSourceVendor` — "find this source's
   * siblings" — therefore needs a BRANCH, not a coalesce. That accessor returns
   * `EpisodeSourceVendor | null`, which does not fit here, and the repair a
   * caller reaches for (`?? undefined`) would turn "this source has no vendor"
   * into "match everything", relocating the over-returning bug from the type to
   * the call site. Write it as:
   *
   *     const v = episodeSourceVendor(source);
   *     const found = v === null
   *       ? findBrainSourceConnectors({ sourceClass: episodeSourceClass(source) })
   *       : findBrainSourceConnectors({ vendor: v });
   */
  readonly vendor?: EpisodeSourceVendor;
}

/**
 * Resolve registered connectors by ADR-0036's class-major / vendor-minor axes
 * (#4963) — the class+vendor lookup the catalog-id map cannot serve, since a
 * catalog id is an INSTALL-routing key and says nothing about what class of
 * evidence the connector produces.
 *
 * Both axes are read off the connector's declared `source` through
 * `lib/brain/sources.ts`, never off fields the connector states separately. A
 * connector that could name its own class alongside its stored value could name
 * them INCONSISTENTLY, and then "the chat connectors" and "the connectors whose
 * episodes are chat-class" would be two different sets — with the ACL and
 * extraction paths keying off the stored value and this lookup keying off the
 * declaration. One declared fact, both axes derived, no way to disagree.
 *
 * Returns an array, not a single connector: nothing bounds a class+vendor pair
 * to one catalog row, and two rows for one vendor (say Slack history and a
 * later Slack-canvases source) is a shape the ADR permits. A caller that needs
 * exactly one must say so itself rather than inherit a uniqueness this registry
 * never enforced.
 *
 * The two axes are AND-ed. An unsatisfiable pair (the slack vendor within the
 * warehouse class) resolves to nothing, which is the only honest answer — a
 * fallback to either axis alone would route warehouse work to a chat connector.
 *
 * The production caller is #4967's Slack webhook fast-path
 * (`ingest/slack/webhook.ts`), which resolves connectors on the VENDOR axis for
 * an arriving event — `{ vendor: SLACK_SOURCE }`, not a class. The CLASS axis
 * has no production caller today; #4965/#4966 are the connectors that make it
 * non-trivial, and it is kept because a class-grained consumer is the shape the
 * seam exists to admit. Do not cite the webhook as evidence the class axis is
 * exercised in production — it is not.
 */
export function findBrainSourceConnectors(
  query: BrainSourceConnectorQuery = {},
): readonly BrainSourceConnector[] {
  const { sourceClass, vendor } = query;
  return [...registry.values()].filter((connector) => {
    if (sourceClass !== undefined && episodeSourceClass(connector.source) !== sourceClass) {
      return false;
    }
    if (vendor !== undefined && episodeSourceVendor(connector.source) !== vendor) {
      return false;
    }
    return true;
  });
}

/** The catalog ids with a registered brain source — the cycle walk's filter. */
export function listBrainSourceCatalogIds(): string[] {
  return [...registry.keys()];
}

/**
 * Test-only: clear the registry (tests register fixtures per-suite).
 *
 * Clears the audience-re-verifier registry too, because #4965/#4966 made source
 * registration a TWO-registry write while the idempotence gate inside
 * `registerZoomTranscriptConnector` / `registerOutlookMailConnector` still reads only this one
 * (`if (getBrainSourceConnector(id) !== undefined) return;`). Clearing one and
 * not the other lets them de-sync: a suite that resets connectors and then
 * re-registers passes the gate, reaches `registerXxxAudienceReverifier`, and
 * throws `Audience re-verifier for source "…" is already registered` — a failure
 * with nothing to do with what the suite was testing. Resetting both keeps the
 * pair that boot writes together torn down together.
 */
export function _resetBrainSourceConnectors(): void {
  registry.clear();
  _resetCatalogIngestClaims("brain-episodes");
  _resetAudienceReverifiers();
}
