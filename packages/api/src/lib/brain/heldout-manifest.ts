/**
 * The frozen held-out manifest — #5338's acceptance criteria 1 and 2.
 *
 * #5338 measures the extraction cascade against human gate decisions, and the
 * thing it measures against has to be FROZEN before the model under test is
 * trained. This module cuts that frozen set.
 *
 * ## A manifest, not a bundle — and the difference is the whole design
 *
 * The obvious implementation is "run `gate-export` and commit the file". It is
 * forbidden by the file itself: `EVALUATION_ONLY_NOTICE` in
 * {@link ../gate-export.ts} says *"cut it for a named evaluation and destroy it
 * afterwards — do not accumulate bundles"*, and a bundle carries
 * `episode.body` **verbatim, with no redaction and no hashing** — exclusions
 * there are by explicit enumeration, not scrubbing. A frozen, versioned bundle
 * is therefore a durable in-repo file of customer Slack messages, mail bodies
 * and transcript lines, sitting outside `purge-scope.ts` by construction.
 *
 * So what freezes is the **manifest**: `(episode_id, class)` plus the cut date,
 * and nothing else. The set is named, not carried. Bodies are re-read from the
 * live database at measurement time, through `gate-export`'s gates, and are
 * never accumulated anywhere.
 *
 * The consequence is the good kind: a manifest row that no longer resolves is a
 * LOUD purge signal ({@link resolveHeldoutManifest}) rather than a silent
 * staleness. A committed bundle would have quietly kept serving content the
 * tenant had already asked us to delete.
 *
 * ## Why the grant-cargo refusal does NOT apply here
 *
 * `gate-export` refuses a whole workspace when any row carries a `visible_to`
 * token outside the grant grammar, on the rule *"grants travel with the rows or
 * the rows do not leave"*. That rule is about CONTENT leaving. A manifest
 * carries no content — an episode id discloses that an episode exists and which
 * of three decisions a human reached on it, and resolves to nothing at all
 * without database access. There is no audience to state because nothing is
 * being shown to anyone. Re-imposing the refusal here would block a cut on a
 * malformed grant that the cut cannot leak through, so it is deliberately
 * absent rather than forgotten.
 *
 * Region containment {@link checkRegionContainment} IS kept, on the narrower
 * ground that an episode id is still tenant metadata and the workspace's
 * residency label is a thing the manifest should record rather than guess.
 *
 * ## The class is per-EPISODE here, and per-DECISION in `gate-export`
 *
 * A bundle's grain is the `(episode, decision, fact?)` triple: one episode where
 * a reviewer published one claim and retracted another is two rows, and both are
 * signal. A recall denominator is not that shape. #5338 measures *"episodes
 * yielding a published, non-retracted fact"* — the question triage answers is
 * about an EPISODE, because triage runs before extraction and drops episodes,
 * not claims.
 *
 * So the three classes collapse onto the episode with an explicit precedence,
 * stated here rather than discovered later:
 *
 * | Episode holds…                                  | Class      |
 * |-------------------------------------------------|------------|
 * | ≥1 published, non-retracted fact                 | `positive` |
 * | else ≥1 human-retracted fact                     | `rejected` |
 * | else extracted, and no non-archived fact at all  | `negative` |
 * | anything else                                    | *excluded* |
 *
 * `positive` beats `rejected` because the recall question is *"did triage drop
 * an episode that turned out to carry a real fact"*, and an episode carrying one
 * published claim carried a real fact whatever else a reviewer also threw away.
 * The counts of both are kept on every row ({@link HeldoutManifestEntry}) so the
 * collapse is visible and the AC-5 diagnostic (positives+rejected) is computable
 * from the manifest without re-deriving it.
 *
 * **The excluded arm is deliberate and mirrors `gate-export` exactly**: an
 * episode with a live draft is undecided (a queue a reviewer has not reached is
 * not the extractor staying silent), and an episode whose only tombstone carries
 * no correction episode is a migration artifact (`admin-migrate.ts`'s unkeyable
 * imports, #5047) that is neither a rejection nor silence. Both are carried by
 * no arm rather than guessed onto one. An episode still pending extraction falls
 * out for free, since it is neither extracted nor fact-bearing.
 *
 * ## The window is on `ingested_at`, and never on decision time
 *
 * ⚠️ **An approval leaves no timestamp of its own before migration 0214**
 * (`gate-export.ts` — publish stamped nothing per-claim, and `updated_at` also
 * moves on grant widening; only retraction dated itself). `brain_facts.published_at`
 * exists as of #5591 but reads NULL forever on every fact published before it and
 * on every region import. A time window on decision time is therefore not
 * available, and a set windowed on it would silently drift as decisions landed
 * after the cut.
 *
 * The manifest OWNS the label instead: the class is what it was at
 * {@link HeldoutManifest.cutAt}, recorded, and never recomputed in place. A later
 * retraction of a published fact flips the live class and does NOT flip the
 * manifest's — {@link resolveHeldoutManifest} reports that as drift, which is
 * information about the corpus, not a defect in the set.
 *
 * `ingested_at` and not `occurred_at`: `occurred_at` is nullable and
 * source-supplied, so an importer can backdate an episode into a closed window.
 * `ingested_at` is `NOT NULL` and is Atlas's own clock.
 *
 * ## Cut mechanically, so the set has no author
 *
 * `practices.md`'s structural rule — *the actor that builds a check may not be
 * its only judge* — is why this takes a window and returns everything in it.
 * There is no sampling, no `ORDER BY random()`, and no "take the first N": a
 * window that yields more than {@link HELDOUT_EPISODE_MAX} is REFUSED rather
 * than truncated, because a truncated frozen set is sampled by sort order, which
 * is precisely the authorship the criterion removes. That is the opposite of
 * `gate-export`'s cap, which truncates-and-warns — a prefix bundle is still
 * useful to eyeball, and a prefix manifest is a measurement over a population
 * nobody chose.
 *
 * @see docs/agents/practices.md
 */
import { createLogger } from "@atlas/api/lib/logger";
import {
  notAnObservationSql,
  notAWarehouseEpisodeSql,
} from "@atlas/api/lib/brain/observation";
import {
  checkRegionContainment,
  GATE_OCCUPIES_SLOT_PREDICATE,
  GATE_POSITIVE_PREDICATE,
  GATE_REJECTED_PREDICATE,
  type GateDecisionClass,
  type GateExportReader,
} from "@atlas/api/lib/brain/gate-export";

const log = createLogger("brain-heldout-manifest");

/**
 * Manifest format version, bumped when the SHAPE changes in a way a reader
 * cannot ignore. A manifest is read by a harness that may be months newer than
 * the cut, so "unversioned JSON someone will recognize" is not enough.
 */
export const HELDOUT_MANIFEST_VERSION = 1;

/**
 * The header every manifest carries, verbatim, IN THE FILE.
 *
 * The deliberate mirror-image of `EVALUATION_ONLY_NOTICE`: that notice tells a
 * reader to destroy the file, and this one tells them to keep it and not to
 * re-cut it. Both exist because the file outlives the process that wrote it and
 * will be read by someone who never opened this module.
 */
export const HELDOUT_MANIFEST_NOTICE =
  "MANIFEST ONLY — ids and labels, never tenant text. This file NAMES episodes; it does not " +
  "carry them, and it resolves to nothing without access to the region database it was cut " +
  "from. It is the frozen held-out set for issue 5338 (composed-layer triage recall and " +
  "stage-2 gate agreement) and is DELIBERATELY versioned in-repo — which a gate-export bundle " +
  "must never be (see EVALUATION_ONLY_NOTICE in lib/brain/gate-export.ts). It is cut " +
  "mechanically over a time window so that it has no author to be conflicted: do not " +
  "regenerate it to make a number look better, and do not hand-edit a row. Re-cutting is a " +
  "decision that belongs on the issue. Rows are re-resolved against the live database at each " +
  "run; an id that no longer resolves is a purge, not a gap to patch. Its dial evidence attests ONE " +
  "region — the one named by `region` — because a process may only read its own (ADR-0024); a manifest " +
  "cut here says nothing about whether triage ran anywhere else.";

/** A manifest carries the same three classes a bundle does. */
export type HeldoutClass = GateDecisionClass;

/**
 * One named episode.
 *
 * `positiveFacts` / `rejectedFacts` are kept beside the collapsed `class` so the
 * precedence is auditable from the file and so AC 5's ungated diagnostic
 * (positives+rejected recall) is computable without a second cut. They are
 * counts, not ids — nothing here resolves to a claim's text.
 */
export interface HeldoutManifestEntry {
  readonly episodeId: string;
  readonly class: HeldoutClass;
  readonly positiveFacts: number;
  readonly rejectedFacts: number;
}

/** What the cut could establish about the triage dial over the window. */
export interface TriageDialEvidence {
  /**
   * Episodes in the window carrying a `triaged_out_at` mark. Any at all is
   * proof the dial was on while these episodes were drained.
   *
   * ⚠️ Erasable, and that is why it is not the only probe: re-queueing (#5534)
   * sets `triaged_out_at` and `triage_reason` back to NULL, so after a re-queue
   * `brain_episodes` retains no trace that a row was ever triaged.
   */
  readonly markedEpisodes: number;
  /**
   * Extraction-cycle audit rows between the window's start and the cut. The
   * fiber emits one on EVERY terminal path, so a zero here means the audit half
   * of the evidence is UNATTESTED — the rows were pruned by retention, or the
   * fiber never ran — rather than meaning the dial was off.
   */
  readonly cyclesObserved: number;
  /**
   * Of those, how many reported a non-zero `skipped.triaged`. Any at all is
   * proof the dial was on somewhere in this region during the window, and
   * unlike the mark on the row this record survives a re-queue.
   *
   * Fails closed on a metadata value it cannot parse: anything other than the
   * literal `0` (or an absent key, which is every cycle row predating #5336)
   * counts as triage having happened.
   */
  readonly cyclesReportingTriage: number;
  /**
   * The platform-scoped `settings` row for the triage dial as of the cut, or
   * null when no override row exists (the normal state — the dial's default is
   * `false` and its off state writes no row).
   *
   * ⚠️ This is evidence about NOW, not about the window, and it is blind to an
   * env-var-only enable, which writes no settings row at all. It is recorded so
   * a reader can see how close the window came to closing, and refused on
   * because a dial that is on today means the window HAS closed — never as a
   * substitute for the two probes above.
   */
  readonly platformDialSetting: string | null;
  /**
   * The region every probe above was read from — the workspace's own, or null on
   * a single-region or self-hosted deployment.
   *
   * ⚠️ **#5338 AC 2 says "off in every region" and this attests ONE.** That is
   * not a shortcut: ADR-0024 makes the process the region, so no deployment can
   * read another region's `brain_episodes`, `admin_action_log` or `settings` —
   * a cross-region probe would be the residency violation the whole model
   * exists to prevent. The criterion is met by cutting while the dial is off
   * everywhere, which is a fact about the fleet and cannot be established from
   * inside one process. So the manifest states WHAT IT CHECKED rather than
   * implying more: covering every region means running this command in each and
   * keeping each manifest, and the reader can see from this field which one
   * they are holding.
   */
  readonly attestsRegion: string | null;
}

/** The window a cut covers. Half-open: `[from, to)`. */
export interface HeldoutWindow {
  /** The column the window is applied to. Always `ingested_at` — see header. */
  readonly column: "ingested_at";
  readonly from: string;
  readonly to: string;
}

export interface HeldoutManifest {
  readonly version: number;
  readonly notice: string;
  /** The issue this set was cut for. A named evaluation, per the AC. */
  readonly issue: number;
  readonly workspaceId: string;
  readonly region: string | null;
  readonly window: HeldoutWindow;
  /** When the cut ran — the `cut_date` of the AC's triple, factored out of the
   *  rows because it is one value for the whole cut, not a per-row column. */
  readonly cutAt: string;
  readonly dialEvidence: TriageDialEvidence;
  readonly counts: {
    readonly positive: number;
    readonly rejected: number;
    readonly negative: number;
    /** Episodes in the window that landed on no arm — undecided drafts,
     *  unkeyable-import tombstones, the review gate's own correction episodes,
     *  and episodes still pending extraction. */
    readonly excluded: number;
    /**
     * The subset of `excluded` still sitting on the extraction drain at
     * `cutAt` — never extracted, never triaged out.
     *
     * ⚠️ **This is the number that says how frozen the set really is.** An
     * episode still draining is excluded here and would have been a decision in
     * a cut taken a day later, so a non-zero value means the negative arm's size
     * depends on when the cut ran. {@link checkCutWindow} can only require that
     * `to` has elapsed — it cannot know the drain has caught up, because a
     * quarantined or batch-submitted episode may take hours or never arrive, and
     * refusing on any straggler would let one permanently stuck row block every
     * evaluation forever. So the shortfall is MEASURED and carried in the file
     * rather than gated: a manifest whose `stillDraining` is not 0 has to say so
     * wherever its number is reported, exactly as an unattested
     * {@link TriageDialEvidence.cyclesObserved} does.
     */
    readonly stillDraining: number;
  };
  readonly entries: readonly HeldoutManifestEntry[];
}

/**
 * Why a cut refused. Every one is fail-closed: the caller renders the refusal
 * and writes no manifest.
 */
export const HELDOUT_REFUSALS = {
  /** ADR-0024 — this process cannot prove it serves the workspace's region. */
  regionBoundary: "region-boundary",
  /**
   * The triage dial left evidence of having been ON. The set would be
   * pre-filtered by the very thing under test, and its recall number would be
   * measured against a population triage had already edited.
   */
  triageActive: "triage-active",
  /** The window's end is not in the past, so its classes are not settled. */
  windowOpen: "window-open",
  /** `to` is not after `from`. */
  windowInverted: "window-inverted",
  /**
   * A bound would not parse as a timestamp.
   *
   * Its own code rather than sharing `window-inverted`, because the refusal
   * lands in `admin_action_log` and outlives its message: a mistyped `--from`
   * recorded forever as an inverted window is a forensic answer to a question
   * nobody asked.
   */
  windowUnparseable: "window-unparseable",
  /** More episodes than {@link HELDOUT_EPISODE_MAX}. Narrow the window. */
  windowTooLarge: "window-too-large",
} as const;

export type HeldoutRefusalCode = (typeof HELDOUT_REFUSALS)[keyof typeof HELDOUT_REFUSALS];

export interface HeldoutRefusal {
  readonly refusal: HeldoutRefusalCode;
  /** Operator-facing prose: what happened and what to do instead. */
  readonly detail: string;
}

/**
 * Ceiling on episodes in one cut. REFUSED at, never truncated to — see the
 * header. Ten thousand is far past #5338's `n ≥ ~100 positives`, so hitting it
 * means the window was drawn around an archive rather than around an
 * evaluation.
 */
export const HELDOUT_EPISODE_MAX = 10_000;

/**
 * The positives count below which a cut is reported as UNDERPOWERED.
 *
 * A warning and never a refusal. #5338's threshold pair forces `n ≥ ~100`
 * positives by the rule of three, but the issue is equally explicit that prod's
 * n≈37 is a known state — the number is set on a synthetic set and prod is the
 * smoke test. Refusing here would block the smoke test on the very shortage it
 * exists to characterise.
 */
export const HELDOUT_MIN_POSITIVES = 100;

/**
 * Whether a cut is too small for #5338's threshold pair to be decidable on it.
 *
 * One predicate rather than the same comparison in the module and in the
 * operator command: they warn on different channels (structured log, console)
 * and both must move together with {@link HELDOUT_MIN_POSITIVES}, or one of
 * them starts calling a set powered that the other does not.
 */
export function isUnderpowered(counts: { readonly positive: number }): boolean {
  return counts.positive < HELDOUT_MIN_POSITIVES;
}

/** The audit action whose rows carry the per-cycle triage tally. */
export const EXTRACTION_CYCLE_ACTION = "brain.extraction_cycle";

/** The platform settings key for the stage-0 triage dial. */
export const TRIAGE_DIAL_SETTING_KEY = "ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED";

/**
 * The episode-grained classification projection, in ONE place.
 *
 * Both the window cut and the re-resolution read it, so a manifest cut today
 * and re-resolved next month cannot be classified by two subtly different
 * queries. `scope` is the only difference: a time window, or a list of ids.
 *
 * ⚠️ The three sub-selects compose `gate-export`'s exported predicates verbatim
 * rather than re-spelling them. `positives`/`rejected` carry
 * `notAnObservationSql` and the `occupied` EXISTS deliberately does NOT —
 * that is exactly how `gate-export`'s `decided` and `silent` arms differ, and
 * an episode classified `negative` here must be the same episode `gate-export`
 * would call `negative` or the two measurements describe different populations.
 */
function heldoutClassifySql(scope: "window" | "ids"): string {
  const scopeClause =
    scope === "window"
      ? `AND e.ingested_at >= $2 AND e.ingested_at < $3`
      : `AND e.id = ANY($2::uuid[])`;
  const limitClause = scope === "window" ? `LIMIT $4` : ``;
  return `
WITH scoped AS (
  SELECT e.id, e.extracted_at, e.triaged_out_at
    FROM brain_episodes e
   WHERE e.workspace_id = $1
     ${scopeClause}
     AND ${notAWarehouseEpisodeSql("e")}
)
SELECT s.id AS episode_id,
       (s.extracted_at IS NOT NULL) AS extracted,
       -- Still on the drain: no extraction ran and triage did not route it out.
       -- Both halves, even though a passing cut refuses on any triage mark at
       -- all, so this stays correct if that rule ever loosens.
       (s.extracted_at IS NULL AND s.triaged_out_at IS NULL) AS draining,
       (SELECT count(*) FROM brain_facts f
         WHERE f.workspace_id = $1 AND f.source_episode_id = s.id
           AND ${notAnObservationSql("f")}
           AND ${GATE_POSITIVE_PREDICATE})::int AS positives,
       (SELECT count(*) FROM brain_facts f
         WHERE f.workspace_id = $1 AND f.source_episode_id = s.id
           AND ${notAnObservationSql("f")}
           AND ${GATE_REJECTED_PREDICATE})::int AS rejected,
       EXISTS (SELECT 1 FROM brain_facts f
                WHERE f.workspace_id = $1 AND f.source_episode_id = s.id
                  AND ${GATE_OCCUPIES_SLOT_PREDICATE}) AS occupied
  FROM scoped s
 ORDER BY s.id
 ${limitClause}`;
}

/** The window cut. Params: workspace, from, to, limit. */
export const HELDOUT_WINDOW_SQL = heldoutClassifySql("window");

/** The re-resolution. Params: workspace, episode id array. */
export const HELDOUT_RESOLVE_SQL = heldoutClassifySql("ids");

/**
 * Triage evidence over `[windowFrom, cutAt]`, in one round trip.
 *
 * The audit half spans the window's START to the CUT, not the window itself,
 * and the wider span is the point: an episode ingested inside the window can be
 * drained at any time up to the cut, so the dial only has to have been off for
 * the whole of that longer period for the window's episodes to be unfiltered.
 *
 * The action type and the settings key are BOUND (`$5`, `$6`) rather than
 * interpolated. Interpolation is the documented pattern for the composed
 * PREDICATES this module reuses from `gate-export` — a predicate is not a value
 * and cannot be a parameter — but these two are plain values, and a value
 * literal is what a later edit replaces with a variable.
 *
 * `coalesce(…, '0') <> '0'` rather than a cast: `metadata` is `jsonb` written by
 * us, but a cast that throws on unexpected text would turn a malformed audit row
 * into an exception instead of into evidence. Absent (every cycle row predating
 * #5336) reads as no triage, which is true; anything unparseable reads as triage,
 * which fails closed.
 */
export const HELDOUT_DIAL_EVIDENCE_SQL = `
SELECT
  (SELECT count(*) FROM brain_episodes e
    WHERE e.workspace_id = $1
      AND e.ingested_at >= $2 AND e.ingested_at < $3
      AND e.triaged_out_at IS NOT NULL)::int AS marked_episodes,
  (SELECT count(*) FROM admin_action_log a
    WHERE a.action_type = $5
      AND a.timestamp >= $2 AND a.timestamp <= $4)::int AS cycles_observed,
  (SELECT count(*) FROM admin_action_log a
    WHERE a.action_type = $5
      AND a.timestamp >= $2 AND a.timestamp <= $4
      AND coalesce(a.metadata->'skipped'->>'triaged', '0') <> '0')::int AS cycles_reporting_triage,
  (SELECT value FROM settings
    WHERE key = $6 AND org_id IS NULL) AS platform_dial_setting`;

interface RawClassifyRow {
  episode_id: string;
  extracted: boolean;
  draining: boolean;
  positives: number;
  rejected: number;
  occupied: boolean;
}

/**
 * Collapse one episode's fact counts onto a class, or null when it belongs to
 * no arm.
 *
 * Pure, exported, and tested directly: the precedence in the header is the one
 * rule a later reader is most likely to re-derive differently, and a table in a
 * docstring is not a test.
 */
export function classifyHeldoutEpisode(row: {
  readonly extracted: boolean;
  readonly positives: number;
  readonly rejected: number;
  readonly occupied: boolean;
}): HeldoutClass | null {
  if (row.positives > 0) return "positive";
  if (row.rejected > 0) return "rejected";
  // `gate-export`'s `silent` arm, verbatim: extracted, and holding no claim
  // except archived ones. An un-extracted episode is pending, not silent.
  if (row.extracted && !row.occupied) return "negative";
  return null;
}

/**
 * The window is parseable, ordered, and closed.
 *
 * `to` must be strictly in the past — a bound this function CAN check, and the
 * one it is honest about.
 *
 * ⚠️ **It is a necessary condition and not a sufficient one, and the docstring
 * used to overclaim.** `to <= now` does not mean the drain has caught up: an
 * episode ingested a second before `to` may still be un-extracted at `cutAt`,
 * in which case it lands in `excluded` rather than on the arm it is about to
 * reach, and the negative arm's size varies with the `to`→`cutAt` gap. That is
 * authorship by timing, in a set that exists to have none.
 *
 * A drain-lag margin was the obvious fix and is the wrong one: batch extraction
 * is *"an asynchronous turnaround measured in hours"* and a quarantined episode
 * may never arrive, so any constant is either too short to be true or long
 * enough to make one permanently stuck row block every evaluation forever. The
 * shortfall is therefore MEASURED instead — {@link HeldoutManifest.counts}
 * carries `stillDraining`, and a non-zero value travels in the committed file.
 */
export function checkCutWindow(
  window: { readonly from: string; readonly to: string },
  now: Date,
): HeldoutRefusal | null {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return {
      refusal: HELDOUT_REFUSALS.windowUnparseable,
      detail:
        `--from and --to must both be parseable timestamps (ISO 8601, e.g. 2026-06-01T00:00:00Z). ` +
        `Got from=${JSON.stringify(window.from)} to=${JSON.stringify(window.to)}.`,
    };
  }
  if (to <= from) {
    return {
      refusal: HELDOUT_REFUSALS.windowInverted,
      detail: `--to (${window.to}) must be strictly after --from (${window.from}). The window is half-open: [from, to).`,
    };
  }
  if (to > now.getTime()) {
    return {
      refusal: HELDOUT_REFUSALS.windowOpen,
      detail:
        `--to (${window.to}) is not in the past, so the window is still open and the classes in ` +
        `it are not settled — an episode ingested inside it may not have been drained yet, and ` +
        `would be frozen as "not extracted" rather than as a decision. Pick a --to that has ` +
        `already elapsed.`,
    };
  }
  return null;
}

/**
 * The dial-off precondition (#5338 AC 2).
 *
 * Refuses on POSITIVE evidence that triage ran, and on a dial that is on today —
 * never on the absence of evidence, which is reported instead
 * ({@link TriageDialEvidence.cyclesObserved}) and warned about by the caller. A
 * refusal keyed on "I could not find any audit rows" would fire hardest on the
 * deployments with the shortest audit retention, which has nothing to do with
 * whether triage ran.
 */
export function checkTriageDialOff(evidence: TriageDialEvidence): HeldoutRefusal | null {
  if (evidence.markedEpisodes > 0) {
    return {
      refusal: HELDOUT_REFUSALS.triageActive,
      detail:
        `${evidence.markedEpisodes} episode(s) in this window carry a triaged_out_at mark, so ` +
        `stage-0 triage was running while they were drained. A held-out set cut from this window ` +
        `would be pre-filtered by the very layer #5338 measures, and its recall number would be ` +
        `measured against a population triage had already edited. Pick a window that predates the ` +
        `first triage mark.`,
    };
  }
  if (evidence.cyclesReportingTriage > 0) {
    return {
      refusal: HELDOUT_REFUSALS.triageActive,
      detail:
        `${evidence.cyclesReportingTriage} extraction-cycle audit row(s) between the window's ` +
        `start and now report a non-zero skipped.triaged, so the dial was on in this region during ` +
        `the period these episodes were drained — even though no episode still carries a mark ` +
        `(re-queueing clears the mark; the audit row survives it). Pick an earlier window.`,
    };
  }
  if (evidence.platformDialSetting !== null && evidence.platformDialSetting !== "false") {
    return {
      refusal: HELDOUT_REFUSALS.triageActive,
      detail:
        `The platform settings row for ${TRIAGE_DIAL_SETTING_KEY} reads ` +
        `${JSON.stringify(evidence.platformDialSetting)}, so the dial is ON in this region now. ` +
        `#5338's window has closed here: every later cut is pre-filtered by the layer under test. ` +
        `Turn the dial off and re-cut, or cut from a region where it was never enabled.`,
    };
  }
  return null;
}

/**
 * Read the dial evidence for a window.
 *
 * `region` is not queried — it is the caller's statement of which region these
 * probes were read from, and it rides on the result so the manifest records the
 * SCOPE of its own attestation rather than leaving a reader to infer it. See
 * {@link TriageDialEvidence.attestsRegion}.
 */
export async function loadTriageDialEvidence(
  db: GateExportReader,
  options: {
    readonly workspaceId: string;
    readonly from: string;
    readonly to: string;
    readonly cutAt: string;
    readonly region: string | null;
  },
): Promise<TriageDialEvidence> {
  const result = await db.query(HELDOUT_DIAL_EVIDENCE_SQL, [
    options.workspaceId,
    options.from,
    options.to,
    options.cutAt,
    EXTRACTION_CYCLE_ACTION,
    TRIAGE_DIAL_SETTING_KEY,
  ]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    // Four scalar sub-selects with no FROM always return exactly one row, so
    // this is unreachable — and defaulting to zeros would report "no evidence
    // of triage" from a query that never ran, which is the one wrong answer
    // this whole function exists to avoid.
    throw new Error(
      "brain held-out manifest: the dial-evidence aggregate returned no row — the query shape changed",
    );
  }
  return {
    markedEpisodes: Number(row.marked_episodes ?? 0),
    cyclesObserved: Number(row.cycles_observed ?? 0),
    cyclesReportingTriage: Number(row.cycles_reporting_triage ?? 0),
    platformDialSetting:
      typeof row.platform_dial_setting === "string" ? row.platform_dial_setting : null,
    attestsRegion: options.region,
  };
}

export interface HeldoutCutOptions {
  readonly workspaceId: string;
  readonly apiRegion: string | null;
  readonly workspaceRegion: string | null;
  readonly from: string;
  readonly to: string;
  /** Injected so a cut is reproducible under test and the stamp on the file is
   *  the same instant the evidence was read at. */
  readonly now?: Date;
}

export type HeldoutCutResult =
  | { readonly ok: true; readonly manifest: HeldoutManifest }
  | { readonly ok: false; readonly refusal: HeldoutRefusal };

/**
 * Cut a frozen held-out manifest: containment, then the window, then the dial
 * evidence, then the rows.
 *
 * The order is the cheap-and-fatal-first order every refusal path in
 * `gate-export` uses — but it matters more here, because the dial check is the
 * one an operator is most likely to hit and the one whose remedy (pick another
 * window) invalidates everything after it.
 */
export async function cutHeldoutManifest(
  db: GateExportReader,
  options: HeldoutCutOptions,
): Promise<HeldoutCutResult> {
  const now = options.now ?? new Date();
  const cutAt = now.toISOString();

  const containment = checkRegionContainment(options.apiRegion, options.workspaceRegion);
  if (containment) {
    // The DECISION is `gate-export`'s — one containment rule for the whole
    // brain — but the prose is not: its message tells an operator to "re-run
    // the export", and there is no export here to re-run.
    return {
      ok: false,
      refusal: {
        refusal: HELDOUT_REFUSALS.regionBoundary,
        detail:
          `Residency containment failed (ADR-0024): workspace region ` +
          `${JSON.stringify(options.workspaceRegion)}, process region ` +
          `${JSON.stringify(options.apiRegion)}. A manifest carries no tenant text, but an ` +
          `episode id is still tenant metadata and the region it names must be the region that ` +
          `holds it. Re-run the cut against the "${options.workspaceRegion}" deployment, or pass ` +
          `--region ${options.workspaceRegion}.`,
      },
    };
  }

  const windowRefusal = checkCutWindow({ from: options.from, to: options.to }, now);
  if (windowRefusal) return { ok: false, refusal: windowRefusal };

  const dialEvidence = await loadTriageDialEvidence(db, {
    workspaceId: options.workspaceId,
    from: options.from,
    to: options.to,
    cutAt,
    region: options.workspaceRegion,
  });
  const dialRefusal = checkTriageDialOff(dialEvidence);
  if (dialRefusal) return { ok: false, refusal: dialRefusal };

  const result = await db.query(HELDOUT_WINDOW_SQL, [
    options.workspaceId,
    options.from,
    options.to,
    HELDOUT_EPISODE_MAX + 1,
  ]);
  const rows = result.rows as readonly RawClassifyRow[];
  if (rows.length > HELDOUT_EPISODE_MAX) {
    return {
      ok: false,
      refusal: {
        refusal: HELDOUT_REFUSALS.windowTooLarge,
        detail:
          `The window holds more than ${HELDOUT_EPISODE_MAX} episodes. A manifest is REFUSED ` +
          `rather than truncated: a set clipped at a cap is sampled by sort order, which is ` +
          `exactly the authorship a mechanical window exists to remove (#5338 AC 1). Narrow ` +
          `--from/--to and re-run.`,
      },
    };
  }

  const entries: HeldoutManifestEntry[] = [];
  const counts = { positive: 0, rejected: 0, negative: 0, excluded: 0, stillDraining: 0 };
  for (const row of rows) {
    const cls = classifyHeldoutEpisode(row);
    if (cls === null) {
      counts.excluded += 1;
      // A strict subset of `excluded` — an episode on the drain has neither a
      // decision nor a triage mark, so it can never have reached an arm.
      if (row.draining) counts.stillDraining += 1;
      continue;
    }
    counts[cls] += 1;
    entries.push({
      episodeId: row.episode_id,
      class: cls,
      positiveFacts: row.positives,
      rejectedFacts: row.rejected,
    });
  }

  if (isUnderpowered(counts)) {
    log.warn(
      { workspaceId: options.workspaceId, positives: counts.positive, need: HELDOUT_MIN_POSITIVES },
      "held-out manifest is underpowered — the threshold pair needs ~100 positives for its Wilson lower bound",
    );
  }
  if (counts.stillDraining > 0) {
    log.warn(
      { workspaceId: options.workspaceId, stillDraining: counts.stillDraining },
      "held-out manifest cut over a window whose drain has not caught up — the negative arm depends on when the cut ran",
    );
  }

  return {
    ok: true,
    manifest: {
      version: HELDOUT_MANIFEST_VERSION,
      notice: HELDOUT_MANIFEST_NOTICE,
      issue: 5338,
      workspaceId: options.workspaceId,
      region: options.workspaceRegion,
      window: { column: "ingested_at", from: options.from, to: options.to },
      cutAt,
      dialEvidence,
      counts,
      entries,
    },
  };
}

/** One row whose live class no longer matches the frozen one. */
export interface HeldoutClassDrift {
  readonly episodeId: string;
  readonly frozen: HeldoutClass;
  /** Null when the episode still exists but now belongs to no arm — e.g. its
   *  one published fact was retracted by an import artifact rather than by a
   *  reviewer. */
  readonly live: HeldoutClass | null;
}

export interface HeldoutResolution {
  readonly checked: number;
  readonly resolved: number;
  /**
   * Frozen ids the live database no longer holds. **A purge signal, not a
   * gap.** The correct response is to record that the set shrank and say so
   * beside the number, never to re-cut the manifest so the count comes back up.
   */
  readonly missing: readonly string[];
  /**
   * Rows whose live class differs from the frozen one — a reviewer retracted a
   * published claim after the cut, most often. Information about the corpus,
   * NOT a defect: the manifest owns the label as of its `cutAt` precisely
   * because decision time is not queryable (see the header).
   */
  readonly drifted: readonly HeldoutClassDrift[];
}

/**
 * Re-resolve a frozen manifest against the live database.
 *
 * This is the half that makes freezing a manifest safer than freezing a bundle:
 * a bundle would keep serving content that had since been purged, silently,
 * while this reports the shortfall by name every time it runs.
 */
export async function resolveHeldoutManifest(
  db: GateExportReader,
  manifest: HeldoutManifest,
): Promise<HeldoutResolution> {
  const ids = manifest.entries.map((e) => e.episodeId);
  if (ids.length === 0) {
    return { checked: 0, resolved: 0, missing: [], drifted: [] };
  }
  const result = await db.query(HELDOUT_RESOLVE_SQL, [manifest.workspaceId, ids]);
  const live = new Map<string, HeldoutClass | null>();
  for (const row of result.rows as readonly RawClassifyRow[]) {
    live.set(row.episode_id, classifyHeldoutEpisode(row));
  }

  const missing: string[] = [];
  const drifted: HeldoutClassDrift[] = [];
  for (const entry of manifest.entries) {
    if (!live.has(entry.episodeId)) {
      missing.push(entry.episodeId);
      continue;
    }
    const current = live.get(entry.episodeId) ?? null;
    if (current !== entry.class) {
      drifted.push({ episodeId: entry.episodeId, frozen: entry.class, live: current });
    }
  }

  return {
    checked: manifest.entries.length,
    resolved: manifest.entries.length - missing.length,
    missing,
    drifted,
  };
}

/**
 * Parse a manifest read back off disk.
 *
 * Structural, not a schema library, and deliberately strict about the two
 * fields a stale reader would get silently wrong: the version, and the presence
 * of entries. Everything a harness computes rests on those.
 */
export function parseHeldoutManifest(raw: unknown): HeldoutManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("held-out manifest: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== HELDOUT_MANIFEST_VERSION) {
    throw new Error(
      `held-out manifest: version ${JSON.stringify(obj.version)} is not the ` +
        `${HELDOUT_MANIFEST_VERSION} this build reads. A manifest is frozen — upgrade the reader, ` +
        `do not re-cut the set.`,
    );
  }
  if (typeof obj.workspaceId !== "string" || obj.workspaceId === "") {
    throw new Error("held-out manifest: workspaceId is missing");
  }
  if (!Array.isArray(obj.entries)) {
    throw new Error("held-out manifest: entries is missing");
  }
  for (const entry of obj.entries) {
    const e = entry as Record<string, unknown> | null;
    if (
      typeof e?.episodeId !== "string" ||
      (e.class !== "positive" && e.class !== "rejected" && e.class !== "negative")
    ) {
      throw new Error(
        `held-out manifest: malformed entry ${JSON.stringify(entry)} — every row is ` +
          `{ episodeId, class, positiveFacts, rejectedFacts }`,
      );
    }
  }
  return raw as HeldoutManifest;
}
