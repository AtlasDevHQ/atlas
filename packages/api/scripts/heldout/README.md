# Held-out manifests (#5338)

This directory is the in-repo home of the **frozen held-out sets** the extraction
cascade is measured against. Each file is one cut, produced by:

```bash
ATLAS_HELDOUT_OK=1 atlas-operator ops heldout-manifest \
  --region us --workspace <orgId> \
  --from 2026-06-01T00:00:00Z --to 2026-09-01T00:00:00Z \
  --confirm -o packages/api/scripts/heldout/us-2026-09.json
```

Drop `ATLAS_HELDOUT_OK=1` and `--confirm` for a DRY RUN: the query runs, the
counts and the dial evidence printed are exact, and no file is written.

## What a manifest is, and what it is not

A manifest **names** episodes: `(episodeId, class)` plus the cut date, the
window, and the evidence that stage-0 triage was off while those episodes were
drained. It carries **no episode body, no claim text, and no grant** — it
resolves to nothing at all without access to the region database it was cut
from.

That is the whole reason these files may live in git while a `gate-export`
bundle may not. `EVALUATION_ONLY_NOTICE` (`packages/api/src/lib/brain/gate-export.ts`)
says of a bundle: *"cut it for a named evaluation and destroy it afterwards — do
not accumulate bundles"*, and a bundle carries `episode.body` verbatim with no
redaction. Committing one would put customer Slack messages, mail bodies and
transcript lines into a durable file outside `purge-scope.ts`. Naming the
episodes instead keeps the set reproducible and keeps the content under every
mechanism the platform has for reaching it.

The consequence is the good kind: an id that no longer resolves is a **loud purge
signal**, not silent staleness.

```bash
atlas-operator ops heldout-manifest --region us --verify packages/api/scripts/heldout/us-2026-09.json
```

`--verify` is ungated — it writes nothing, and everything it prints is already in
the file you handed it. ⚠️ **It does still refuse to cross a region boundary**,
and that refusal is load-bearing rather than tidy: point a `us` manifest at
`--region eu` and every row fails to resolve, so the purge alarm this whole
design rests on would fire at full volume on a flag typo.

## The rules that make a frozen set worth anything

These come from #5338 and `docs/agents/practices.md`, not from taste.

1. **Do not re-cut a set to make a number look better.** The window is
   mechanical, so the set has no author to be conflicted; re-cutting it hands
   that authorship back. If a set genuinely needs replacing, that is a decision
   recorded on the issue, and the new file lands **beside** this one rather than
   over it.
2. **Do not hand-edit a row.** A manifest is generated. An edited row is a
   labelled example whose label nobody can trace.
3. **The measurement budget is real.** Candidates are declared before the cut,
   each is measured **once**, and needing more than three attempts means cutting
   a *second* set — not re-measuring against this one until it cooperates.
   Retune-and-remeasure erodes a held-out set exactly as surely as regenerating
   it, one reasonable-seeming step at a time.
4. **A shrinking denominator is reported, not repaired.** When `--verify` says
   rows no longer resolve, that number goes beside the result.
5. **Class drift is information.** A reviewer retracting a published claim after
   the cut flips the live class and does *not* flip the frozen one — the manifest
   owns the label as of its `cutAt`, because decision time is not queryable for
   any fact published before migration 0214.

## Why the window is what it is

- **On `ingested_at`**, half-open `[from, to)`. `occurred_at` is nullable and
  source-supplied, so an importer can backdate an episode into a closed window.
  Decision time is not available at all for the historical majority.
- **`to` must already have elapsed.** An episode ingested inside an open window
  may not have been drained yet, so its class is not settled.
- **The cut is refused, never truncated,** when the window holds more than
  `HELDOUT_EPISODE_MAX` episodes. A set clipped at a cap is sampled by sort
  order, which is the authorship a mechanical window exists to remove.

⚠️ **`to` having elapsed is a necessary condition, not a sufficient one, and the
manifest says so in a number.** It does not mean the drain has caught up: an
episode ingested a second before `to` may still be un-extracted at `cutAt`, in
which case it lands in `excluded` rather than on the arm it is about to reach —
so the negative arm's size depends on when the cut ran. A drain-lag margin was
the obvious fix and is the wrong one (batch extraction turns around in *hours*
and a quarantined episode may never arrive, so any constant is either too short
to be true or long enough to let one stuck row block every evaluation forever).
The shortfall is therefore **measured**: `counts.stillDraining` is a strict
subset of `counts.excluded`, and a manifest whose value is not `0` has to say so
wherever its number is reported — exactly as an unattested `cyclesObserved: 0`
does.

## The triage-dial precondition

`gate-export`'s negative arm requires `extracted_at IS NOT NULL`, and triage runs
*before* extraction — so a triaged-out episode never appears in any bundle at
all. Recall therefore has to be measured **counterfactually**, by replaying
triage over a set cut from a window in which the dial was off. The cutter
establishes that from three signals and refuses on any of them:

| Signal | Survives a re-queue? |
|---|---|
| A `triaged_out_at` mark on an episode in the window | ❌ — `#5534`'s re-queue clears both triage columns |
| An extraction-cycle audit row reporting a non-zero `skipped.triaged` | ✅ |
| The platform `settings` row for the dial reading anything but `false` today | n/a — this says the window has *closed*, not that it was open |

⚠️ When **no** extraction-cycle audit rows exist between the window's start and
the cut, the audit half is **unattested** — pruned by retention, or the fiber
never ran. The cutter records that on the manifest (`dialEvidence.cyclesObserved`)
and warns loudly rather than refusing: a refusal keyed on missing audit rows
would fire hardest on the deployments with the shortest retention, which has
nothing to do with whether triage ran. Say so wherever such a manifest's number
is reported.

⚠️ **The attestation covers ONE region — the one in `dialEvidence.attestsRegion`.**
#5338 AC 2 asks for a window in which the dial was off *in every region*, and no
process can establish that: ADR-0024 makes the process the region, so no
deployment can read another region's `brain_episodes`, `admin_action_log` or
`settings`, and a cross-region probe would be the residency violation the whole
model exists to prevent. So the manifest states **what it checked** rather than
implying more. Covering the fleet means running this command in each region and
keeping each manifest; the console says `<region> ONLY` on every run so a
one-region pass is not read as a fleet-wide one. (`eu` and `apac` are parked, so
their extraction fibers do not run at all — but the manifest carries no evidence
of that either, and shouldn't pretend to.)

The dial is also blind here in one direction worth naming: an **env-var-only**
enable (`ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED=true` with no settings override
row) writes nothing this query can see. That is why the two window probes are the
primary evidence and the settings row is only corroboration.

---

# The harness (#5338 AC 3, 4, 5, 7, 9, 10)

```bash
bun scripts/measure-triage.ts --fixture scripts/heldout/fixtures/smoke.json
```

No database, no model, no network. The arithmetic is
`src/lib/brain/triage-measure.ts`; what a measurement is *allowed to claim* is
`src/lib/brain/triage-measure-record.ts`. Exit codes: `0` reported, `1`
threshold failed, `2` refused (a smoke fixture cannot gate), `3` bad input.

## Why the baseline is worth measuring before stage 1 exists

The yield half of the threshold is **relative** — the composed layer must drop
strictly more than stage 0 alone at no worse recall — so stage 0's own number is
a *prerequisite* of the comparison, not a by-product. Measuring it now means
#5336's stage 1 lands against a figure already on the record rather than one
invented alongside it, which is `docs/agents/practices.md`'s structural rule
doing real work: **the actor that builds a check may not be its only judge.**

With no stage-1 adapter present the harness reports the baseline and stops. It
deliberately does **not** compose a no-op stage 1 and print the resulting
failure as a verdict — a layer that ties the baseline fails the yield half by
construction, and reporting that would dress an absent result as a measured one.

## ⚠️ The acceptance criteria understate the set size

#5338 says *"by the rule of three, zero observed misses clears a 95% lower bound
only at n ≥ 60, and tolerating one miss needs n ≥ ~100"*. The rule of three
approximates an **exact** bound; the criterion is written against a **Wilson**
bound, which is stricter. Measured (`triage-measure.test.ts` derives these rather
than asserting literals):

| observed misses | n the issue states | n Wilson actually needs | LCB at the issue's n |
|---|---|---|---|
| 0 | 60 | **73** | 0.9398 ✗ |
| 1 | ~100 | **110** | 0.9455 ✗ |
| 2 | — | 142 | — |

At a perfect score Wilson reduces to `n / (n + z²)`, so the floor is
`z²·0.95/0.05 ≈ 73`. **Cut for 110 positives, not 100.**

## Fixtures: `smoke` vs `evaluation`

A fixture declares its `role`, and the distinction is enforced rather than
advisory:

- **`smoke`** proves the harness runs. `assertCanGate` **refuses** to produce a
  threshold verdict from one. `fixtures/smoke.json` is authored by hand
  alongside the harness — which is exactly the conflict the structural rule
  exists to prevent — so it may never be promoted by editing its `role`.
- **`evaluation`** must carry `provenance { labelsFrom, cutAt }`. A fixture that
  cannot say where its labels came from is a fixture whose author is
  unrecorded.

The scoring set is a frozen manifest cut by `atlas-operator ops
heldout-manifest`, or a licence-checked public corpus from
`.claude/research/extractor-corpus-acquisition.md`. **Neither exists yet** — the
instrument is built and the data is named, which is the honest deliverable when
one is ready and the other is not.

## The measurement budget (AC 9)

`MEASUREMENT_BUDGET.maxAttemptsPerSet = 3`, enforced by `checkMeasurementBudget`
over the recorded runs.

Candidates are declared **before** the cut, each is measured **once**, and
needing more than three attempts means cutting a **second set** — not measuring
this one again until it cooperates. The budget counts per *set*, so a second
candidate spends the same allowance: it is a property of the set's independence,
not of any one candidate's patience. `verifyRecordedVerdict` recomputes each
record's verdict from its own numbers, so a hand-edited `"passed": true` is
caught rather than trusted.

## Where a failing result goes (AC 10)

A failure is an acceptable outcome and has a home before it happens:

- **Recall fails** → keep the cascade, and never default it on. The gate is
  `checkTriageDefaultGate`, which turns red if `ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED`'s
  registry default becomes `true` while the latest recorded run did not clear the
  pair. It is a *test*, not a boot check — "enabled by default" is a code change,
  and a boot-time check would fail closed in a region that never ran the harness.
- **Recall *and* yield fail** → abandon the cascade and record it. The entry goes
  in `.claude/research/ROADMAP.md`, where measured findings live, and #5334
  closes as answered rather than as delivered.

Neither outcome is a reason to re-cut the set.
