/**
 * Seeding the synthetic NovaMart corpus into the DEMO workspace (#5603).
 *
 * ## Three phases, and why a human sits between two of them
 *
 *   `ingest`   — the corpus enters as episodes through the ordinary intake seam
 *                (`ingestEpisodes`), the fictional authors are captured as
 *                `directory` identities so claims render a name, the roster of
 *                channels is persisted so the coverage page has a denominator,
 *                and the contradiction's predicate is declared `single` so the
 *                two rival claims can be put in tension. Nothing here writes a
 *                fact.
 *   (extraction) — NOT this module. The real extraction fiber drains the
 *                episodes into draft claims exactly as it would a customer's.
 *                The operator command can trigger one cycle for convenience;
 *                the seed itself never composes a claim.
 *   `approve`  — the drafts extracted FROM CORPUS EPISODES are promoted through
 *                the review gate's own adapter (`review-gate.approve`, which is
 *                `promoteBrainFacts` — the one permitted `status` writer), in
 *                one transaction, with an audit row naming who approved.
 *
 * ## What this module refuses, by construction
 *
 *   - **Any workspace that is not the demo.** `resolveDemoWorkspace` requires
 *     the organization's slug to be exactly {@link DEMO_ATLAS_WORKSPACE_SLUG}.
 *     A tenant workspace cannot receive fiction by a typo in `--workspace`.
 *   - **Approving anything the corpus did not produce.** The approve phase
 *     selects drafts by joining to the corpus's own episode `source_id`s. A
 *     draft that arrived from a real connector on the demo workspace is left in
 *     the queue for a person.
 *   - **Writing a fact, edge or `status` itself.** Every write goes through the
 *     seam that owns it: `ingestEpisodes`, `captureActorIdentities`,
 *     `persistCoverageSnapshot`, `declarePredicateCardinalityForSurface`,
 *     `approve`. `scripts/check-brain-fact-promotion.sh`
 *     would refuse this file otherwise, and that refusal is the design.
 *
 * ## On the approver's name
 *
 * The audit row records `approvedBy` — the id of the HUMAN who ran the seed —
 * as the actor, never a fictional colleague. The fiction is in the episodes'
 * AUTHORS (who said it), which is what `searchAtlas` renders as "who"; the
 * approval stays attributed to a real person, because PRD finish condition 2
 * admits no exception for seeds and a demo that lies about its own approver
 * would be demonstrating the wrong thing.
 */

import { Effect } from "effect";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { withInternalTransaction } from "@atlas/api/lib/db/with-internal-transaction";
import { logAdminActionAwait, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { createLogger } from "@atlas/api/lib/logger";
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
import { declarePredicateCardinalityForSurface } from "@atlas/api/lib/brain/cardinality";
import { identityAlias } from "@atlas/api/lib/brain/identity";
import {
  persistCoverageSnapshot,
  type EnumeratedSurveyUnit,
} from "@atlas/api/lib/brain/coverage-enumeration";
import { approve } from "@atlas/api/lib/brain/review-gate";
import type { EpisodeSource } from "@atlas/api/lib/brain/sources";
import {
  CHANNELS,
  CONTRADICTION_PREDICATE_SURFACE,
  DEMO_ID_MARKER,
  EPISODES,
  EXPECTED_CLAIMS,
  PEOPLE,
  matchesExpectedClaim,
  type DemoChannelKey,
  type DemoEpisode,
  type DemoPerson,
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
 * `source_id` is `<meetingUuid>:<recordingFileId>`; there is one file per
 * synthetic meeting.
 */
// A GUID because `zoomEpisodeSourceId` refuses any other shape; the marker
// cannot live in hex, so it lives in the meeting uuid instead.
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
// Corpus → episode records, per source
// ---------------------------------------------------------------------------

/** The `source_id` a corpus episode is stored under. Exported for the approve join and the test. */
export function corpusSourceId(episode: DemoEpisode): string {
  switch (episode.kind) {
    case "chat":
      return slackEpisodeSourceId(CHANNELS[episode.channel].id, episode.ts);
    case "transcript":
      return zoomEpisodeSourceId(episode.meetingId, DEMO_RECORDING_FILE_ID);
    case "email":
      return outlookEpisodeSourceId(episode.messageId);
  }
}

function corpusSource(episode: DemoEpisode): EpisodeSource {
  switch (episode.kind) {
    case "chat":
      return "slack";
    case "transcript":
      return "zoom";
    case "email":
      return "outlook";
  }
}

function toRecord(episode: DemoEpisode): BrainEpisodeRecord {
  const occurredAt = new Date(episode.occurredAt);
  switch (episode.kind) {
    case "chat": {
      const channel = CHANNELS[episode.channel];
      // The REAL deriver, so a private channel gets exactly the audience grant a
      // live Slack message would — not a hand-typed token that could drift from
      // the grammar the ACL predicate parses.
      const grant = deriveChatChannelGrant({
        source: "slack",
        channelId: channel.id,
        isPrivate: channel.isPrivate,
      });
      if (grant === null) {
        throw new Error(`demo corpus: no grant derivable for channel ${channel.id}`);
      }
      return {
        sourceId: corpusSourceId(episode),
        sourceActor: PEOPLE[episode.author].slackId,
        body: episode.body,
        occurredAt,
        visibleTo: grant,
      };
    }
    case "transcript":
      // `deriveMeetingParticipantGrant` is deliberately NOT used: it derives an
      // audience from a vendor roster, and there is no vendor here. The
      // synthetic all-hands declares its own audience — the whole company —
      // which is the one grant a company-wide recording honestly carries.
      return {
        sourceId: corpusSourceId(episode),
        sourceActor: PEOPLE[episode.host].zoomId,
        body: episode.body,
        occurredAt,
        visibleTo: [ORG_PRINCIPAL],
      };
    case "email":
      // Same reasoning as the transcript: the mail is addressed to everyone, and
      // the recipient-set lower bound `deriveEmailRecipientGrant` computes from
      // headers has no headers to read.
      return {
        sourceId: corpusSourceId(episode),
        sourceActor: PEOPLE[episode.from].email,
        body: episode.body,
        occurredAt,
        visibleTo: [ORG_PRINCIPAL],
      };
  }
}

/** Every corpus `source_id`, for the approve join. */
export function corpusSourceIds(): readonly string[] {
  return EPISODES.map(corpusSourceId);
}

function identityCaptures(): readonly ActorIdentityCapture[] {
  const out: ActorIdentityCapture[] = [];
  for (const person of Object.values(PEOPLE) as readonly DemoPerson[]) {
    const directory = {
      state: "directory" as const,
      displayName: person.displayName,
      realName: person.realName,
      email: person.email,
    };
    // `actor` is `<source>:<vendorUserId>` — the shape `authoringPrincipalSql`
    // composes from `brain_episodes.source || ':' || source_actor`, so the join
    // that names an author finds these rows.
    out.push({ ...directory, actor: `slack:${person.slackId}`, source: "slack", vendorUserId: person.slackId });
    out.push({ ...directory, actor: `zoom:${person.zoomId}`, source: "zoom", vendorUserId: person.zoomId });
    out.push({ ...directory, actor: `outlook:${person.email}`, source: "outlook", vendorUserId: person.email });
  }
  return out;
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

export interface IngestPhaseReport {
  readonly workspaceId: string;
  readonly episodes: Readonly<Record<EpisodeSource, { inserted: number; duplicate: number; refused: number }>>;
  readonly identitiesCaptured: number;
  readonly cardinality: string;
}

export async function seedDemoCorpusIngest(params: {
  readonly workspaceRef: string;
  /** The human running the seed — stamped on the cardinality declaration. */
  readonly authoredBy: string;
}): Promise<IngestPhaseReport> {
  const workspaceId = await resolveDemoWorkspace(params.workspaceRef);

  const bySource = new Map<EpisodeSource, BrainEpisodeRecord[]>();
  for (const episode of EPISODES) {
    const source = corpusSource(episode);
    const list = bySource.get(source) ?? [];
    list.push(toRecord(episode));
    bySource.set(source, list);
  }

  const episodes: Record<string, { inserted: number; duplicate: number; refused: number }> = {};
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

  const cardinality = declared.ok
    ? `declared:${declared.cardinality}`
    : `refused:${declared.refusal}`;
  if (!declared.ok) {
    log.warn({ workspaceId, refusal: declared.refusal, message: declared.message }, "demo corpus: cardinality declaration refused — the contradiction will not carry a tension edge");
  }

  log.info(
    { workspaceId, episodes, identities: written.size, cardinality },
    "demo corpus: ingest phase complete",
  );

  return {
    workspaceId,
    episodes: episodes as IngestPhaseReport["episodes"],
    identitiesCaptured: written.size,
    cardinality,
  };
}

// ---------------------------------------------------------------------------
// Phase: coverage
// ---------------------------------------------------------------------------

export interface CoveragePhaseReport {
  readonly workspaceId: string;
  readonly units: number;
  readonly unsurveyed: readonly string[];
  readonly persist: string;
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

  log.info({ workspaceId, units: units.length, unsurveyed, persist: persist.status }, "demo corpus: coverage phase complete");
  return { workspaceId, units: units.length, unsurveyed, persist: persist.status };
}

// ---------------------------------------------------------------------------
// Phase: approve
// ---------------------------------------------------------------------------

interface DraftRow extends Record<string, unknown> {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly source_id: string;
}

/**
 * Drafts (or, with `status`, published rows) whose evidence is a corpus
 * episode. The join is on the corpus's own `source_id`s, so a draft extracted
 * from anything else on the demo workspace is not this phase's to touch.
 */
const CORPUS_FACTS_SQL = `SELECT f.id, f.subject, f.predicate, f.object, e.source_id
     FROM brain_facts f
     JOIN brain_episodes e ON e.workspace_id = f.workspace_id AND e.id = f.source_episode_id
    WHERE f.workspace_id = $1
      AND f.status = $2
      AND f.invalidated_at IS NULL
      AND e.source_id = ANY($3::text[])
    ORDER BY f.created_at ASC, f.id ASC`;

const TENSION_EDGES_SQL = `SELECT count(*)::text AS n FROM brain_edges WHERE workspace_id = $1 AND edge_type = 'in-tension-with'`;

export interface ApprovePhaseReport {
  readonly workspaceId: string;
  readonly approvedBy: string;
  /** Draft ids promoted this run. Empty on a re-run, which is the idempotent outcome. */
  readonly promoted: readonly string[];
  readonly refused: number;
  /** `in-tension-with` edges on the workspace after this run — the contradiction's, when reconcile minted it. */
  readonly tensionEdges: number;
  /** Every expected claim, and whether a PUBLISHED corpus claim now matches it. */
  readonly expected: readonly { key: ExpectedClaim["key"]; found: boolean }[];
  readonly missing: readonly ExpectedClaim["key"][];
}

export async function seedDemoCorpusApprove(params: {
  readonly workspaceRef: string;
  /** The human approving — a user id, or `local-operator`. Stamped on the audit row. */
  readonly approvedBy: string;
}): Promise<ApprovePhaseReport> {
  const workspaceId = await resolveDemoWorkspace(params.workspaceRef);
  const sourceIds = corpusSourceIds();

  const drafts = await internalQuery<DraftRow>(CORPUS_FACTS_SQL, [workspaceId, "draft", sourceIds]);
  const draftIds = drafts.map((d) => d.id);

  let promoted = 0;
  let refused = 0;
  if (draftIds.length > 0) {
    const report = await withInternalTransaction("demo-corpus-approve", (client) =>
      Effect.runPromise(approve(client, workspaceId, draftIds)),
    );
    promoted = report.promoted;
    refused = report.refused?.length ?? 0;
  }

  // The contradiction's edge is minted by reconcile at WRITE time when the
  // extractor hinted the predicate `single` (`reconcile.ts` gates its tension
  // pass on that per-claim hint). When the live model did not, the edge is
  // NOT minted here: ADR-0037 §7's amendment pins the tension sweep to exactly
  // one non-test caller — the admin route a human presses — and
  // `tension-sweep.test.ts` asserts it. The ingest phase's `single` declaration
  // is what makes that sweep productive on this workspace; a zero below means
  // "an admin runs the sweep from the facts page", and the operator prints so.
  const edgeRows = await internalQuery<{ n: string }>(TENSION_EDGES_SQL, [workspaceId]);
  const tensionEdges = Number(edgeRows[0]?.n ?? 0);

  const published = await internalQuery<DraftRow>(CORPUS_FACTS_SQL, [workspaceId, "published", sourceIds]);
  const expected = EXPECTED_CLAIMS.map((claim) => ({
    key: claim.key,
    found: published.some((row) => matchesExpectedClaim(row, claim)),
  }));
  const missing = expected.filter((e) => !e.found).map((e) => e.key);

  await logAdminActionAwait({
    actionType: ADMIN_ACTIONS.brain.demoCorpusSeed,
    targetType: "brain",
    targetId: workspaceId,
    scope: "platform",
    systemActor: "system:atlas-operator",
    metadata: {
      phase: "approve",
      approvedBy: params.approvedBy,
      promotedFactIds: draftIds,
      promoted,
      refused,
      tensionEdges,
      missingExpectedClaims: missing,
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
    promoted: promoted > 0 ? draftIds : [],
    refused,
    tensionEdges,
    expected,
    missing,
  };
}
