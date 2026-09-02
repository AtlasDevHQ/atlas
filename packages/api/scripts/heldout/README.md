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
the file you handed it.

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

The dial is also blind here in one direction worth naming: an **env-var-only**
enable (`ATLAS_BRAIN_EXTRACTION_TRIAGE_ENABLED=true` with no settings override
row) writes nothing this query can see. That is why the two window probes are the
primary evidence and the settings row is only corroboration.
