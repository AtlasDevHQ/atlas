/**
 * Seeding the synthetic NovaMart corpus into the DEMO workspace (#5603).
 *
 * ## Three phases, and why a human sits between two of them
 *
 *   `ingest`   — the corpus enters as episodes through the ordinary intake seam
 *                (`ingestEpisodes`), the fictional authors are captured as
 *                `directory` identities so claims render a name, and the
 *                contradiction's predicate is declared `single` so the two
 *                rival claims can be put in tension. Nothing here writes a fact.
 *   (extraction) — NOT this module. The real extraction fiber drains the
 *                episodes into draft claims exactly as it would a customer's.
 *                The operator command can trigger one cycle for convenience;
 *                the seed itself never composes a claim.
 *   `coverage` — the roster of channels is persisted so the coverage page has
 *                a denominator, with `#warehouse-ops` carrying no evidence.
 *   `approve`  — the drafts extracted FROM CORPUS EPISODES are promoted through
 *                the review gate's own adapter (`review-gate.approve`, which is
 *                `promoteBrainFacts` — the one permitted `status` writer), in
 *                one transaction, under a request context whose user IS the
 *                approving human, so the audit row's `actor_id` names them the
 *                way the publish route's does. Then the contradiction's
 *                predicate is declared `single` a second time, keyed to the
 *                `predicate_key` the published rival rows ACTUALLY carry (#5620).
 *
 * ## Two cardinality declarations, and why the literal one is not enough
 *
 * The ingest phase declares the literal surface (`CONTRADICTION_PREDICATE_SURFACE`)
 * `single` so an admin's tension sweep is productive before any extraction has
 * run. But `cardinalitySingleSql` matches on the rows' `predicate_key`, and the
 * key is whatever the extractor said (`has return window of` on the demo
 * workspace, #5620) — a literal entry the rows do not carry licenses neither
 * the sweep nor the write-time anchor arm (#5618). The approve phase therefore
 * hands the ids of the rows the expected-claim matcher found to
 * `declarePredicateCardinalityForFacts`, which declares the slot THOSE rows
 * occupy. The key itself is never read here: this file is a `brain_facts` read
 * surface, and `keys-not-on-the-wire.test.ts` refuses a key beside its claim
 * on one (#5019). Additive: the literal stays. Idempotent: `ON CONFLICT DO
 * UPDATE` underneath. And refused when the two rivals occupy different slots —
 * a `single` entry on a key only one of them holds would license supersession
 * in a slot the other never enters, which is worse than no entry, so the seam
 * declares nothing and the seed warns naming both.
 *
 * Registered as a caller of the gate — not a writer — in
 * `docs/development/content-mode.md` § "The demo-corpus seed approves through
 * the gate's adapter". It is not on `check-brain-fact-promotion.sh`'s allowlist
 * and must never need to be.
 *
 * ## What this module refuses, by construction
 *
 *   - **Any workspace that is not the demo.** `resolveDemoWorkspace` requires
 *     the organization's slug to be exactly {@link DEMO_ATLAS_WORKSPACE_SLUG}.
 *     A tenant workspace cannot receive fiction by a typo.
 *   - **Approving anything the corpus did not produce.** The approve phase
 *     selects drafts by joining to the corpus's own episode `source_id`s. A
 *     draft that arrived from a real connector on the demo workspace is left in
 *     the queue for a person.
 *   - **Writing a fact, edge or `status` itself.** Every write goes through the
 *     seam that owns it: `ingestEpisodes`, `captureActorIdentities`,
 *     `persistCoverageSnapshot`, `declarePredicateCardinalityForSurface`,
 *     `declarePredicateCardinalityForFacts`, `approve`. `scripts/check-brain-fact-promotion.sh` would refuse this file
 *     otherwise, and that refusal is the design.
 *
 * ## On the approver's name
 *
 * The audit row's actor is the HUMAN who ran the seed — never a fictional
 * colleague, and never a `system:` principal. The fiction is in the episodes'
 * AUTHORS (who said it), which is what `searchAtlas` renders as "who"; the
 * approval stays attributed to a real person, because PRD finish condition 2
 * admits no exception for seeds and a demo that lies about its own approver
 * would be demonstrating the wrong thing. #5603 asked for "a named fictional
 * reviewer"; this is the recorded deviation, and the issue says so.
 *
 * ## On "marked synthetic in metadata"
 *
 * `brain_episodes` has no metadata column, and the seed adds none. What keeps a
 * customer's coverage count clean is the WORKSPACE boundary — coverage is
 * counted per workspace, and this corpus can only ever land in the one whose
 * slug is the demo's — plus the `NMD` marker every vendor id carries, which is
 * what a human grepping a row reads. Recorded on #5603 as the deviation it is.
 */

import { Effect } from "effect";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { withInternalTransaction } from "@atlas/api/lib/db/with-internal-transaction";
import { logAdminActionAwait, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { ingestEpisodes } from "@atlas/api/lib/brain/ingest/episodes";
import type { BrainEpisodeRecord } from "@atlas/api/lib/brain/ingest/types";
import { deriveChatChannelGrant } from "@atlas/api/lib/brain/ingest/grant";
import { slackEpisodeSourceId } from "@atlas/api/lib/brain/ingest/slack/config";
import { zoomEpisodeSourceId } from "@atlas/api/lib/brain/ingest/zoom/config";
import { outlookEpisodeSourceId } from "@atlas/api/lib/brain/ingest/outlook/config";
import { ORG_PRINCIPAL } from "@atlas/api/lib/brain/acl";
import {
  captureActorIdentities,
  type ActorIdentityCapture,
} from "@atlas/api/lib/brain/actor-identity";
import {
  declarePredicateCardinalityForFacts,
  declarePredicateCardinalityForSurface,
  priorAuditFields,
  type FactSlotDeclarationResult,
} from "@atlas/api/lib/brain/cardinality";
import { identityAlias } from "@atlas/api/lib/brain/identity";
import type { PredicateCardinality } from "@atlas/api/lib/brain/types";
import {
  persistCoverageSnapshot,
  type CoveragePersistReport,
  type EnumeratedSurveyUnit,
} from "@atlas/api/lib/brain/coverage-enumeration";
import crypto from "node:crypto";
import { approve } from "@atlas/api/lib/brain/review-gate";
import {
  DECAY_AGING_AFTER_DAYS,
  DECAY_STALE_AFTER_DAYS,
  LAST_OBSERVED_AT_SELECT,
} from "@atlas/api/lib/brain/staleness";
import { ingestDocuments } from "@atlas/api/lib/knowledge/ingest-bundle";
import {
  KNOWLEDGE_INSTALL_UPSERT_SQL,
  OKF_UPLOAD_CATALOG_ID,
} from "@atlas/api/lib/integrations/install/okf-upload-form-handler";
import { upsertKnowledgeCollectionRow } from "@atlas/api/lib/integrations/install/knowledge-collection-install";
import { renderOkfDocument } from "@atlas/okf-bundle";
import type { WorkspaceId } from "@useatlas/types";
import type { EpisodeSource } from "@atlas/api/lib/brain/sources";
import {
  CHANNELS,
  CONTRADICTION_CLAIMS,
  CORPUS_REFERENCE_DATE,
  CORPUS_REVIEWER,
  DEMO_COLLECTION_SLUG,
  DOCUMENTS,
  CONTRADICTION_PREDICATE_SURFACE,
  DEMO_ID_MARKER,
  EPISODES,
  EXPECTED_CLAIMS,
  PEOPLE,
  matchesExpectedClaim,
  type DemoChannelKey,
  type DemoChatMessage,
  type DemoEpisode,
  type DemoMail,
  type DemoPerson,
  type DemoTranscript,
  type ExpectedClaim,
} from "./corpus";

const log = createLogger("brain:demo-corpus");

/**
 * The ONE workspace this seed will touch. Created once through the ordinary
 * signup flow with this slug; the seed never creates an organization, because
 * that is Better Auth's table and a seed with a foot in the auth schema is a
 * seed that can mint a tenant.
 */
export const DEMO_ATLAS_WORKSPACE_SLUG = "novamart-demo" as const;

/**
 * The synthetic recording-file id every transcript episode carries. Zoom's
 * `source_id` is `<meetingUuid>:<recordingFileId>`, and the builder refuses
 * anything but a GUID here — the `NMD` marker cannot live in hex, so it lives
 * in the meeting uuid instead.
 */
const DEMO_RECORDING_FILE_ID = "00000000-0000-4000-8000-00000000d3a0";

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export class NotTheDemoWorkspaceError extends Error {
  override readonly name = "NotTheDemoWorkspaceError";
  constructor(readonly ref: string, readonly slug: string | null) {
    super(
      slug === null
        ? `No organization matches "${ref}" — the demo seed targets the workspace whose slug is "${DEMO_ATLAS_WORKSPACE_SLUG}" and nothing else.`
        : `Organization "${ref}" has slug "${slug}", not "${DEMO_ATLAS_WORKSPACE_SLUG}" — refusing: the synthetic corpus goes into the demo workspace only, never a tenant's.`,
    );
  }
}

/**
 * Resolve an org id or slug to the demo workspace's id, or throw. The slug
 * check is the whole safety of this module; it is not optional and has no
 * `--force`.
 */
export async function resolveDemoWorkspace(ref: string): Promise<string> {
  const rows = await internalQuery<{ id: string; slug: string | null }>(
    `SELECT id, slug FROM organization WHERE id = $1 OR slug = $1 LIMIT 1`,
    [ref],
  );
  const row = rows[0];
  if (row === undefined) throw new NotTheDemoWorkspaceError(ref, null);
  if (row.slug !== DEMO_ATLAS_WORKSPACE_SLUG) throw new NotTheDemoWorkspaceError(ref, row.slug);
  return row.id;
}

// ---------------------------------------------------------------------------
// Corpus → episode records, one table keyed by kind
// ---------------------------------------------------------------------------

/** What one episode kind knows: its connector, its stored id, its record, and who authored it. */
interface EpisodeKindSpec<E extends DemoEpisode> {
  readonly source: EpisodeSource;
  readonly sourceId: (episode: E) => string;
  /** The vendor-side author handle — what `brain_episodes.source_actor` stores. */
  readonly author: (episode: E) => { person: DemoPerson; vendorUserId: string };
  readonly record: (episode: E) => BrainEpisodeRecord;
}

const CHAT_KIND: EpisodeKindSpec<DemoChatMessage> = {
  source: "slack",
  sourceId: (e) => slackEpisodeSourceId(CHANNELS[e.channel].id, e.ts),
  author: (e) => ({ person: PEOPLE[e.author], vendorUserId: PEOPLE[e.author].slackId }),
  record: (e) => {
    const channel = CHANNELS[e.channel];
    // The REAL deriver, so a private channel gets exactly the audience grant a
    // live Slack message would — not a hand-typed token that could drift from
    // the grammar the ACL predicate parses.
    const grant = deriveChatChannelGrant({
      source: "slack",
      channelId: channel.id,
      isPrivate: channel.isPrivate,
    });
    if (grant === null) throw new Error(`demo corpus: no grant derivable for channel ${channel.id}`);
    return {
      sourceId: CHAT_KIND.sourceId(e),
      sourceActor: CHAT_KIND.author(e).vendorUserId,
      body: e.body,
      occurredAt: new Date(e.occurredAt),
      visibleTo: grant,
    };
  },
};

const TRANSCRIPT_KIND: EpisodeKindSpec<DemoTranscript> = {
  source: "zoom",
  sourceId: (e) => zoomEpisodeSourceId(e.meetingId, DEMO_RECORDING_FILE_ID),
  author: (e) => ({ person: PEOPLE[e.host], vendorUserId: PEOPLE[e.host].zoomId }),
  // `deriveMeetingParticipantGrant` is deliberately NOT used: it derives an
  // audience from a vendor roster, and there is no vendor here. The synthetic
  // all-hands declares its own audience — the whole company — which is the
  // one grant a company-wide recording honestly carries.
  record: (e) => ({
    sourceId: TRANSCRIPT_KIND.sourceId(e),
    sourceActor: TRANSCRIPT_KIND.author(e).vendorUserId,
    body: e.body,
    occurredAt: new Date(e.occurredAt),
    visibleTo: [ORG_PRINCIPAL],
  }),
};

const MAIL_KIND: EpisodeKindSpec<DemoMail> = {
  source: "outlook",
  sourceId: (e) => outlookEpisodeSourceId(e.messageId),
  author: (e) => ({ person: PEOPLE[e.from], vendorUserId: PEOPLE[e.from].email }),
  // Same reasoning as the transcript: the mail is addressed to everyone, and
  // the recipient-set lower bound `deriveEmailRecipientGrant` computes from
  // headers has no headers to read.
  record: (e) => ({
    sourceId: MAIL_KIND.sourceId(e),
    sourceActor: MAIL_KIND.author(e).vendorUserId,
    body: e.body,
    occurredAt: new Date(e.occurredAt),
    visibleTo: [ORG_PRINCIPAL],
  }),
};

function kindOf(episode: DemoEpisode): EpisodeKindSpec<DemoEpisode> {
  switch (episode.kind) {
    case "chat":
      return CHAT_KIND as EpisodeKindSpec<DemoEpisode>;
    case "transcript":
      return TRANSCRIPT_KIND as EpisodeKindSpec<DemoEpisode>;
    case "email":
      return MAIL_KIND as EpisodeKindSpec<DemoEpisode>;
  }
}

/** The `source_id` a corpus episode is stored under. Exported for the test's joins. */
export function corpusSourceId(episode: DemoEpisode): string {
  return kindOf(episode).sourceId(episode);
}

/**
 * One `directory` identity per (source, author) pair that actually authored
 * an episode — not one per person per source. The actor key is
 * `<source>:<vendorUserId>`, the shape `authoringPrincipalSql` composes from
 * `brain_episodes.source || ':' || source_actor`, so the join that names an
 * author finds these rows.
 */
function identityCaptures(): readonly ActorIdentityCapture[] {
  const seen = new Map<string, ActorIdentityCapture>();
  for (const episode of EPISODES) {
    const kind = kindOf(episode);
    const { person, vendorUserId } = kind.author(episode);
    const actor = `${kind.source}:${vendorUserId}`;
    if (seen.has(actor)) continue;
    seen.set(actor, {
      actor,
      source: kind.source,
      vendorUserId,
      state: "directory",
      displayName: person.displayName,
      realName: person.realName,
      email: person.email,
    });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Executors — the `{ query }` shape every brain seam takes
// ---------------------------------------------------------------------------

const executor = {
  query: async (sql: string, params?: unknown[]) => ({
    rows: await internalQuery<Record<string, unknown>>(sql, params ?? []),
  }),
};

// ---------------------------------------------------------------------------
// Phase: ingest
// ---------------------------------------------------------------------------

/** What `ingestEpisodes` did with one source's batch. */
export interface IngestCounts {
  readonly inserted: number;
  readonly duplicate: number;
  readonly refused: number;
}

/** The cardinality declaration's outcome, as the seam reports it. */
export type CardinalityOutcome =
  | { readonly ok: true; readonly cardinality: PredicateCardinality }
  | { readonly ok: false; readonly refusal: string; readonly message: string };

export interface IngestPhaseReport {
  readonly workspaceId: string;
  /** Per source the corpus carries. A source absent here had no corpus episodes. */
  readonly episodes: Readonly<Partial<Record<EpisodeSource, IngestCounts>>>;
  readonly identitiesCaptured: number;
  readonly cardinality: CardinalityOutcome;
}

export async function seedDemoCorpusIngest(params: {
  readonly workspaceRef: string;
  /** The human running the seed — stamped on the cardinality declaration. */
  readonly authoredBy: string;
}): Promise<IngestPhaseReport> {
  const workspaceId = await resolveDemoWorkspace(params.workspaceRef);

  const bySource = new Map<EpisodeSource, BrainEpisodeRecord[]>();
  for (const episode of EPISODES) {
    const kind = kindOf(episode);
    const list = bySource.get(kind.source) ?? [];
    list.push(kind.record(episode));
    bySource.set(kind.source, list);
  }

  const episodes: Partial<Record<EpisodeSource, IngestCounts>> = {};
  for (const [source, records] of bySource) {
    const report = await ingestEpisodes({ workspaceId, source, episodes: records });
    const refused = Object.values(report.refused).reduce((a, b) => a + b, 0);
    episodes[source] = { inserted: report.inserted, duplicate: report.duplicate, refused };
    if (refused > 0) {
      log.warn({ workspaceId, source, refused: report.refused }, "demo corpus: records refused at intake");
    }
  }

  const written = await captureActorIdentities(executor, workspaceId, identityCaptures());

  const declared = await declarePredicateCardinalityForSurface(executor, workspaceId, {
    predicateSurface: CONTRADICTION_PREDICATE_SURFACE,
    cardinality: "single",
    authoredBy: params.authoredBy,
    predicateAlias: identityAlias,
  });
  // `ON CONFLICT DO UPDATE` underneath, so a re-run is `ok` again — the seam
  // only refuses a degenerate key or a missing author, never a repeat.
  const cardinality: CardinalityOutcome = declared.ok
    ? { ok: true, cardinality: declared.cardinality }
    : { ok: false, refusal: declared.refusal, message: declared.message };
  if (!cardinality.ok) {
    log.warn(
      { workspaceId, refusal: cardinality.refusal, message: cardinality.message },
      "demo corpus: cardinality declaration refused — the contradiction will not carry a tension edge until a human declares the predicate single",
    );
  }

  log.info(
    { workspaceId, episodes, identities: written.size, cardinality },
    "demo corpus: ingest phase complete",
  );

  return { workspaceId, episodes, identitiesCaptured: written.size, cardinality };
}

// ---------------------------------------------------------------------------
// Phase: coverage
// ---------------------------------------------------------------------------

export interface CoveragePhaseReport {
  readonly workspaceId: string;
  readonly units: number;
  readonly unsurveyed: readonly string[];
  readonly persist: CoveragePersistReport["status"];
}

/**
 * Persist the chat roster: every channel, in the perimeter, with the newest
 * corpus evidence per channel — which is `null` for `#warehouse-ops`, and that
 * null is what the coverage page renders as unsurveyed.
 *
 * The live scheduler only enumerates chat for workspaces with a Slack install
 * (`CLASS_ENUMERATION_PLANS.chat.listWorkspaces`), so on the demo workspace
 * this roster is not overwritten by a vendor read that would find no channels.
 */
export async function seedDemoCorpusCoverage(params: {
  readonly workspaceRef: string;
  readonly now?: Date;
}): Promise<CoveragePhaseReport> {
  const workspaceId = await resolveDemoWorkspace(params.workspaceRef);
  const cycleAt = params.now ?? new Date();

  const newest = new Map<DemoChannelKey, Date>();
  for (const episode of EPISODES) {
    if (episode.kind !== "chat") continue;
    const at = new Date(episode.occurredAt);
    const prior = newest.get(episode.channel);
    if (prior === undefined || at > prior) newest.set(episode.channel, at);
  }

  const units: EnumeratedSurveyUnit[] = [];
  const unsurveyed: string[] = [];
  for (const key of Object.keys(CHANNELS) as DemoChannelKey[]) {
    const channel = CHANNELS[key];
    const newestEvidenceAt = newest.get(key) ?? null;
    if (newestEvidenceAt === null) unsurveyed.push(`#${channel.name}`);
    units.push({
      unitId: channel.id,
      label: `#${channel.name}`,
      inPerimeter: true,
      // Seeding the roster IS the deliberate act that names these units — the
      // same clause that lets an install-form entry be labelled.
      deliberateAct: true,
      vendorReportsPublic: !channel.isPrivate,
      newestEvidenceAt,
      activity: { probed: false },
    });
  }

  const persist = await persistCoverageSnapshot({
    workspaceId,
    sourceClass: "chat",
    outcome: { ok: true, units, degraded: [] },
    cycleAt,
  });

  log.info(
    { workspaceId, units: units.length, unsurveyed, persist: persist.status },
    "demo corpus: coverage phase complete",
  );
  return { workspaceId, units: units.length, unsurveyed, persist: persist.status };
}

// ---------------------------------------------------------------------------
// Phase: documents
// ---------------------------------------------------------------------------

export interface DocumentsPhaseReport {
  readonly workspaceId: string;
  /** The collection slug the documents landed in. */
  readonly collectionSlug: string;
  /** `workspace_plugins.id` of the collection container. */
  readonly installId: string;
  /** New documents written. */
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /** Documents processed in total — the corpus's own count when nothing was rejected. */
  readonly documents: number;
  /** Documents archived because their path left the corpus — always 0 on a corpus that only grows. */
  readonly archivedAbsent: number | null;
  readonly published: boolean;
  /** Per-file rejections. A non-empty list here means a corpus document is malformed. */
  readonly rejected: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * Put the NovaMart handbook in the Knowledge Base.
 *
 * Two seams, in order, and neither is reimplemented here:
 *
 *   1. `upsertKnowledgeCollectionRow` with the `okf-upload` handler's own
 *      UPSERT — the collection container, `pillar='knowledge'`, whose
 *      `install_id` IS the slug. Re-running edits it in place, so the phase is
 *      idempotent at the container as well as at the documents.
 *   2. `ingestDocuments`, the one ingest seam, with `source: "upload"` and
 *      `publish: true`. Documents ingest as `draft` and the upload-and-publish
 *      promotion (ADR-0028 §4, upload collections only) is what makes them
 *      readable — without it the demo's third store stays empty in a way no
 *      reader could distinguish from having no documents at all.
 *
 * That publish is WORKSPACE-WIDE, which is why the phase refuses to run while
 * brain drafts are pending — see {@link PendingBrainDraftsError}.
 *
 * `archiveAbsent` is deliberately ON: a document dropped from `DOCUMENTS`
 * should stop being served on the next seed rather than linger as a page no
 * source vouches for.
 */
export async function seedDemoCorpusDocuments(params: {
  readonly workspaceRef: string;
}): Promise<DocumentsPhaseReport> {
  const workspaceId = await resolveDemoWorkspace(params.workspaceRef);

  // Checked BEFORE the container is written, so a refusal leaves nothing
  // half-done. See PendingBrainDraftsError for why this is not merely tidy.
  const pendingRows = await internalQuery<{ n: string }>(PENDING_BRAIN_DRAFTS_SQL, [workspaceId]);
  const pending = Number(pendingRows[0]?.n ?? 0);
  if (pending > 0) throw new PendingBrainDraftsError(workspaceId, pending);

  const installId = await upsertKnowledgeCollectionRow({
    workspaceId: workspaceId as WorkspaceId,
    collectionSlug: DEMO_COLLECTION_SLUG,
    sql: KNOWLEDGE_INSTALL_UPSERT_SQL,
    params: [
      crypto.randomUUID(),
      workspaceId,
      OKF_UPLOAD_CATALOG_ID,
      DEMO_COLLECTION_SLUG,
      JSON.stringify({ description: "The NovaMart handbook — the demo company's own pages." }),
    ],
    candidateId: DEMO_COLLECTION_SLUG,
    log,
  });

  const files = DOCUMENTS.map((doc) => ({
    path: doc.path,
    content: renderOkfDocument(
      { title: doc.title, description: doc.description, timestamp: doc.timestamp },
      doc.tags,
      doc.body,
    ),
  }));

  const outcome = await ingestDocuments({
    workspaceId,
    collectionId: DEMO_COLLECTION_SLUG,
    source: "upload",
    files,
    publish: true,
    archiveAbsent: true,
  });

  if (outcome.kind !== "ok") {
    // Every non-ok kind is a real failure of this phase — there is no partial
    // success worth reporting as one, because a half-ingested handbook is a
    // demo that contradicts itself. The kind alone would send a reader to the
    // logs; the payload is the difference between "raise the cap to N" and
    // "something went wrong", so it is serialised with the message.
    throw new Error(
      `demo corpus: document ingest failed for collection "${DEMO_COLLECTION_SLUG}" — ` +
        JSON.stringify(outcome),
    );
  }

  const rejected = outcome.rejected.map((r) => ({ path: r.path, reason: r.reason }));
  if (rejected.length > 0) {
    log.warn(
      { workspaceId, rejected },
      "demo corpus: documents rejected at ingest — a corpus page is malformed and was NOT written",
    );
  }

  const report: DocumentsPhaseReport = {
    workspaceId,
    collectionSlug: DEMO_COLLECTION_SLUG,
    installId,
    created: outcome.report.created,
    updated: outcome.report.updated,
    unchanged: outcome.report.unchanged,
    documents: outcome.report.documents,
    archivedAbsent: outcome.archivedAbsent,
    published: outcome.published,
    rejected,
  };
  log.info({ ...report }, "demo corpus: documents phase complete");
  return report;
}

// ---------------------------------------------------------------------------
// Phase: approve
// ---------------------------------------------------------------------------

/** A `brain_facts` row whose evidence is a corpus episode, at either status. */
interface CorpusFactRow extends Record<string, unknown> {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly source_id: string;
}

/**
 * Facts at one status whose evidence is a corpus episode. The join is on the
 * corpus's own `source_id`s, so a draft extracted from anything else on the
 * demo workspace is not this phase's to touch.
 */
const CORPUS_FACTS_SQL = `SELECT f.id, f.subject, f.predicate, f.object, e.source_id
     FROM brain_facts f
     JOIN brain_episodes e ON e.workspace_id = f.workspace_id AND e.id = f.source_episode_id
    WHERE f.workspace_id = $1
      AND f.status = $2
      AND f.invalidated_at IS NULL
      AND e.source_id = ANY($3::text[])
    ORDER BY f.created_at ASC, f.id ASC`;

/**
 * Published facts bucketed into the decay bands, read at the corpus's own
 * anchor rather than at `now()`.
 *
 * The anchor is the point: episode dates are absolute, so the bands migrate as
 * real time passes, and an operator needs to see how far the corpus has drifted
 * from the distribution it was written to produce. Reading at `now()` would
 * report the drift as if it were the design.
 */
const DECAY_BANDS_SQL = `SELECT
     count(*) FILTER (WHERE age_days >= $2)::text AS stale,
     count(*) FILTER (WHERE age_days >= $3 AND age_days < $2)::text AS aging,
     count(*) FILTER (WHERE age_days < $3)::text AS fresh,
     count(*) FILTER (WHERE age_days IS NULL)::text AS unknown
   FROM (
     SELECT floor(
              extract(epoch FROM ($4::timestamptz - COALESCE(${LAST_OBSERVED_AT_SELECT}, f.valid_from, f.ingested_at)))
              / 86400
            ) AS age_days
       FROM brain_facts f
      WHERE f.workspace_id = $1 AND f.status = 'published'
   ) t`;

const PENDING_BRAIN_DRAFTS_SQL = `SELECT count(*)::text AS n FROM brain_facts WHERE workspace_id = $1 AND status = 'draft'`;

/**
 * The documents phase found pending brain drafts, which its publish would
 * promote with NO approver.
 *
 * `ingestDocuments({ publish: true })` runs `runPublishPhases` WORKSPACE-WIDE
 * (ADR-0028 §4 — "exactly as clicking Publish would"), and that call site
 * passes no `publishedBy`, so `promoteBrainFacts` stamps `published_by = NULL`
 * on every pending draft it finds. For a KB upload that is a pre-existing gap
 * left by #5635; for THIS seed it would silently undo the approver the approve
 * phase exists to set, which is the one thing the demo must not get wrong.
 *
 * So the phase refuses rather than publishing over them. Run `--phase approve`
 * first (or run `--phase documents` on a workspace whose drafts are already
 * promoted); the refusal is cheap and the alternative is a demo whose facts
 * report nobody as their approver.
 */
export class PendingBrainDraftsError extends Error {
  constructor(readonly workspaceId: string, readonly pending: number) {
    super(
      `The documents phase would publish ${pending} pending brain draft(s) with no approver, because its publish runs workspace-wide. ` +
        "Run `--phase approve` first so those drafts carry a named approver, then re-run `--phase documents`.",
    );
    this.name = "PendingBrainDraftsError";
  }
}

const TENSION_EDGES_SQL = `SELECT count(*)::text AS n FROM brain_edges WHERE workspace_id = $1 AND edge_type = 'in-tension-with'`;

/**
 * The reviewer named by `--reviewed-by` must already be a member of the demo
 * workspace. The seed VERIFIES and never creates: minting an Atlas account
 * would put this seed in Better Auth's tables, which is the same line
 * {@link DEMO_ATLAS_WORKSPACE_SLUG} refuses to cross for organizations.
 */
const REVIEWER_SQL = `SELECT u.id, u.name, u.email
   FROM "user" u
   JOIN member m ON m."userId" = u.id
  WHERE u.id = $1 AND m."organizationId" = $2`;

/** `--reviewed-by` names an account that is not a member of the demo workspace. */
export class ReviewerNotAMemberError extends Error {
  constructor(readonly reviewerId: string, readonly workspaceId: string) {
    super(
      `The reviewer ${reviewerId} is not a member of the demo workspace ${workspaceId}. ` +
        "Create the account and add it to the workspace first — the seed verifies this id, it does not mint one.",
    );
    this.name = "ReviewerNotAMemberError";
  }
}

/** `--reviewed-by` names a member, but not the corpus's designated reviewer. */
export class ReviewerNotTheCorpusReviewerError extends Error {
  constructor(readonly reviewerId: string, readonly found: string, readonly expected: string) {
    super(
      `The reviewer ${reviewerId} is a member, but its email is ${found} and the corpus's reviewer is ${expected}. ` +
        "The approver a reader sees on a demo fact is part of the fiction, so it is checked, not left to whoever the operator passed.",
    );
    this.name = "ReviewerNotTheCorpusReviewerError";
  }
}

/**
 * Resolve `--reviewed-by` to the account whose name goes on every promoted fact.
 *
 * Two checks, and the second is the one that makes {@link CORPUS_REVIEWER} mean
 * something outside the tests: membership alone would let any workspace member
 * be stamped as the reviewer, which makes the persona a convention the operator
 * can silently break. The email is the join between the fiction and the account,
 * so it is what gets compared.
 */
async function resolveReviewer(workspaceId: string, reviewerId: string): Promise<{ id: string; name: string }> {
  const rows = await internalQuery<{ id: string; name: string; email: string }>(REVIEWER_SQL, [
    reviewerId,
    workspaceId,
  ]);
  const row = rows[0];
  if (row === undefined) throw new ReviewerNotAMemberError(reviewerId, workspaceId);
  const expected = PEOPLE[CORPUS_REVIEWER].email;
  if (row.email.toLowerCase() !== expected.toLowerCase()) {
    throw new ReviewerNotTheCorpusReviewerError(reviewerId, row.email, expected);
  }
  return { id: row.id, name: row.name };
}

/**
 * What the approve phase did about the contradiction's cardinality, keyed to
 * the slot the published rivals occupy (#5620).
 *
 *   - `not-found`    — a rival has no published row; nothing to declare on.
 *                      `found` is the count of published rows per rival, in
 *                      corpus order.
 *   - `declaration`  — the seam's own outcome: `ok` with the slot and what the
 *                      upsert replaced (#5448), or a refusal — `slot-mismatch`
 *                      naming every slot the rivals occupy, `no-facts`, or the
 *                      direct-authoring refusals.
 */
export type ApproveCardinalityOutcome =
  | { readonly kind: "not-found"; readonly found: readonly number[] }
  | ({ readonly kind: "declaration" } & FactSlotDeclarationResult);

export interface ApprovePhaseReport {
  readonly workspaceId: string;
  /** The operator who ran the seed — the audit row's actor. */
  readonly approvedBy: string;
  /** The workspace member stamped on every promoted fact as its approver. */
  readonly reviewedBy: string;
  /** That member's display name, as a reader of the fact will see it. */
  readonly reviewerName: string;
  /** Draft ids the gate actually promoted this run. Empty on a re-run, which is the idempotent outcome. */
  readonly promoted: readonly string[];
  /** Draft ids the gate refused, with its reasons — left `draft` for a person. */
  readonly refused: readonly { readonly id: string; readonly reasons: readonly string[] }[];
  /** `in-tension-with` edges on the workspace after this run. */
  readonly tensionEdges: number;
  /** Every expected claim, and whether a PUBLISHED corpus claim now matches it. */
  readonly expected: readonly { key: ExpectedClaim["key"]; found: boolean }[];
  readonly missing: readonly ExpectedClaim["key"][];
  /** The keyed `single` declaration for the contradiction's slot (#5620). */
  readonly cardinality: ApproveCardinalityOutcome;
  /**
   * Published facts per decay band, read at {@link CORPUS_REFERENCE_DATE}.
   * Printed by the operator command so drift from the designed distribution is
   * visible without anyone querying for it.
   */
  readonly decayBands: {
    readonly fresh: number;
    readonly aging: number;
    readonly stale: number;
    readonly unknown: number;
  };
}

/**
 * Declare the contradiction's predicate `single` on the slot the published
 * rivals occupy. Selects the rows by the expected-claim matcher — never by the
 * literal surface — and hands their ids to the seam only when EACH rival has a
 * published row. Per rival, not a total: two rows for one rival and none for
 * the other is the one-sided slot the seam's `slot-mismatch` arm exists to
 * refuse, and a total count would pass it.
 */
async function declareContradictionSlot(
  workspaceId: string,
  published: readonly CorpusFactRow[],
  authoredBy: string,
): Promise<ApproveCardinalityOutcome> {
  const perRival = CONTRADICTION_CLAIMS.map((claim) => published.filter((row) => matchesExpectedClaim(row, claim)));
  if (perRival.some((rows) => rows.length === 0)) {
    return { kind: "not-found", found: perRival.map((rows) => rows.length) };
  }
  const declared = await declarePredicateCardinalityForFacts(executor, workspaceId, {
    factIds: perRival.flat().map((row) => row.id),
    cardinality: "single",
    authoredBy,
  });
  if (!declared.ok) {
    log.warn(
      { workspaceId, ...declared },
      "demo corpus: the contradiction's slot was not declared single — the sweep and the anchor arm will not see it, and only the ingest phase's literal entry exists",
    );
  }
  return { kind: "declaration", ...declared };
}

export async function seedDemoCorpusApprove(params: {
  readonly workspaceRef: string;
  /** The human RUNNING the seed — a user id, or `local-operator`. Becomes the audit row's actor. */
  readonly approvedBy: string;
  /**
   * The workspace member whose name a promoted fact carries as its approver
   * (`brain_facts.published_by`, #5635) — the corpus's reviewer, not the
   * operator. Verified to be a member; never created here.
   */
  readonly reviewedBy: string;
  readonly requestId?: string;
}): Promise<ApprovePhaseReport> {
  const workspaceId = await resolveDemoWorkspace(params.workspaceRef);
  const sourceIds = EPISODES.map(corpusSourceId);
  const requestId = params.requestId ?? crypto.randomUUID();

  // The approving human is the request context's user, so `logAdminAction`
  // resolves them as `actor_id` exactly as it does for the publish route —
  // not a `system:` principal with the person tucked into metadata.
  const approver = createAtlasUser(params.approvedBy, "simple-key", params.approvedBy);
  // Resolved BEFORE any write: a bad `--reviewed-by` should cost nothing, and
  // failing after promotion would leave facts approved by the operator again —
  // the exact state this split exists to end.
  const reviewer = await resolveReviewer(workspaceId, params.reviewedBy);

  return withRequestContext(
    { requestId, user: approver, agentOrigin: "chat", actor: { kind: "human" } },
    async () => {
      const drafts = await internalQuery<CorpusFactRow>(CORPUS_FACTS_SQL, [workspaceId, "draft", sourceIds]);
      const draftIds = drafts.map((d) => d.id);

      let promoted: string[] = [];
      let refused: { id: string; reasons: readonly string[] }[] = [];
      if (draftIds.length > 0) {
        const report = await withInternalTransaction("demo-corpus-approve", (client) =>
          // Two different people, two different questions. The audit row's
          // actor is the operator who RAN the seed (the request context above,
          // which `logAdminAction` reads); `published_by` is the workspace
          // member who stood behind the claim (#5635), which is what a reader
          // sees on the fact. Collapsing them made every demo fact report the
          // operator as its own approver, and made the claim's author and its
          // approver the same person wherever the operator was also an author.
          Effect.runPromise(approve(client, workspaceId, draftIds, reviewer.id)),
        );
        refused = (report.refused ?? []).map((r) => ({ id: r.rowId, reasons: r.reasons }));
        const refusedIds = new Set(refused.map((r) => r.id));
        promoted = draftIds.filter((id) => !refusedIds.has(id));
        if (promoted.length !== report.promoted) {
          // The adapter's count and the id arithmetic disagree — report the
          // count's truth, and say so, rather than a list that overstates it.
          log.warn(
            { workspaceId, promotedIds: promoted.length, promotedCount: report.promoted },
            "demo corpus: promoted-id list and the adapter's promoted count disagree — trusting the count",
          );
        }
      }

      // The contradiction's edge is minted by reconcile at WRITE time when the
      // extractor hinted the predicate `single` (`reconcile.ts` gates its
      // tension pass on that per-claim hint). When the live model did not, the
      // edge is NOT minted here: ADR-0037 §7's amendment pins the tension sweep
      // to exactly one non-test caller — the admin route a human presses — and
      // `tension-sweep.test.ts` asserts it. The `single` declarations — the
      // ingest phase's literal one and the keyed one made below — are what make
      // that sweep productive on this workspace; a zero below means "an admin
      // runs the sweep from the facts page", and the operator prints so.
      const edgeRows = await internalQuery<{ n: string }>(TENSION_EDGES_SQL, [workspaceId]);
      const tensionEdges = Number(edgeRows[0]?.n ?? 0);

      const published = await internalQuery<CorpusFactRow>(CORPUS_FACTS_SQL, [workspaceId, "published", sourceIds]);
      const expected = EXPECTED_CLAIMS.map((claim) => ({
        key: claim.key,
        found: published.some((row) => matchesExpectedClaim(row, claim)),
      }));
      const missing = expected.filter((e) => !e.found).map((e) => e.key);

      const cardinality = await declareContradictionSlot(workspaceId, published, params.approvedBy);

      const bandRows = await internalQuery<{ fresh: string; aging: string; stale: string; unknown: string }>(
        DECAY_BANDS_SQL,
        [workspaceId, DECAY_STALE_AFTER_DAYS, DECAY_AGING_AFTER_DAYS, CORPUS_REFERENCE_DATE],
      );
      const b = bandRows[0];
      const decayBands = {
        fresh: Number(b?.fresh ?? 0),
        aging: Number(b?.aging ?? 0),
        stale: Number(b?.stale ?? 0),
        unknown: Number(b?.unknown ?? 0),
      };

      await logAdminActionAwait({
        actionType: ADMIN_ACTIONS.brain.demoCorpusSeed,
        targetType: "brain",
        targetId: workspaceId,
        metadata: {
          phase: "approve",
          reviewedBy: reviewer.id,
          promotedFactIds: promoted,
          refused,
          tensionEdges,
          missingExpectedClaims: missing,
          // The prior entry goes in as the same projection the vocabulary
          // route's audit row uses, so a forensic query reads one shape.
          cardinality:
            cardinality.kind === "declaration" && cardinality.ok
              ? {
                  kind: cardinality.kind,
                  ok: cardinality.ok,
                  slot: cardinality.slot,
                  cardinality: cardinality.cardinality,
                  ...priorAuditFields(cardinality.previous),
                }
              : cardinality,
          marker: DEMO_ID_MARKER,
        },
      });

      if (missing.length > 0) {
        log.warn(
          { workspaceId, missing },
          "demo corpus: expected claims the extractor did not produce — the corpus or the extractor needs attention; nothing was inserted in their place",
        );
      }

      return {
        workspaceId,
        approvedBy: params.approvedBy,
        reviewedBy: reviewer.id,
        reviewerName: reviewer.name,
        promoted,
        refused,
        tensionEdges,
        expected,
        missing,
        cardinality,
        decayBands,
      };
    },
  );
}
