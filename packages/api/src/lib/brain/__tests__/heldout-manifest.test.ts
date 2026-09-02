/**
 * Unit coverage for the frozen held-out manifest (#5338, acceptance criteria 1
 * and 2).
 *
 * Everything here runs against a literal handle — the module takes the same
 * structural `GateExportReader` `gate-export.ts` does, so no `mock.module()`
 * and no singleton. The questions that need a real database (are the classes
 * actually reachable at the EPISODE grain? does the SQL parse against the real
 * schema? does a purged episode really stop resolving?) live in
 * `heldout-manifest-pg.test.ts`.
 *
 * What this file pins is the SHAPE and the REFUSALS, and one negative claim
 * that matters more than any of them: **no column carrying tenant text can
 * reach a manifest.** That is the property which lets these files be committed
 * where a `gate-export` bundle must not be, so it is asserted against the SQL
 * and against the emitted object, not merely documented.
 */
import { describe, expect, it } from "bun:test";
import {
  HELDOUT_EPISODE_MAX,
  HELDOUT_MANIFEST_NOTICE,
  HELDOUT_MANIFEST_VERSION,
  HELDOUT_MIN_POSITIVES,
  HELDOUT_REFUSALS,
  HELDOUT_WINDOW_SQL,
  HELDOUT_RESOLVE_SQL,
  HELDOUT_DIAL_EVIDENCE_SQL,
  EXTRACTION_CYCLE_ACTION,
  TRIAGE_DIAL_SETTING_KEY,
  checkCutWindow,
  checkTriageDialOff,
  classifyHeldoutEpisode,
  cutHeldoutManifest,
  isUnderpowered,
  loadTriageDialEvidence,
  parseHeldoutManifest,
  resolveHeldoutManifest,
  type HeldoutManifest,
  type TriageDialEvidence,
} from "@atlas/api/lib/brain/heldout-manifest";
import type { GateExportReader } from "@atlas/api/lib/brain/gate-export";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const WINDOW = { from: "2026-06-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" };

/** Dial evidence with nothing to refuse on — the shape of a clean window. */
function cleanEvidence(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    marked_episodes: 0,
    cycles_observed: 42,
    cycles_reporting_triage: 0,
    platform_dial_setting: null,
    ...over,
  };
}

/** One raw classification row in the shape the projection produces. */
function rawRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    episode_id: "11111111-1111-4111-8111-111111111111",
    extracted: true,
    draining: false,
    positives: 1,
    rejected: 0,
    occupied: true,
    ...over,
  };
}

/**
 * A reader that answers the dial-evidence query and the classification query
 * separately, and records every statement it was handed.
 *
 * Dispatching on the SQL rather than on call order is deliberate: the cut's
 * refusal ladder short-circuits, so a positional double would silently hand the
 * window rows to the evidence read the first time someone reorders the checks.
 */
function readerOf(options: {
  readonly evidence?: Record<string, unknown>;
  readonly rows?: readonly unknown[];
}): GateExportReader & { sql: string[]; params: unknown[][] } {
  const sql: string[] = [];
  const params: unknown[][] = [];
  return {
    sql,
    params,
    query: async (text: string, args?: unknown[]) => {
      sql.push(text);
      params.push(args ?? []);
      if (text.includes("cycles_reporting_triage")) {
        return { rows: [options.evidence ?? cleanEvidence()] };
      }
      return { rows: options.rows ?? [] };
    },
  };
}

async function cutOk(options: {
  readonly evidence?: Record<string, unknown>;
  readonly rows?: readonly unknown[];
}): Promise<HeldoutManifest> {
  const cut = await cutHeldoutManifest(readerOf(options), {
    workspaceId: "ws-1",
    apiRegion: null,
    workspaceRegion: null,
    ...WINDOW,
    now: NOW,
  });
  if (!cut.ok) throw new Error(`expected a manifest, got refusal ${cut.refusal.refusal}`);
  return cut.manifest;
}

// ---------------------------------------------------------------------------
// The property that lets these files be committed at all
// ---------------------------------------------------------------------------

describe("held-out manifest — no tenant text can reach it", () => {
  /**
   * ⚠️ The assertion is on what the projection RETURNS, not on what the
   * statement mentions. The predicates composed from `gate-export` read
   * `f.provenance->>'source'` and `f.status` inside their WHERE clauses, and a
   * naive "the SQL must not contain the word provenance" test would fail on
   * those while proving nothing — a column is only a disclosure risk when it
   * reaches the caller.
   *
   * So: the output columns are enumerated, exactly. `body` and `locator` are
   * the episode's evidence; `subject`/`predicate`/`object` are the claim
   * itself; `source_actor`, `provenance` and `visible_to` name people and
   * audiences. A `gate-export` bundle carries all of them and is destroyed
   * afterwards for exactly that reason. A manifest carries five booleans,
   * counts and an id — and adding a sixth output column is what this test is
   * here to make loud.
   */
  const OUTPUT_ALIASES = [
    "episode_id",
    "extracted",
    "draining",
    "positives",
    "rejected",
    "occupied",
  ];

  for (const sqlName of ["window", "resolve"] as const) {
    const sql = sqlName === "window" ? HELDOUT_WINDOW_SQL : HELDOUT_RESOLVE_SQL;
    it(`the ${sqlName} projection returns ids and counts, and nothing else`, () => {
      const aliases = [...sql.matchAll(/\bAS ([a-z_]+)/g)].map((m) => m[1]);
      // `scoped` is the CTE's own name, not an output column.
      expect(aliases.filter((a) => a !== "scoped")).toEqual(OUTPUT_ALIASES);
    });
  }

  it("emits ids, classes and counts — and nothing else per row", async () => {
    const manifest = await cutOk({ rows: [rawRow()] });
    expect(Object.keys(manifest.entries[0] ?? {}).sort()).toEqual([
      "class",
      "episodeId",
      "positiveFacts",
      "rejectedFacts",
    ]);
  });

  it("carries the notice in the MANIFEST, not only in the source", async () => {
    const manifest = await cutOk({});
    expect(manifest.notice).toBe(HELDOUT_MANIFEST_NOTICE);
    expect(manifest.notice).toContain("never tenant text");
    expect(manifest.version).toBe(HELDOUT_MANIFEST_VERSION);
    expect(manifest.issue).toBe(5338);
  });

  it("records the window column so a later reader cannot assume decision time", async () => {
    const manifest = await cutOk({});
    expect(manifest.window).toEqual({ column: "ingested_at", ...WINDOW });
  });
});

// ---------------------------------------------------------------------------
// The episode-grain collapse
// ---------------------------------------------------------------------------

describe("held-out manifest — class precedence at the episode grain", () => {
  it("a published claim wins over a retracted one on the same episode", () => {
    expect(
      classifyHeldoutEpisode({ extracted: true, positives: 1, rejected: 3, occupied: true }),
    ).toBe("positive");
  });

  it("retraction only, and the episode is a rejection", () => {
    expect(
      classifyHeldoutEpisode({ extracted: true, positives: 0, rejected: 1, occupied: true }),
    ).toBe("rejected");
  });

  it("extracted, holding no non-archived claim, is a negative", () => {
    expect(
      classifyHeldoutEpisode({ extracted: true, positives: 0, rejected: 0, occupied: false }),
    ).toBe("negative");
  });

  it("a live draft is UNDECIDED and belongs to no arm", () => {
    // `occupied` is true and nothing is decided: a queue a reviewer has not
    // reached is not the extractor staying silent. Labelling it `negative`
    // would teach the measurement the opposite of what happened.
    expect(
      classifyHeldoutEpisode({ extracted: true, positives: 0, rejected: 0, occupied: true }),
    ).toBeNull();
  });

  it("an un-extracted episode is PENDING, never a negative", () => {
    expect(
      classifyHeldoutEpisode({ extracted: false, positives: 0, rejected: 0, occupied: false }),
    ).toBeNull();
  });

  it("counts the excluded rows rather than dropping them silently", async () => {
    const manifest = await cutOk({
      rows: [
        rawRow({ episode_id: "a", positives: 1, rejected: 0 }),
        rawRow({ episode_id: "b", positives: 0, rejected: 2 }),
        rawRow({ episode_id: "c", positives: 0, rejected: 0, occupied: false }),
        rawRow({ episode_id: "d", positives: 0, rejected: 0, occupied: true }),
        rawRow({
          episode_id: "e",
          extracted: false,
          draining: true,
          positives: 0,
          rejected: 0,
          occupied: false,
        }),
      ],
    });
    expect(manifest.counts).toEqual({
      positive: 1,
      rejected: 1,
      negative: 1,
      excluded: 2,
      // A STRICT SUBSET of `excluded`: "d" is a settled live draft and "e" is
      // still on the drain, and the two are different problems. Separating them
      // is what makes `excluded` readable — one is a reviewer's backlog, the
      // other is a set that is not finished freezing.
      stillDraining: 1,
    });
    expect(manifest.entries.map((e) => e.episodeId)).toEqual(["a", "b", "c"]);
  });

  it("⭐ counts the drain shortfall the window check cannot enforce", async () => {
    // `checkCutWindow` can only require that `to` has elapsed. It cannot know
    // the drain has caught up — batch extraction turns around in hours and a
    // quarantined episode may never arrive — and refusing on any straggler
    // would let one permanently stuck row block every evaluation forever. So
    // the shortfall is MEASURED and travels in the committed file.
    const manifest = await cutOk({
      rows: [
        rawRow({ episode_id: "a", positives: 1 }),
        rawRow({ episode_id: "b", extracted: false, draining: true, positives: 0, occupied: false }),
        rawRow({ episode_id: "c", extracted: false, draining: true, positives: 0, occupied: false }),
      ],
    });
    expect(manifest.counts.stillDraining).toBe(2);
    expect(manifest.counts.stillDraining).toBeLessThanOrEqual(manifest.counts.excluded);
  });

  it("does not count a settled no-arm episode as draining", async () => {
    // A live draft and an unkeyable-import tombstone are excluded and SETTLED.
    // Folding them into the drain shortfall would report a set as unfinished
    // when the only thing outstanding is a human.
    const manifest = await cutOk({
      rows: [rawRow({ episode_id: "d", positives: 0, rejected: 0, occupied: true })],
    });
    expect(manifest.counts).toMatchObject({ excluded: 1, stillDraining: 0 });
  });

  it("keeps both fact counts on the row so the collapse is auditable", async () => {
    const manifest = await cutOk({ rows: [rawRow({ positives: 2, rejected: 5 })] });
    // AC 5's ungated diagnostic (positives+rejected recall) is computable from
    // the file, without a second cut that could see a different corpus.
    expect(manifest.entries[0]).toMatchObject({ positiveFacts: 2, rejectedFacts: 5 });
  });
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

describe("held-out manifest — the underpowered predicate", () => {
  it("is one comparison, shared by the module and the operator command", () => {
    // Both warn, on different channels, and both must move together with
    // HELDOUT_MIN_POSITIVES — or one starts calling a set powered that the
    // other does not.
    expect(isUnderpowered({ positive: HELDOUT_MIN_POSITIVES - 1 })).toBe(true);
    expect(isUnderpowered({ positive: HELDOUT_MIN_POSITIVES })).toBe(false);
    expect(isUnderpowered({ positive: 0 })).toBe(true);
  });
});

describe("held-out manifest — the window is closed and ordered", () => {
  it("refuses a window whose end has not elapsed", () => {
    const refusal = checkCutWindow({ from: WINDOW.from, to: "2026-12-01T00:00:00Z" }, NOW);
    expect(refusal?.refusal).toBe(HELDOUT_REFUSALS.windowOpen);
    expect(refusal?.detail).toContain("not settled");
  });

  it("refuses an inverted or empty window", () => {
    expect(checkCutWindow({ from: WINDOW.to, to: WINDOW.from }, NOW)?.refusal).toBe(
      HELDOUT_REFUSALS.windowInverted,
    );
    expect(checkCutWindow({ from: WINDOW.from, to: WINDOW.from }, NOW)?.refusal).toBe(
      HELDOUT_REFUSALS.windowInverted,
    );
  });

  it("refuses an unparseable bound under its OWN code, not the inverted one", () => {
    // The refusal code lands in `admin_action_log` and outlives its message: a
    // mistyped --from recorded forever as an inverted window is a forensic
    // answer to a question nobody asked.
    expect(checkCutWindow({ from: "last tuesday", to: WINDOW.to }, NOW)?.refusal).toBe(
      HELDOUT_REFUSALS.windowUnparseable,
    );
  });

  it("accepts a closed, ordered window", () => {
    expect(checkCutWindow(WINDOW, NOW)).toBeNull();
  });

  it("REFUSES an oversized window instead of truncating it to a prefix", async () => {
    const rows = Array.from({ length: HELDOUT_EPISODE_MAX + 1 }, (_, i) =>
      rawRow({ episode_id: `ep-${i}` }),
    );
    const cut = await cutHeldoutManifest(readerOf({ rows }), {
      workspaceId: "ws-1",
      apiRegion: null,
      workspaceRegion: null,
      ...WINDOW,
      now: NOW,
    });
    // The deliberate divergence from `gate-export`, which truncates and warns:
    // a prefix bundle is still useful to eyeball, and a prefix manifest is a
    // measurement over a population nobody chose.
    expect(cut.ok).toBe(false);
    if (cut.ok) throw new Error("unreachable");
    expect(cut.refusal.refusal).toBe(HELDOUT_REFUSALS.windowTooLarge);
    expect(cut.refusal.detail).toContain("sampled by sort order");
  });

  it("asks for one row more than the cap, so the cap is detectable", async () => {
    const reader = readerOf({});
    await cutHeldoutManifest(reader, {
      workspaceId: "ws-1",
      apiRegion: null,
      workspaceRegion: null,
      ...WINDOW,
      now: NOW,
    });
    const windowParams = reader.params[reader.sql.findIndex((s) => s.includes("FROM scoped s"))];
    expect(windowParams).toEqual(["ws-1", WINDOW.from, WINDOW.to, HELDOUT_EPISODE_MAX + 1]);
  });
});

// ---------------------------------------------------------------------------
// The triage dial (AC 2)
// ---------------------------------------------------------------------------

function evidence(over: Partial<TriageDialEvidence> = {}): TriageDialEvidence {
  return {
    markedEpisodes: 0,
    cyclesObserved: 42,
    cyclesReportingTriage: 0,
    platformDialSetting: null,
    attestsRegion: "us",
    ...over,
  };
}

describe("held-out manifest — the triage dial must have been off", () => {
  it("refuses on a triaged-out mark inside the window", () => {
    const refusal = checkTriageDialOff(evidence({ markedEpisodes: 3 }));
    expect(refusal?.refusal).toBe(HELDOUT_REFUSALS.triageActive);
    expect(refusal?.detail).toContain("pre-filtered");
  });

  it("refuses on a cycle audit row reporting triage even when no mark survives", () => {
    // The point of the second probe: `#5534`'s re-queue clears `triaged_out_at`
    // and `triage_reason`, so after one there is no query over `brain_episodes`
    // that can establish triage ever ran. The audit row survives it.
    const refusal = checkTriageDialOff(
      evidence({ markedEpisodes: 0, cyclesReportingTriage: 1 }),
    );
    expect(refusal?.refusal).toBe(HELDOUT_REFUSALS.triageActive);
    expect(refusal?.detail).toContain("re-queueing clears the mark");
  });

  it("refuses when the dial is on TODAY — the window has closed", () => {
    const refusal = checkTriageDialOff(evidence({ platformDialSetting: "true" }));
    expect(refusal?.refusal).toBe(HELDOUT_REFUSALS.triageActive);
    expect(refusal?.detail).toContain("window has closed");
  });

  it("does NOT refuse on an explicit off row", () => {
    expect(checkTriageDialOff(evidence({ platformDialSetting: "false" }))).toBeNull();
  });

  it("does NOT refuse on absent evidence — it records it", () => {
    // A refusal keyed on "I found no audit rows" would fire hardest on the
    // deployments with the shortest audit retention, which has nothing to do
    // with whether triage ran. The caller warns; the manifest carries the zero.
    expect(checkTriageDialOff(evidence({ cyclesObserved: 0 }))).toBeNull();
  });

  it("carries the evidence onto the manifest so a reader can judge it later", async () => {
    const manifest = await cutOk({
      evidence: cleanEvidence({ cycles_observed: 0, platform_dial_setting: "false" }),
    });
    expect(manifest.dialEvidence).toEqual({
      markedEpisodes: 0,
      cyclesObserved: 0,
      cyclesReportingTriage: 0,
      platformDialSetting: "false",
      attestsRegion: null,
    });
  });

  it("treats an unparseable skipped.triaged as triage, not as zero", () => {
    // Asserted on the SQL, because the fail-closed direction lives there: the
    // comparison is against the literal '0' rather than a numeric cast, so a
    // malformed audit row counts as evidence instead of throwing.
    expect(HELDOUT_DIAL_EVIDENCE_SQL).toContain(
      `coalesce(a.metadata->'skipped'->>'triaged', '0') <> '0'`,
    );
    expect(HELDOUT_DIAL_EVIDENCE_SQL).not.toContain("::numeric");
  });

  it("BINDS the action type and the settings key rather than interpolating them", () => {
    // Interpolation is the documented pattern for the composed PREDICATES this
    // module reuses from `gate-export` — a predicate cannot be a parameter —
    // but these two are plain values, and a value literal is what a later edit
    // replaces with a variable.
    expect(HELDOUT_DIAL_EVIDENCE_SQL).not.toContain(`'${EXTRACTION_CYCLE_ACTION}'`);
    expect(HELDOUT_DIAL_EVIDENCE_SQL).not.toContain(`'${TRIAGE_DIAL_SETTING_KEY}'`);
    expect(HELDOUT_DIAL_EVIDENCE_SQL).toContain("a.action_type = $5");
    expect(HELDOUT_DIAL_EVIDENCE_SQL).toContain("WHERE key = $6");
  });

  it("reads the dial across the whole region, not one workspace", () => {
    // The extraction fiber is process-wide: a triage drop in ANY workspace is
    // proof the dial was on. Scoping the audit probe to the workspace would
    // miss it.
    const auditHalf = HELDOUT_DIAL_EVIDENCE_SQL.slice(
      HELDOUT_DIAL_EVIDENCE_SQL.indexOf("admin_action_log"),
    );
    expect(auditHalf).not.toContain("workspace_id");
    expect(auditHalf).not.toContain("org_id = ");
  });

  it("reads the platform dial row, never a per-org override", () => {
    expect(HELDOUT_DIAL_EVIDENCE_SQL).toContain("WHERE key = $6 AND org_id IS NULL");
  });

  it("⭐ records the ONE region it attested, because AC 2 asks about every region", async () => {
    // ADR-0024 makes the process the region: no deployment can read another
    // region's brain_episodes, admin_action_log or settings, so "off in every
    // region" cannot be established from inside one process. The manifest
    // therefore states WHAT IT CHECKED rather than implying more, and a reader
    // can see from this field which region's manifest they are holding.
    const cut = await cutHeldoutManifest(readerOf({}), {
      workspaceId: "ws-1",
      apiRegion: "us",
      workspaceRegion: "us",
      ...WINDOW,
      now: NOW,
    });
    if (!cut.ok) throw new Error("expected a manifest");
    expect(cut.manifest.dialEvidence.attestsRegion).toBe("us");
    expect(cut.manifest.notice).toContain("attests ONE");
  });

  it("passes the bound values as params 5 and 6", async () => {
    const reader = readerOf({});
    await cutHeldoutManifest(reader, {
      workspaceId: "ws-1",
      apiRegion: null,
      workspaceRegion: null,
      ...WINDOW,
      now: NOW,
    });
    const params = reader.params[reader.sql.findIndex((s) => s.includes("cycles_reporting_triage"))];
    expect(params?.slice(4)).toEqual([EXTRACTION_CYCLE_ACTION, TRIAGE_DIAL_SETTING_KEY]);
  });

  it("spans window-start to CUT time, because drain time is not ingest time", async () => {
    const reader = readerOf({});
    await cutHeldoutManifest(reader, {
      workspaceId: "ws-1",
      apiRegion: null,
      workspaceRegion: null,
      ...WINDOW,
      now: NOW,
    });
    const evidenceParams =
      reader.params[reader.sql.findIndex((s) => s.includes("cycles_reporting_triage"))];
    // An episode ingested inside the window can be drained at any time up to
    // the cut, so the dial has to have been off for the whole longer period.
    expect(evidenceParams?.slice(0, 4)).toEqual([
      "ws-1",
      WINDOW.from,
      WINDOW.to,
      NOW.toISOString(),
    ]);
  });

  it("throws rather than defaulting to zeros when the aggregate returns no row", async () => {
    const reader: GateExportReader = { query: async () => ({ rows: [] }) };
    await expect(
      loadTriageDialEvidence(reader, {
        workspaceId: "ws-1",
        ...WINDOW,
        cutAt: NOW.toISOString(),
        region: "us",
      }),
    ).rejects.toThrow(/query shape changed/);
  });
});

// ---------------------------------------------------------------------------
// Residency
// ---------------------------------------------------------------------------

describe("held-out manifest — residency containment", () => {
  it("refuses when the process cannot prove it serves the workspace's region", async () => {
    const cut = await cutHeldoutManifest(readerOf({}), {
      workspaceId: "ws-1",
      apiRegion: null,
      workspaceRegion: "eu",
      ...WINDOW,
      now: NOW,
    });
    expect(cut.ok).toBe(false);
    if (cut.ok) throw new Error("unreachable");
    expect(cut.refusal.refusal).toBe(HELDOUT_REFUSALS.regionBoundary);
    // The DECISION is `gate-export`'s, the PROSE is not: its message tells the
    // operator to "re-run the export", and there is no export here to re-run.
    expect(cut.refusal.detail).not.toContain("re-run the export");
    expect(cut.refusal.detail).toContain("--region eu");
  });

  it("refuses before it reads anything", async () => {
    const reader = readerOf({});
    await cutHeldoutManifest(reader, {
      workspaceId: "ws-1",
      apiRegion: "us",
      workspaceRegion: "eu",
      ...WINDOW,
      now: NOW,
    });
    expect(reader.sql).toHaveLength(0);
  });

  it("records the workspace's region on the manifest", async () => {
    const cut = await cutHeldoutManifest(readerOf({}), {
      workspaceId: "ws-1",
      apiRegion: "us",
      workspaceRegion: "us",
      ...WINDOW,
      now: NOW,
    });
    if (!cut.ok) throw new Error("expected a manifest");
    expect(cut.manifest.region).toBe("us");
  });
});

// ---------------------------------------------------------------------------
// Re-resolution — what makes freezing a manifest safer than freezing a bundle
// ---------------------------------------------------------------------------

describe("held-out manifest — re-resolution against the live database", () => {
  const frozen: HeldoutManifest = {
    version: HELDOUT_MANIFEST_VERSION,
    notice: HELDOUT_MANIFEST_NOTICE,
    issue: 5338,
    workspaceId: "ws-1",
    region: "us",
    window: { column: "ingested_at", ...WINDOW },
    cutAt: NOW.toISOString(),
    dialEvidence: evidence(),
    counts: { positive: 2, rejected: 1, negative: 0, excluded: 0, stillDraining: 0 },
    entries: [
      { episodeId: "a", class: "positive", positiveFacts: 1, rejectedFacts: 0 },
      { episodeId: "b", class: "positive", positiveFacts: 1, rejectedFacts: 0 },
      { episodeId: "c", class: "rejected", positiveFacts: 0, rejectedFacts: 1 },
    ],
  };

  it("names the ids that no longer resolve — a purge signal, not a gap", async () => {
    const reader = readerOf({
      rows: [
        rawRow({ episode_id: "a", positives: 1, rejected: 0 }),
        rawRow({ episode_id: "c", positives: 0, rejected: 1, occupied: true }),
      ],
    });
    const resolution = await resolveHeldoutManifest(reader, frozen);
    expect(resolution).toMatchObject({ checked: 3, resolved: 2, missing: ["b"] });
    expect(resolution.drifted).toEqual([]);
  });

  it("reports class drift without rewriting the frozen label", async () => {
    // A reviewer retracted `a` after the cut. The manifest owns the label as of
    // its `cutAt` precisely because decision time is not queryable — so this is
    // information about the corpus, not a defect in the set.
    const reader = readerOf({
      rows: [
        rawRow({ episode_id: "a", positives: 0, rejected: 1, occupied: true }),
        rawRow({ episode_id: "b", positives: 1, rejected: 0 }),
        rawRow({ episode_id: "c", positives: 0, rejected: 1, occupied: true }),
      ],
    });
    const resolution = await resolveHeldoutManifest(reader, frozen);
    expect(resolution.drifted).toEqual([{ episodeId: "a", frozen: "positive", live: "rejected" }]);
    expect(frozen.entries[0]?.class).toBe("positive");
  });

  it("reports an episode that now belongs to no arm as drift to null", async () => {
    const reader = readerOf({
      rows: [
        rawRow({ episode_id: "a", positives: 0, rejected: 0, occupied: true }),
        rawRow({ episode_id: "b", positives: 1 }),
        rawRow({ episode_id: "c", positives: 0, rejected: 1 }),
      ],
    });
    const resolution = await resolveHeldoutManifest(reader, frozen);
    expect(resolution.drifted).toEqual([{ episodeId: "a", frozen: "positive", live: null }]);
  });

  it("does not query at all for an empty manifest", async () => {
    const reader = readerOf({});
    const resolution = await resolveHeldoutManifest(reader, { ...frozen, entries: [] });
    expect(reader.sql).toHaveLength(0);
    expect(resolution).toEqual({ checked: 0, resolved: 0, missing: [], drifted: [] });
  });
});

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

describe("held-out manifest — parsing one off disk", () => {
  const good = {
    version: HELDOUT_MANIFEST_VERSION,
    workspaceId: "ws-1",
    entries: [{ episodeId: "a", class: "positive", positiveFacts: 1, rejectedFacts: 0 }],
  };

  it("accepts a well-formed manifest", () => {
    expect(parseHeldoutManifest(good).workspaceId).toBe("ws-1");
  });

  it("refuses a version this build does not read, and says not to re-cut", () => {
    expect(() => parseHeldoutManifest({ ...good, version: 99 })).toThrow(
      /upgrade the reader, do not re-cut/,
    );
  });

  it("refuses a manifest with no entries array", () => {
    expect(() => parseHeldoutManifest({ ...good, entries: undefined })).toThrow(/entries is missing/);
  });

  it("refuses a row whose class is outside the three", () => {
    expect(() =>
      parseHeldoutManifest({ ...good, entries: [{ episodeId: "a", class: "maybe" }] }),
    ).toThrow(/malformed entry/);
  });

  it("refuses anything that is not an object", () => {
    expect(() => parseHeldoutManifest("[]")).toThrow(/expected a JSON object/);
    expect(() => parseHeldoutManifest(null)).toThrow(/expected a JSON object/);
  });
});
