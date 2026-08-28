/**
 * The autonomous insight suggester (#5488) — ADR-0036 §T9 lock 1's *permitted*
 * autonomy, built to its wording rather than around it:
 *
 * > An autonomous insight-detector is permitted only as an **opt-in,
 * > off-by-default, per-workspace, draft-only suggester** (mirrors `learn/`'s
 * > `ATLAS_LEARN_PROMOTE_DECAY_ENABLED`).
 *
 * Five constraints, all load-bearing, each with its enforcement named:
 *
 *   - **Opt-in / off-by-default** — `ATLAS_BRAIN_SUGGESTER_ENABLED`, a
 *     workspace-scoped registry boolean defaulting `"false"`. The registry
 *     entry is cross-checked against {@link SUGGESTER_ENABLED_KEY} by
 *     `__tests__/suggester.test.ts`, the same guard the promote/decay
 *     precedent carries.
 *   - **Per-workspace** — one platform fiber iterates the workspaces that
 *     opted in, resolved fresh every tick. ⚠️ **The platform-scope enrollment
 *     footgun, stated rather than rediscovered** (the issue names it): a
 *     naïve per-workspace `getSettingAuto` sweep on SaaS would let a
 *     platform-scoped `true` fall through the tier chain and enroll EVERY
 *     tenant at once. So on SaaS, "opted in" means "has an explicit
 *     workspace-scoped DB override set to true" — {@link LIST_SUGGESTER_ORG_IDS_SQL}
 *     reads the `settings` table directly and a platform `true` enrolls
 *     nobody, exactly as `promote-decay-scheduler.ts`'s enumeration does. On
 *     self-hosted the deployment's own workspaces resolve through the normal
 *     tier chain (workspace override > platform override > env > default
 *     false), so the single-tenant operator can opt in with one env var — the
 *     degenerate case, not a different model.
 *   - **Draft-only** — this module writes no `brain_facts` SQL at all. Claims
 *     enter through `reconcileFacts`, whose `INSERT_FACT_SQL` never names
 *     `status`, so 0180's `DEFAULT 'draft'` applies and
 *     `scripts/check-brain-fact-promotion.sh` refuses any second status
 *     writer. A suggested draft leaves draft state only through the #5483
 *     review gate (`/api/v1/admin/publish`), like every other draft.
 *   - **Never publishes** — nothing here imports the promotion machinery, and
 *     the source scan in `__tests__/suggester.test.ts` keeps it that way.
 *   - **Distinguishable** — every claim is stamped
 *     `producer: BRAIN_SUGGESTER_PRODUCER`, which the review surface renders
 *     as its own origin badge beside (and distinct from) the `proposal`
 *     badge, so a reviewer can tell a machine's guess from a person's
 *     testimony at a glance.
 *
 * ## What a tick does
 *
 * For each opted-in workspace: find recently-idle conversations that have not
 * yet been harvested, run the extraction contract (`extract-contract.ts`'s
 * prompt, schema and candidate mapping — the same one the connector drain
 * uses, at the same ingest model tier) over each transcript, and file
 * whatever it finds through `reconcileFacts`. Entity resolution, grant
 * derivation, corroboration dedupe and the advisory contradiction set all
 * come from entering through that seam, which is ADR-0036 §T6's whole point.
 *
 * ## Lock 3 — the session episode, minted lazily and only on a find
 *
 * A conversation the model drew claims from is materialized as a tier-3
 * session episode via `materializeSessionEpisode` — the SAME lazy,
 * idempotent, by-reference materialization the human `proposeFact` path uses
 * (#5486), inside the same transaction as the facts it evidences. A
 * conversation the model found NOTHING in materializes nothing: minting an
 * episode no claim derives from would be the eager per-session episoding
 * lock 3 rejected. The grant seed is therefore the materializer's own —
 * `[user:<owner>]` on a fresh mint, the conversation owner being the
 * narrowest defensible audience a session has — never a silent `[org]`;
 * widening is the reviewer's decision at the gate, where
 * `widenGrantFromEvidence` runs.
 *
 * Unlike the human path there is no proposal episode: nobody vouched. The
 * session IS the evidence, so the session episode takes the `provenance`
 * edge through the seam (feeding the distinct-source count and the staleness
 * anchor), and no `derives-from` sibling is written — one act, one edge, no
 * self-echo inflation.
 *
 * `sourcePrincipal` is passed explicitly as `user:<owner>` — the owner's
 * words are the source — so that a later human proposal of the same claim by
 * the same person counts as ONE distinct source, not two. Attributing it to
 * the machine would let the suggester manufacture corroboration weight out
 * of a conversation the human already stands behind (§T9 lock 5's self-echo
 * discount, applied at the attribution).
 *
 * ## Disabling stops production, and nothing else
 *
 * The opt-in is read per tick, so flipping it off stops NEW suggestions on
 * the next tick with no restart. Drafts already raised are untouched: this
 * module contains no DELETE, no retraction and no status write, so there is
 * nothing here that COULD reap them — the acceptance criterion is held
 * structurally, and the source scan pins it.
 *
 * ## Bounds, stated honestly
 *
 *   - **One harvest per conversation.** The durable watermark is the session
 *     episode itself (`NOT EXISTS` on 0180's dedupe key): a conversation that
 *     yielded claims — or that a human proposed from — is never re-scanned,
 *     so a conversation that keeps growing after its harvest is not
 *     revisited. Re-suggesting on new activity needs a real per-conversation
 *     watermark (a column or a table), deliberately deferred: the dedupe at
 *     the seam makes a future rescan safe, and v1's job is the trust dial,
 *     not recall.
 *   - **No-find conversations are remembered in memory only.** A conversation
 *     scanned to no effect is recorded in a per-process ledger keyed on its
 *     `updated_at` (so new activity re-qualifies it) and re-scanned after a
 *     restart. Bounded by {@link SUGGESTER_LOOKBACK_MS} and
 *     {@link CONVERSATIONS_PER_TICK}; on a multi-replica deployment each
 *     replica keeps its own ledger, so read the spend as ×R — the same
 *     honesty note `extract.ts` carries for its quarantine ledger. The
 *     transactional episode mint means two replicas racing one conversation
 *     file its claims once: the loser's reconcile corroborates, never
 *     duplicates.
 *   - **The lookback is a start line, not a backlog.** Turning the dial on
 *     harvests conversations from the last {@link SUGGESTER_LOOKBACK_MS},
 *     not the workspace's whole history — an opt-in should start suggesting,
 *     not detonate a year of chat into the review queue. (Extraction's
 *     drain-the-backlog posture doesn't transfer: sessions are not queued
 *     episodes.)
 *
 * ## `learn/` stays a distinct class (lock 4)
 *
 * This module is MODELLED ON `learn/`'s trust dial and imports nothing from
 * it; `learn/` keeps zero references to `brain_facts`, `reconcileFacts` and
 * `lib/brain/` — query patterns are procedural knowledge, not tier-2 claims.
 * `__tests__/suggester.test.ts` scans that boundary.
 */

import type { ClaimVocabulary } from "@atlas/api/lib/brain/identity";
import { BRAIN_SUGGESTER_PRODUCER } from "@useatlas/schemas";

import { createLogger } from "@atlas/api/lib/logger";
import { USER_PREFIX } from "@atlas/api/lib/brain/acl";
import {
  llmFactExtractor,
  resolveExtractionModel,
  type FactExtractor,
} from "@atlas/api/lib/brain/extract";
import { MAX_BODY_CHARS, type ResolvedExtractionModel } from "@atlas/api/lib/brain/extract-contract";
import {
  materializeSessionEpisode,
  SessionEpisodeNotFoundError,
  sessionSourceId,
  SESSION_SOURCE_ID_PREFIX,
} from "@atlas/api/lib/brain/session-episode";
import { HUMAN_SOURCE } from "@atlas/api/lib/brain/sources";
import {
  reconcileFacts,
  withBrainTransaction,
  type FactCandidate,
  type ReconcileEpisodeRef,
  type ReconcileReport,
  type ReconcileTransactionRunner,
} from "@atlas/api/lib/brain/reconcile";
import { loadWorkspaceVocabulary } from "@atlas/api/lib/brain/vocabulary";
import { getSetting, getSettingAuto, isSaasModeForGuard } from "@atlas/api/lib/settings";

const log = createLogger("brain-suggester");

/** Narrow an unknown thrown value to a log-safe message string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The workspace-scoped opt-in key, exported so the SaaS enumeration below and
 * `settings.ts` stay in lockstep — the same rename guard the promote/decay
 * precedent carries: `__tests__/suggester.test.ts` cross-checks this constant
 * against the real registry, because a rename that broke the enumeration would
 * enroll ZERO workspaces with no other failure signal.
 */
export const SUGGESTER_ENABLED_KEY = "ATLAS_BRAIN_SUGGESTER_ENABLED";

/** Default tick interval: daily, matching the promote/decay trust dial. */
export const DEFAULT_SUGGESTER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * A conversation qualifies only once it has been quiet this long — a live
 * conversation is still being had, and harvesting it mid-thought would spend
 * its one pass (see the module header's one-harvest bound) on half a session.
 */
export const SUGGESTER_IDLE_MS = 60 * 60 * 1000;

/** How far back an opt-in reaches. A start line, not a backlog — see header. */
export const SUGGESTER_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Conversations scanned per workspace per tick — the model-spend bound. Small
 * on purpose: the scarce resource downstream is the review queue (ADR-0039's
 * argument), and a dial someone just turned on should trickle, not flood.
 */
export const CONVERSATIONS_PER_TICK = 5;

/**
 * Transcripts shorter than this skip the model call: below it there is not
 * enough said for an insight to be IN. Skipped conversations stay eligible —
 * they are neither episoded nor ledgered — so one that grows past the floor
 * (within the lookback) gets its scan.
 */
export const MIN_TRANSCRIPT_CHARS = 200;

/** Messages read per conversation — transcript assembly's own bound. */
const TRANSCRIPT_MESSAGE_LIMIT = 200;

/**
 * Whether the suggester is enabled for a workspace. Workspace-scoped and
 * hot-reloaded: it takes effect on the next tick with no restart. Resolution
 * is the standard tier chain (workspace override > platform override > env >
 * default `false`), which is what lets a SELF-HOSTED operator opt in via env
 * with no per-workspace row — on SaaS this resolver is deliberately NOT how
 * enrollment is decided (see {@link LIST_SUGGESTER_ORG_IDS_SQL}).
 *
 * Keep the literal key on the call line — `scripts/check-settings-readers.sh`
 * (R1) matches readers by it.
 */
export function isSuggesterEnabledForWorkspace(orgId?: string | null): boolean {
  const v = getSettingAuto("ATLAS_BRAIN_SUGGESTER_ENABLED", orgId ?? undefined);
  return v === "true" || v === "1";
}

/**
 * Tick interval in milliseconds. Platform-scoped, boot-consumed (the fiber is
 * forked once): platform DB override > env > default 24h.
 */
export function getSuggesterIntervalMs(): number {
  const raw = getSetting("ATLAS_BRAIN_SUGGESTER_INTERVAL_HOURS");
  if (!raw) return DEFAULT_SUGGESTER_INTERVAL_MS;
  const hours = parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_SUGGESTER_INTERVAL_MS;
  return hours * 60 * 60 * 1000;
}

/**
 * The SaaS enrollment read: workspaces with an EXPLICIT workspace-scoped
 * `true` override, and nothing else. Deliberately not `getSettingAuto` per
 * workspace — the tier chain falls through to the platform override and the
 * env var, so a platform-scope `true` would enroll every tenant at once,
 * which is the exact accident lock 1's off-by-default exists to prevent (and
 * the footgun the promote/decay precedent documents). Joined to
 * `organization` so a stale override for a deleted workspace drops.
 *
 * The asymmetry cuts both ways, and the other direction is worth a sentence:
 * platform rows are ignored ENTIRELY on SaaS, so a platform-scoped `false` is
 * not a kill switch either — a workspace's explicit `true` keeps it enrolled.
 * Deliberate, matching the promote/decay enumeration byte for byte: the dial
 * belongs to the workspace in both directions, and an operator emergency stop
 * is the fiber's cadence knob or a deploy, not a tier-chain surprise.
 */
export const LIST_SUGGESTER_ORG_IDS_SQL = `SELECT DISTINCT s.org_id AS org_id
       FROM settings s
       JOIN organization o ON o.id = s.org_id
      WHERE s.key = $1 AND s.value IN ('true', '1') AND s.org_id IS NOT NULL`;

/**
 * The conversations one workspace tick considers: this workspace's live,
 * owned conversations, idle past {@link SUGGESTER_IDLE_MS}, active within
 * {@link SUGGESTER_LOOKBACK_MS}, and not yet harvested — where "harvested"
 * is the existence of the session's tier-3 episode on 0180's dedupe key,
 * whoever minted it (this fiber on an earlier find, or a human propose).
 *
 * `user_id IS NOT NULL` is load-bearing: the owner is the grant seed
 * (lock 3's narrowest defensible audience), and a conversation with no owner
 * has no seed that isn't a silent `[org]` — so it is out of scope rather
 * than widened. Legacy rows with `org_id IS NULL` are likewise never
 * selected, on the session-episode ownership gate's own "narrower is safer"
 * grounds.
 *
 * Freshest-first, so the per-tick cap defers the oldest conversations rather
 * than the ones a workspace is living in (the promote/decay scan's #4582
 * posture).
 */
export const CANDIDATE_CONVERSATIONS_SQL = `SELECT c.id::text AS id, c.user_id AS user_id, c.updated_at AS updated_at
       FROM conversations c
      WHERE c.org_id = $1
        AND c.deleted_at IS NULL
        AND c.user_id IS NOT NULL
        AND c.updated_at <= $2::timestamptz
        AND c.updated_at >= $3::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM brain_episodes e
           WHERE e.workspace_id = $1
             AND e.source = '${HUMAN_SOURCE}'
             AND e.source_id = '${SESSION_SOURCE_ID_PREFIX}' || c.id::text
        )
      ORDER BY c.updated_at DESC
      LIMIT $4`;

/** The transcript read, chronological, bounded. */
export const TRANSCRIPT_SQL = `SELECT role, content
       FROM messages
      WHERE conversation_id = $1::uuid
      ORDER BY created_at ASC
      LIMIT ${TRANSCRIPT_MESSAGE_LIMIT}`;

/**
 * The no-find ledger: conversations scanned to no effect, per process, keyed
 * `<workspace>:<conversation>` → the `updated_at` (ms) the scan saw. A
 * conversation whose `updated_at` has advanced past its entry re-qualifies —
 * new activity is new material. See the module header for the ×R and
 * restart-rescan honesty notes.
 */
const noFindLedger = new Map<string, number>();

/** Test seam, mirroring `_resetBrainExtractionFailures`. */
export function _resetSuggesterLedger(): void {
  noFindLedger.clear();
}

/** Summary of one tick — the sum across every workspace it iterated. */
export interface SuggesterTickResult {
  /** Workspaces the tick iterated (0 when nothing opted in). */
  workspacesConsidered: number;
  /** Workspaces skipped because their model could not be resolved. */
  workspacesModelUnavailable: number;
  /** Conversations a model call was actually spent on. */
  conversationsScanned: number;
  /** Net-new draft facts filed onto the review queue. */
  drafted: number;
  /** Claims that corroborated an existing fact instead of drafting. */
  corroborated: number;
  /** Candidates the reconcile stage refused (malformed model output). */
  blocked: number;
  errors: number;
}

/** Injection seams — defaults are the production collaborators. */
export interface SuggesterDeps {
  /** Defaults to {@link llmFactExtractor}. */
  readonly extract?: FactExtractor;
  /** Defaults to {@link resolveExtractionModel}. */
  readonly resolveModel?: (workspaceId: string) => Promise<ResolvedExtractionModel | null>;
  /** Defaults to `loadWorkspaceVocabulary`. */
  readonly loadVocabulary?: (workspaceId: string) => Promise<ClaimVocabulary>;
  /** Defaults to {@link withBrainTransaction}. */
  readonly withTransaction?: ReconcileTransactionRunner;
  /**
   * Defaults to {@link reconcileFacts} — the ONE fact-writing seam this module
   * touches, injectable so a test can capture what crosses it (`extract.ts`'s
   * own seam shape).
   */
  readonly reconcile?: typeof reconcileFacts;
  /** Test clock. */
  readonly now?: () => Date;
}

/**
 * Resolve the workspaces this tick should process — the enrollment split the
 * module header states: SaaS enumerates explicit workspace overrides
 * ({@link LIST_SUGGESTER_ORG_IDS_SQL}); self-hosted iterates the deployment's
 * own organizations through the tier chain, so the env var opts them in with
 * no per-workspace row to write.
 *
 * A failure here is contained by the caller and enrolls NOBODY — there is no
 * fallback set, because any fallback is an enrollment nobody chose.
 */
async function resolveSuggesterWorkspaces(): Promise<string[]> {
  const { internalQuery } = await import("@atlas/api/lib/db/internal");
  if (isSaasModeForGuard()) {
    const rows = await internalQuery<{ org_id: string }>(LIST_SUGGESTER_ORG_IDS_SQL, [
      SUGGESTER_ENABLED_KEY,
    ]);
    return rows.map((r) => r.org_id);
  }
  const orgs = await internalQuery<{ id: string }>(`SELECT id FROM organization ORDER BY id`);
  const enrolled = orgs.map((r) => r.id).filter((id) => isSuggesterEnabledForWorkspace(id));
  // The tier chain's sharp edge on a MULTI-workspace self-hosted install: a
  // platform override or the env var reaches every workspace that lacks its
  // own row, which is the mass-enrollment shape the SaaS path structurally
  // refuses. Deliberate (the operator IS the tenant on self-hosted, and the
  // env var opting in "the deployment" is the documented degenerate case) —
  // but on more than one workspace it deserves to be said out loud, once per
  // tick, rather than inferred from per-workspace log lines.
  if (enrolled.length > 1) {
    log.warn(
      { workspaces: enrolled.length },
      "Suggester: multiple workspaces are enrolled on this self-hosted deployment — a platform/env ATLAS_BRAIN_SUGGESTER_ENABLED=true reaches every workspace without its own override",
    );
  }
  return enrolled;
}

/** A selected conversation row, narrowed. */
interface CandidateConversationRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  updated_at: Date | string;
}

/**
 * The session episode as the reconcile stage needs it — one builder for both
 * moments it is assembled (pre-model, where only the id is still pending, and
 * post-mint, with the real id and stored grant), so the two cannot drift on
 * the fields they must share.
 */
function sessionEpisodeRef(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly ownerId: string;
  readonly at: Date;
  readonly visibleTo: readonly string[];
}): ReconcileEpisodeRef {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    source: HUMAN_SOURCE,
    sourceId: sessionSourceId(input.conversationId),
    sourceActor: input.ownerId,
    occurredAt: input.at,
    visibleTo: input.visibleTo,
  };
}

/** Per-workspace counters — folded into the tick total (promote/decay's shape). */
interface WorkspaceCounters {
  modelUnavailable: boolean;
  conversationsScanned: number;
  drafted: number;
  corroborated: number;
  blocked: number;
  errors: number;
}

/**
 * One message's readable text, from the stored `jsonb` content. Liberal on
 * purpose: the column has carried both the AI SDK's parts shape and plain
 * strings across versions, and a transcript assembler that returns "" for a
 * shape it doesn't know silently thins the evidence — so every known shape is
 * tried and unknown ones fall through to nothing, never to a throw.
 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return joinParts(content);
  if (content !== null && typeof content === "object") {
    const parts = (content as Record<string, unknown>).parts;
    if (Array.isArray(parts)) return joinParts(parts);
    const text = (content as Record<string, unknown>).text;
    if (typeof text === "string") return text.trim();
  }
  return "";
}

/** The text parts of one parts array, joined — shared by both array shapes. */
function joinParts(parts: readonly unknown[]): string {
  return parts
    .map((part) => partText(part))
    .filter((t) => t !== "")
    .join(" ")
    .trim();
}

/** The text of one AI SDK message part, or "". */
function partText(part: unknown): string {
  if (part === null || typeof part !== "object") return "";
  const record = part as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string" ? record.text.trim() : "";
}

/**
 * Assemble the transcript the model reads: `role: text` lines, chronological,
 * user and assistant turns only (tool traffic is machinery, not testimony),
 * capped at the extraction contract's own body bound so the excerpt step
 * truncates predictably rather than this function and that one disagreeing.
 */
export function assembleTranscript(
  rows: ReadonlyArray<{ role: unknown; content: unknown }>,
): string {
  const lines: string[] = [];
  let chars = 0;
  for (const row of rows) {
    const role = row.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(row.content);
    if (text === "") continue;
    const line = `${role}: ${text}`;
    if (chars + line.length > MAX_BODY_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Run a single suggester tick across all opted-in workspaces. Never throws —
 * errors are logged and surfaced in `result.errors`; a per-workspace failure
 * never aborts the sweep (the promote/decay containment shape).
 */
export async function runSuggesterTick(deps: SuggesterDeps = {}): Promise<SuggesterTickResult> {
  const result: SuggesterTickResult = {
    workspacesConsidered: 0,
    workspacesModelUnavailable: 0,
    conversationsScanned: 0,
    drafted: 0,
    corroborated: 0,
    blocked: 0,
    errors: 0,
  };

  try {
    const { hasInternalDB } = await import("@atlas/api/lib/db/internal");
    if (!hasInternalDB()) {
      log.debug("No internal DB — skipping suggester tick");
      return result;
    }

    const workspaces = await resolveSuggesterWorkspaces();
    if (workspaces.length === 0) {
      log.debug("Suggester tick: no opted-in workspaces");
      return result;
    }

    const now = deps.now ?? (() => new Date());
    pruneLedger(now().getTime());

    // Sequential, not Promise.all — a background sweep whose per-workspace
    // work includes model calls and brain transactions; serializing keeps it
    // from bursting the internal pool alongside live traffic (the
    // promote/decay rationale, with model spend on top).
    for (const workspaceId of workspaces) {
      result.workspacesConsidered++;
      try {
        const ws = await runWorkspaceSuggesterTick(workspaceId, deps, now);
        if (ws.modelUnavailable) result.workspacesModelUnavailable++;
        result.conversationsScanned += ws.conversationsScanned;
        result.drafted += ws.drafted;
        result.corroborated += ws.corroborated;
        result.blocked += ws.blocked;
        result.errors += ws.errors;
      } catch (err) {
        result.errors++;
        log.warn(
          { err: errorMessage(err), workspaceId },
          "Suggester tick failed for workspace — will retry next tick",
        );
      }
    }

    log.info(
      {
        workspacesConsidered: result.workspacesConsidered,
        workspacesModelUnavailable: result.workspacesModelUnavailable,
        conversationsScanned: result.conversationsScanned,
        drafted: result.drafted,
        corroborated: result.corroborated,
        blocked: result.blocked,
        errors: result.errors,
      },
      "Suggester tick complete",
    );
  } catch (err) {
    log.error({ err: errorMessage(err) }, "Suggester tick failed");
    result.errors++;
  }

  return result;
}

/** Drop no-find entries older than the lookback — they can't re-qualify. */
function pruneLedger(nowMs: number): void {
  for (const [key, seenMs] of noFindLedger) {
    if (nowMs - seenMs > SUGGESTER_LOOKBACK_MS) noFindLedger.delete(key);
  }
}

/** One workspace's scan — returns its counters for the caller to fold in. */
async function runWorkspaceSuggesterTick(
  workspaceId: string,
  deps: SuggesterDeps,
  now: () => Date,
): Promise<WorkspaceCounters> {
  const counters: WorkspaceCounters = {
    modelUnavailable: false,
    conversationsScanned: 0,
    drafted: 0,
    corroborated: 0,
    blocked: 0,
    errors: 0,
  };
  const resolveModel = deps.resolveModel ?? resolveExtractionModel;
  const extract = deps.extract ?? llmFactExtractor;
  const loadVocabulary = deps.loadVocabulary ?? loadWorkspaceVocabulary;
  const withTransaction = deps.withTransaction ?? withBrainTransaction;
  const reconcile = deps.reconcile ?? reconcileFacts;
  const { internalQuery } = await import("@atlas/api/lib/db/internal");

  // Model first: `resolveExtractionModel` refuses every ambiguity unattended
  // work must not spend through (EE absent, unbuildable config), and its null
  // leaves this workspace's conversations exactly where they were.
  const resolved = await resolveModel(workspaceId);
  if (resolved === null) {
    counters.modelUnavailable = true;
    log.debug(
      { workspaceId },
      "Suggester: workspace model unavailable — conversations stay unharvested until it resolves",
    );
    return counters;
  }

  const at = now();
  const rows = await internalQuery<CandidateConversationRow>(CANDIDATE_CONVERSATIONS_SQL, [
    workspaceId,
    new Date(at.getTime() - SUGGESTER_IDLE_MS).toISOString(),
    new Date(at.getTime() - SUGGESTER_LOOKBACK_MS).toISOString(),
    CONVERSATIONS_PER_TICK,
  ]);

  for (const row of rows) {
    const conversationId = row.id;
    const ownerId = row.user_id;
    const updatedAtMs = new Date(row.updated_at as string | Date).getTime();
    const ledgerKey = `${workspaceId}:${conversationId}`;
    const seen = noFindLedger.get(ledgerKey);
    // Scanned before, and nothing new has been said since — skip the spend.
    if (seen !== undefined && updatedAtMs <= seen) continue;

    const messages = await internalQuery<Record<string, unknown>>(TRANSCRIPT_SQL, [conversationId]);
    const transcript = assembleTranscript(
      messages.map((m) => ({ role: m.role, content: m.content })),
    );
    // Too thin to hold an insight. Neither episoded nor ledgered — it stays
    // eligible, so a conversation that grows past the floor gets its scan.
    if (transcript.length < MIN_TRANSCRIPT_CHARS) continue;

    // The extractor wants an episode ref, and the episode deliberately does
    // not exist yet (no find, no episode). The ref here feeds the prompt
    // (`source`, `occurredAt`) and the extractor's log lines only —
    // `reconcileFacts` below gets the real ref, with the minted id.
    const preRef = sessionEpisodeRef({
      id: `pending:${conversationId}`,
      workspaceId,
      conversationId,
      ownerId,
      at,
      visibleTo: [`${USER_PREFIX}${ownerId}`],
    });

    let candidates: readonly FactCandidate[];
    try {
      counters.conversationsScanned++;
      candidates = await extract({
        episode: preRef,
        body: transcript,
        model: resolved.model,
        modelId: resolved.modelId,
      });
    } catch (err) {
      // Work-then-stamp: a failed model call marks nothing, so the next tick
      // retries. Bounded by the lookback window and the per-tick cap.
      counters.errors++;
      log.warn(
        { workspaceId, conversationId, err: errorMessage(err) },
        "Suggester: extraction failed for conversation — left unmarked for retry",
      );
      continue;
    }

    if (candidates.length === 0) {
      noFindLedger.set(ledgerKey, updatedAtMs);
      continue;
    }

    // The producer stamp is the review surface's origin discriminator — a
    // reviewer must see the machine, not the extraction contract it borrowed.
    const stamped = candidates.map((c) => ({
      ...c,
      detail: { ...c.detail, extractor: BRAIN_SUGGESTER_PRODUCER },
    }));

    // Freshest snapshot immediately before reconcile (extract.ts's ordering
    // argument). A VocabularyClosureError is workspace-scoped and
    // deterministic, so it would fail every conversation here the same way —
    // charge one error and move to the next workspace instead of paying the
    // model for scans that cannot be filed.
    let vocabulary: ClaimVocabulary;
    try {
      vocabulary = await loadVocabulary(workspaceId);
    } catch (err) {
      counters.errors++;
      log.error(
        { workspaceId, err: errorMessage(err) },
        "Suggester: workspace vocabulary could not be loaded — abandoning this workspace's scan for the tick",
      );
      return counters;
    }

    let report: ReconcileReport;
    try {
      report = await withTransaction(async (tx) => {
        // Lock 3: the session becomes a tier-3 episode HERE — at the moment a
        // claim is actually filed from it, and atomically with the claims, so
        // a crash re-runs the whole find rather than stranding a harvested
        // mark with no facts behind it.
        //
        // The ctx names the conversation OWNER: the session is their record,
        // the ownership gate re-verifies it in-transaction (deleted mid-tick
        // throws, caught below), and the grant seed is their token — the
        // narrowest defensible audience. The MACHINE's part is carried where
        // machine-ness belongs: `producer`, and the detail stamp above.
        const sessionEpisode = await materializeSessionEpisode(tx, {
          workspaceId,
          conversationId,
          ctx: {
            origin: "authenticated",
            workspaceId,
            userId: ownerId,
            role: null,
            audienceIds: [],
          },
          at,
        });
        return reconcile(
          {
            episode: sessionEpisodeRef({
              id: sessionEpisode.episodeId,
              workspaceId,
              conversationId,
              ownerId,
              at,
              visibleTo: sessionEpisode.visibleTo,
            }),
            candidates: stamped,
            vocabulary,
            producer: BRAIN_SUGGESTER_PRODUCER,
            extractedAt: at,
            // The owner's principal, not the machine's — see the module
            // header on why the anti-inflation attribution matters.
            sourcePrincipal: `${USER_PREFIX}${ownerId}`,
            // `resolveEntity` omitted → passthrough resolver, forced for
            // `proposal.ts`'s exact reason: the transaction is already open,
            // and the store-backed resolver would nest a second pool checkout
            // under the held connection. The abstain is honest — a human
            // reviews every suggestion anyway.
          },
          { withTransaction: (fn) => fn(tx), now: () => at },
        );
      });
    } catch (err) {
      if (err instanceof SessionEpisodeNotFoundError) {
        // Deleted (or unclaimed) between selection and write — an ordinary
        // pass, not an incident. Ledgered so the tombstone isn't re-tried.
        noFindLedger.set(ledgerKey, updatedAtMs);
        log.debug(
          { workspaceId, conversationId },
          "Suggester: conversation vanished before its episode could be minted — skipped",
        );
        continue;
      }
      counters.errors++;
      log.warn(
        { workspaceId, conversationId, err: errorMessage(err) },
        "Suggester: filing failed for conversation — left unmarked for retry",
      );
      continue;
    }

    if (report.episodeBlocked !== undefined) {
      // Constructed away — the episode this path mints has an id, a usable
      // grant and a resolved principal — so reaching it means the seam's
      // contract moved. The episode has committed; the mark is durable, and
      // silence would hide a real defect.
      counters.errors++;
      log.error(
        { workspaceId, conversationId, reason: report.episodeBlocked },
        "Suggester: reconcile refused an episode this module constructs away — an Atlas bug, not a content problem",
      );
      continue;
    }

    for (const outcome of report.outcomes) {
      if (outcome.kind === "created") {
        counters.drafted++;
        log.info(
          {
            workspaceId,
            conversationId,
            factId: outcome.factId,
            provisional: outcome.provisional,
            tensionEdges: outcome.tensionEdges,
          },
          "Suggester filed a draft suggestion",
        );
      } else if (outcome.kind === "corroborated") {
        counters.corroborated++;
        log.info(
          {
            workspaceId,
            conversationId,
            factId: outcome.factId,
            evidenceAdded: outcome.evidenceAdded,
          },
          "Suggester corroborated an existing fact",
        );
      } else {
        counters.blocked++;
        log.warn(
          { workspaceId, conversationId, reason: outcome.reason, unkeyed: outcome.unkeyed },
          "Suggester: reconcile refused a suggested claim",
        );
      }
    }
  }
  return counters;
}
