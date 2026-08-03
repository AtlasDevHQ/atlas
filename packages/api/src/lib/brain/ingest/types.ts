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
  prepareAudienceReverifier,
  type AudienceReverifier,
} from "@atlas/api/lib/brain/audience/reverify";
import {
  EPISODE_SOURCES,
  EPISODE_SOURCE_SPECS,
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
 * How a source's `audience:` grants are kept inside the staleness bound (#4985).
 *
 * ## Why this is a FIELD and not a second registration call
 *
 * A source that mints per-object grants needs two things registered: the
 * connector, so it ingests, and an audience re-verifier, so the grants it minted
 * keep resolving. They live in two registries and both throw on a duplicate, so
 * written as two statements the first can commit and the second throw — leaving a
 * source that ingests normally for `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`
 * (168h by default) and then goes silently invisible when `acl.ts` suppresses the
 * audiences nothing refreshed. That half-state is worse than either clean
 * outcome: fully absent is fail-closed and loud (installs 500 at sync time,
 * someone notices the same day), while half-wired is quiet for a week and then
 * reads as the content NOT EXISTING rather than as denied, in a different
 * subsystem, with nothing pointing back at boot.
 *
 * #4983 closed that at runtime by checking the re-verifier registry before
 * committing the connector. This closes it in the SHAPE: a connector carries its
 * audience strategy as one value and {@link registerBrainSourceConnector} is the
 * only call that writes both registries, so the paired registration has no
 * statement ORDER left to get wrong. "Forgot the re-verifier" stops being a class
 * of mistake — the field is required, so the only remaining question is which
 * arm, and that is answered twice: by {@link BrainSourceAudienceFor} at compile
 * time, and by {@link requiresAudienceReverifier} at registration for the lane
 * the type cannot see.
 *
 * What this does NOT claim is that the re-verifier registry became unreachable.
 * `registerAudienceReverifier` still exists for the suites that test that
 * registry, and a source could in principle call it and then register a
 * connector declaring `externally-synced`. Both outcomes are worth stating
 * exactly, because they differ:
 *
 *   - grant-deriving class → {@link requiresAudienceReverifier} (below) refuses
 *     the connector outright, so what is left is a re-verifier with NO connector.
 *     Loud: the vendor's registration threw, `registerStep` logged it at `error`,
 *     and the source ingests nothing at all;
 *   - any other class → both register cleanly and nothing throws. A stray
 *     re-verifier then runs every cycle for a source that declared somebody else
 *     owns the refresh. Nothing detects that, and nothing is meant to — what the
 *     `externally-synced` arm buys there is a DECLARATION a reviewer can check,
 *     not a runtime guarantee.
 *
 * Neither is the half-state this seam exists to prevent, which is specifically a
 * COMMITTED connector whose re-verifier was refused.
 */
export type BrainSourceAudience =
  /**
   * This source mints its own `audience:` grants and brings the re-verifier that
   * refreshes them. Registered under the connector's `source` kind, so the two
   * halves cannot be wired to different sources.
   */
  | { readonly kind: "reverified"; readonly reverifier: AudienceReverifier }
  /**
   * This source's audiences are reconciled by something OTHER than a registered
   * re-verifier, and it registers none.
   *
   * `slack-history` is the shipped case: its grants are channel-scoped and
   * `audience/sync.ts` walks Slack channel rosters directly, parameterised by
   * `SLACK_HISTORY_CATALOG_ID`. Naming that here is the point — the arm is a
   * DECLARATION that somebody else owns the refresh, not an opt-out, so a source
   * that picks it is making a claim a reviewer can check rather than leaving a
   * field off.
   */
  | { readonly kind: "externally-synced" };

/**
 * At what GRAIN a class's audiences are refreshed.
 *
 * `per-object` means the grant is derived from the record itself — a
 * transcript's participants, a mail's recipients — so nothing but a re-verifier
 * registered for THAT source can refresh it.
 *
 * ⚠️ The other value is `not-required` and NOT `"externally-synced"`, even though
 * that is the {@link BrainSourceAudience} arm it licenses, because the two would
 * be read as the same fact and they are not. This axis constrains ONE direction:
 * a `per-object` class MUST declare the `reverified` arm. It says nothing about
 * what a `not-required` class may declare, and nothing enforces the converse —
 * the only instance in-repo is a test fixture. Naming the value after the arm
 * would assert a biconditional that does not hold, an analogous spelling
 * collision to the one `lib/brain/sources.ts` records for its own two axes
 * (theirs is worse: literal-typed constants there are cross-axis assignable, so
 * it is a compile-time trap and not only a reader-level one).
 */
type AudienceGrain = "per-object" | "not-required";

/**
 * Every episode class's audience grain — the single place the decision is made.
 *
 * A `Record<EpisodeSourceClass, …>` rather than the list of grant-deriving
 * classes this started as, because the list form checks MEMBERSHIP and not
 * COMPLETENESS: adding a sixth class to `lib/brain/sources.ts` (`docs`, `wiki`)
 * would have silently inherited the permissive arm, which is the same prose-rule
 * residual `sources.ts` confesses to for `class:` recreated one layer up. Keyed
 * exhaustively, a new class fails to compile here until its author decides — and
 * "decides" is the operative word, since the wrong answer for a grant-deriving
 * class is invisible for 168h. Frozen for the same reason `EPISODE_SOURCE_SPECS`
 * is: it has a runtime reader ({@link requiresAudienceReverifier}).
 */
const AUDIENCE_GRAIN = Object.freeze({
  // Channel-scoped, reconciled by the install-driven Slack walk in
  // `audience/sync.ts`. ⚠️ This map is keyed by CLASS, so a second chat VENDOR
  // (Teams, Discord) inherits `not-required` with no walk of its own — the
  // membership-vs-completeness hazard below, one axis over. Check it when one
  // arrives; nothing here will.
  chat: "not-required",
  transcript: "per-object",
  email: "per-object",
  // Neither comes from a connector at all, so there is nothing to re-verify.
  warehouse: "not-required",
  human: "not-required",
} as const) satisfies Record<EpisodeSourceClass, AudienceGrain>;

/** The classes {@link AUDIENCE_GRAIN} marks `per-object`, as a type. */
type ReverifierRequiredClass = {
  [K in EpisodeSourceClass]: (typeof AUDIENCE_GRAIN)[K] extends "per-object" ? K : never;
}[EpisodeSourceClass];

/**
 * Must a source of this kind bring its own re-verifier?
 *
 * The RUNTIME half of {@link BrainSourceAudienceFor}, and it exists for exactly
 * the reason `isEpisodeSource` does: the type covers every in-repo connector, but
 * ADR-0036 M3 makes connectors plugin-shaped and a plugin is compiled separately,
 * so it reaches this registry as DATA with no literal type to narrow on. Without
 * this check a plugin-supplied transcript connector could declare
 * `externally-synced`, register cleanly, and mint `audience:` grants that nothing
 * refreshes — the 168h-then-invisible failure the whole seam exists to prevent,
 * entering through the one lane the type provably cannot see.
 *
 * Not exported: the only caller is {@link registerBrainSourceConnector}, and the
 * check is worth more as an unavoidable step in the one write path than as a
 * predicate a caller could consult and then not act on — which is precisely the
 * `hasAudienceReverifier` shape #4985 replaced.
 */
function requiresAudienceReverifier(source: EpisodeSource): boolean {
  return AUDIENCE_GRAIN[episodeSourceClass(source)] === "per-object";
}

/**
 * Is this a usable {@link BrainSourceAudience}?
 *
 * Checks the `reverified` arm's `reverifier` is actually callable, not just that
 * the discriminant reads right. A `{ kind: "reverified" }` with the function
 * missing would register `undefined` into the re-verifier registry and
 * `runRegisteredAudienceReverifiers` would then count that source failed on every
 * cycle forever — degraded rather than silent, but still a state registration can
 * refuse for free.
 *
 * `Reflect.get` rather than a cast: the input is genuinely `unknown` here (the
 * plugin lane), and narrowing it with `as` would be asserting the very shape this
 * function exists to establish.
 */
function isBrainSourceAudience(value: unknown): value is BrainSourceAudience {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = Reflect.get(value, "kind");
  const reverifier: unknown = Reflect.get(value, "reverifier");
  // A reverifier on the `externally-synced` arm is a CONTRADICTION, not an extra
  // field to ignore — the arm declares that something else owns the refresh.
  // In-repo it cannot happen (excess-property checking on the literal), but a
  // plugin arrives as data where excess properties are legal, and silently
  // dropping the function would leave that author's audiences ageing out at 168h
  // with the declaration they wrote looking correct.
  if (kind === "externally-synced") return reverifier === undefined;
  return kind === "reverified" && typeof reverifier === "function";
}

/**
 * The `externally-synced` arm's commit — a real no-op, so
 * {@link registerBrainSourceConnector}'s final write is unconditional.
 */
const NO_REVERIFIER_TO_COMMIT = (): void => {};

/**
 * The audience strategies a source of kind `S` may declare.
 *
 * This is AC-5 of #4985 answered YES: for a grant-deriving class, "mints
 * audience grants with no re-verifier" is a TS2322 at the connector literal
 * rather than a runbook item. `BrainSourceAudienceFor<"zoom">` is the
 * `"reverified"` arm alone; `BrainSourceAudienceFor<"slack">` is the whole union.
 *
 * The narrowing bites wherever the source is LITERAL-typed, which is every
 * hand-written connector: each `create*Connector` declares
 * `BrainSourceConnector<typeof X_SOURCE>`, and {@link registerBrainSourceConnector}
 * infers `S` from the value it is handed, so an inline literal is checked too.
 *
 * The conditional is deliberately NON-distributive — the checked type is
 * `(typeof EPISODE_SOURCE_SPECS)[S]["class"]`, not a naked `S` — so a UNION `S`
 * resolves its whole class set at once and only narrows when every member is
 * grant-deriving. `<"zoom" | "outlook">` is still the `reverified` arm alone;
 * `<"zoom" | "slack">` widens. At the default `S = EpisodeSource` the set spans
 * both and the field is the whole union. That is what the registry stores, and it
 * is the honest answer for a connector that arrives as DATA rather than as a
 * checked type — a plugin-supplied one, compiled separately, or an in-repo
 * factory that widened its own return type back to the unparameterised form.
 *
 * ⚠️ So this type is NOT the enforcement on its own, and it would be a mistake to
 * read it as one: every one of those widenings compiles, and the last is
 * literally the signature this refactor deleted from three connectors. What
 * closes the gap is {@link requiresAudienceReverifier}, re-checked inside
 * {@link registerBrainSourceConnector} — the SAME type-plus-runtime split
 * `lib/brain/sources.ts` draws for the source vocabulary, where `EpisodeSource`
 * stops an in-repo connector inventing a kind and `isEpisodeSource` re-checks the
 * data lane. The type is the fast, local error at the literal; the runtime check
 * is what actually holds the invariant.
 */
export type BrainSourceAudienceFor<S extends EpisodeSource> =
  (typeof EPISODE_SOURCE_SPECS)[S]["class"] extends ReverifierRequiredClass
    ? Extract<BrainSourceAudience, { kind: "reverified" }>
    : BrainSourceAudience;

/**
 * A registered brain ingest source: one catalog row → one client factory, plus
 * the audience strategy that keeps its grants alive.
 *
 * `createClient` may throw (bad config, a disconnected upstream OAuth install)
 * — the engine turns that into the source's error outcome with the message
 * surfaced to the admin, so make it actionable.
 *
 * The type parameter exists ONLY to carry the compile-time audience narrowing
 * described on {@link BrainSourceAudienceFor}; every consumer that merely holds
 * connectors (the registry, the cycle walk, the webhook fast-path) uses the
 * unparameterised form and sees the widest shape.
 */
export interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {
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
  readonly source: S;
  /**
   * How this source's `audience:` grants stay inside the staleness bound.
   * Required, and required for a REASON — see {@link BrainSourceAudience}.
   */
  readonly audience: BrainSourceAudienceFor<S>;
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
 * Register a brain source — the connector AND the audience half it declares —
 * for its catalog row. Called once per source at wiring time.
 *
 * Duplicate catalog ids, malformed source slugs, kinds outside the vocabulary, a
 * malformed audience declaration, a grant-deriving class that declared no
 * re-verifier, and a re-verifier already held for this source all fail loudly. A
 * silent overwrite would let one source shadow another's installs, a malformed
 * slug would land unqueryable garbage in `brain_episodes.source`, an unknown kind
 * would land a value that every downstream discriminator silently declines to
 * recognise, a grant-deriving source with no re-verifier would go invisible after
 * 168h, and a duplicate re-verifier would have two of them reconciling against
 * their own rosters with the loser's members revoked every cycle.
 *
 * ## ALL-OR-NOTHING, and how the body is arranged to guarantee it
 *
 * This function writes THREE process-global structures — the catalog-ingest
 * claim, this registry, and the audience re-verifier registry — and a partial
 * commit is the failure #4983/#4985 exist to prevent (see
 * {@link BrainSourceAudience} for what a half-wired source costs). `registerStep`
 * in `integrations/install/register.ts` bounds the blast radius ACROSS vendors and
 * can do nothing about a vendor that committed to one registry and then threw on
 * a second, because no catch can undo a write from the outside.
 *
 * So every throw site sits ABOVE the first write, and the body is split to make
 * that readable:
 *
 *   - the validation half throws and writes nothing. {@link prepareAudienceReverifier}
 *     belongs to it: it performs the duplicate check and returns the commit,
 *     which is why the check cannot be separated from the write it protects;
 *   - `claimCatalogIngestTarget` is the boundary — it checks before it writes, so
 *     a cross-target collision still throws with nothing committed anywhere;
 *   - the two writes after it are `Map.set` calls that cannot fail.
 *
 * Registration is single-threaded boot wiring, so there is no window between the
 * checks and the writes for anything else to claim the source.
 *
 * `S` is inferred from the value so an inline connector literal keeps its literal
 * source kind and gets {@link BrainSourceAudienceFor}'s compile-time check rather
 * than the widened union. The `const` modifier is belt-and-braces rather than
 * load-bearing — the constraint is already a union of string literals, so `S`
 * infers narrowly without it — and it is kept only so a future widening of
 * `EpisodeSource` toward `string` cannot silently take the inference with it.
 * A caller holding an already-widened `BrainSourceConnector` still passes,
 * and that is the lane {@link requiresAudienceReverifier} below exists for: the
 * type cannot see a plugin, a cast, or a factory that widened its own return
 * type, and all three would otherwise re-open exactly the hole this refactor
 * closed.
 */
export function registerBrainSourceConnector<const S extends EpisodeSource>(
  connector: BrainSourceConnector<S>,
): void {
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
  // `audience` is typed, so this reads as dead code for every in-repo connector —
  // and it is exactly as dead as `isEpisodeSource` above, for the same reason. A
  // plugin arrives as data; `undefined.kind` would otherwise be an engine
  // `TypeError` where every other invalid input here names its own fix, and a
  // `{ kind: "reverified" }` with no function would register `undefined` and make
  // the drain throw on every cycle forever.
  const audience: unknown = connector.audience;
  if (!isBrainSourceAudience(audience)) {
    throw new Error(
      `Brain source connector for catalog id "${connector.catalogId}" declared no usable audience strategy — it must be { kind: "reverified", reverifier } for a source whose grants are derived per object, or { kind: "externally-synced" } when something else reconciles them (see BrainSourceAudience in lib/brain/ingest/types.ts)`,
    );
  }
  // The backstop the type cannot provide on the data lane. See
  // {@link requiresAudienceReverifier} — declaring `externally-synced` for a
  // transcript or mail source is the silent 168h decay, so it is refused here
  // rather than merely discouraged by a conditional type a cast can widen past.
  if (audience.kind !== "reverified" && requiresAudienceReverifier(connector.source)) {
    throw new Error(
      `Brain source "${connector.source}" is ${episodeSourceClass(connector.source)}-class, whose audiences are derived per object — it MUST declare audience: { kind: "reverified", reverifier }. Declaring "externally-synced" would ingest content whose audience: grants nothing refreshes; they stop granting at ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS and every fact behind them then reads as ABSENT rather than denied`,
    );
  }
  // The re-verifier's duplicate check, fused to the only thing that installs it.
  // Keyed on `connector.source`, so the connector and its re-verifier cannot be
  // wired to different sources. The `externally-synced` arm gets a real no-op
  // rather than `undefined` + `?.()`, so the commit below is UNCONDITIONAL —
  // "deliberately nothing to commit" and "the thunk went missing" should not be
  // the same silent skip in an all-or-nothing sequence.
  const commitReverifier =
    audience.kind === "reverified"
      ? prepareAudienceReverifier(connector.source, audience.reverifier)
      : NO_REVERIFIER_TO_COMMIT;

  // ── Past this line nothing may throw with a write already committed. ──
  // One catalog id, one ingest target. Both registries claim through the same
  // module so the check is ORDER-INDEPENDENT — an earlier one-sided peek at the
  // knowledge registry only covered the direction that cannot happen (brain
  // sources register last today) and missed the one that can. It checks before
  // it writes, so a collision here still leaves nothing committed.
  claimCatalogIngestTarget(connector.catalogId, "brain-episodes");
  registry.set(connector.catalogId, connector);
  commitReverifier();
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
 * Test-only: tear down EVERYTHING {@link registerBrainSourceConnector} writes —
 * the connector registry, this target's catalog-ingest claims, and the audience
 * re-verifier registry.
 *
 * One clear per write, and that is deliberately the invariant to maintain rather
 * than "remember the re-verifiers too": since #4985 registration has ONE entry
 * point, so teardown has one, and a future fourth structure is added to both
 * halves of the same pair of functions.
 *
 * ⚠️ The three are not symmetric, and the asymmetry is forced rather than
 * sloppy. `_resetCatalogIngestClaims("brain-episodes")` is TARGET-SCOPED — a
 * blanket clear would release the knowledge registry's claims while its own map
 * still held them (`knowledge/catalog-claims.ts` argues that at length).
 * `_resetAudienceReverifiers` is a blanket `clear()`, because that registry has
 * no per-target key to scope by, so it also drops fixture re-verifiers this
 * function never wrote. That is the behaviour the suites want — a total teardown
 * — but do not read it as "clears exactly what we registered".
 *
 * Why totality matters here and not just tidiness: `registerZoomTranscriptConnector`
 * / `registerOutlookMailConnector` gate on the CONNECTOR registry alone
 * (`if (getBrainSourceConnector(id) !== undefined) return;`). Clearing one and not
 * the other lets them de-sync — a suite that resets connectors and then
 * re-registers passes the gate, reaches the re-verifier's duplicate check, and
 * throws `Audience re-verifier for source "…" is already registered`, a failure
 * with nothing to do with what the suite was testing.
 *
 * So this is the reset a suite that registers a brain source calls.
 * `_resetAudienceReverifiers` is for suites whose subject is the re-verifier
 * registry itself and which register no connector at all.
 */
export function _resetBrainSourceConnectors(): void {
  registry.clear();
  _resetCatalogIngestClaims("brain-episodes");
  _resetAudienceReverifiers();
}
