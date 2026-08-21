# The Company Atlas — completion plan

Status: draft (2026-08-21). **Perishable, like the PRD's snapshot.**

The destination is [`company-atlas.md`](./company-atlas.md): eight conditions that hold **for a real customer, in production, with no engineer present.** This document is the *path* to them.

## What this document is, and is not

It holds the **path** — lanes, their order, and the argument for that order. It deliberately does **not** hold status.

- **Status lives in `.claude/research/ROADMAP.md` and in GitHub.** Every row below points at an issue number or is marked **UNFILED**. When a lane's issues close, the lane closes; nothing here needs editing to stay true.
- This exists because neither existing doc holds the path. The PRD states the destination and hands the cut back to [ADR-0036](../adr/0036-atlas-as-company-brain.md) §T10 — and **§T10's cut is now stale**: retrieval depth left it, M6 and M7 were never scheduled, and two milestones were added that carry no M-number.
- A row marked **UNFILED** is the only claim here that decays badly. Those are the ones to file first.
- **There are no dates in this document, and that is deliberate.** Nothing here is scheduled against a calendar. The order below is driven by dependency and by risk already live in production — never by a deadline. Where a constraint appears (Lane D), it is a **sequencing** constraint: this must happen before that, whenever that happens.

## Where the arc actually is

Five of seven cut milestones are closed (#91–#95). The two open milestones (#98, #99) were **not in the cut** — both exist because prod reads found defects that green tests could not. The one *unbuilt* finish condition (6) shipped 2026-08-20.

**The mechanism is nearly done and the proof is barely started.** Four conditions are unproven rather than unbuilt, and nothing tracks any of them. That asymmetry is what this plan is ordered around.

---

## Lane A — Stop serving wrong data

**Milestone [#99](https://github.com/AtlasDevHQ/atlas/milestone/99) — The Producer Stops Publishing · 8 issues, all filed**

First because it is the only lane with **known-wrong rows served on prod today**. [ADR-0042](../adr/0042-warehouse-material-is-an-observation-never-a-published-belief.md): warehouse material is an observation, never a published belief.

| Order | Issue | Note |
|---|---|---|
| 1 | [#5340](https://github.com/AtlasDevHQ/atlas/issues/5340) | The shared observation predicate. Unblocked. Its whole value is landing **before** the three copies it prevents get written |
| 1 | [#5329](https://github.com/AtlasDevHQ/atlas/issues/5329) | Producer reads churned rows. Unblocked, independent of the publish/serve arc |
| 2 | [#5341](https://github.com/AtlasDevHQ/atlas/issues/5341), [#5342](https://github.com/AtlasDevHQ/atlas/issues/5342), [#5332](https://github.com/AtlasDevHQ/atlas/issues/5332) | All consume #5340 |
| 2 | [#5344](https://github.com/AtlasDevHQ/atlas/issues/5344) | Consumes #5329 |
| 3 | [#5331](https://github.com/AtlasDevHQ/atlas/issues/5331) | Retract the two stranded prod rows. Gated on #5342 so the population is closed first |

**Closes on:** [#5345](https://github.com/AtlasDevHQ/atlas/issues/5345) — five statements verified against prod in all three regions, per #5216's precedent. **Not on merge.**

⚠️ #5329 carries a live warning that it should gate `ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED`. The cadence is off. Turning it on before #5329/#5344 land puts a churned-row producer on a clock, unattended.

---

## Lane B — Prove the trust claim

**Filed 2026-08-21 — four issues ([#5374](https://github.com/AtlasDevHQ/atlas/issues/5374), [#5375](https://github.com/AtlasDevHQ/atlas/issues/5375), [#5376](https://github.com/AtlasDevHQ/atlas/issues/5376), [#5377](https://github.com/AtlasDevHQ/atlas/issues/5377)). Still no milestone, deliberately.**

This was the largest gap in the plan and the one with nothing pointing at it. ADR-0036's T1 finding is that **the adoption gap is trust, not benchmark score**. Conditions 1, 3, 7 and 8 are the trust demonstrations, and all four are *built but never demonstrated*.

| Condition | PRD status | What would close it | Tracked by |
|---|---|---|---|
| 1 — Cold start works | Not yet | A customer connects one source Monday; by Friday a colleague gets an approved-claim answer, **no engineer involved** | [#5374](https://github.com/AtlasDevHQ/atlas/issues/5374) |
| 3 — Tiers unmistakable | Partly | Show an untrained person two answers; they distinguish data from approved-message without being taught the vocabulary | [#5375](https://github.com/AtlasDevHQ/atlas/issues/5375) |
| 7 — Revocation is real | Yes, least-demonstrated | Someone loses source access; within one sync cycle their scoped claims stop being visible, no manual step | [#5376](https://github.com/AtlasDevHQ/atlas/issues/5376) |
| 8 — Self-hoster has all of it | By construction | Conditions 1–7 re-run on a self-hosted install, no license key, no Atlas account | [#5377](https://github.com/AtlasDevHQ/atlas/issues/5377) — blocked by the three above |

The PRD calls **1 and 3 "cheap to test"** and says the milestone that held them ([#96](https://github.com/AtlasDevHQ/atlas/milestone/96)) did **not** close them — *"the next milestone that claims them has to say so explicitly rather than inherit them from this line."* No milestone has.

**Why this lane runs early, not last.** Every other lane is mechanism. If a cold start fails for reasons no ticket predicted, that finding should arrive before M6 builds on top of it — and conditions 1 and 3 are cheap enough that deferring them buys nothing.

⚠️ These are **demonstrations, not builds.** Each one either holds or produces a defect list. A lane that cannot fail is not worth running, so each must be run against a real workspace with the engineer's hands off. Every issue carries the same closing rule: **a failed condition still closes the issue, on the record** — a held-open issue is not how a failed demonstration is tracked, and fixes are filed rather than folded in flight.

**No milestone, and that is the correct default rather than a punt.** The ROADMAP's rule is that *"the next milestone that claims them has to say so explicitly rather than inherit them from this line."* Filing them unmilestoned leaves that claim available to be made deliberately. [#5376](https://github.com/AtlasDevHQ/atlas/issues/5376) is the one to run first if only one gets run: it is the only finish condition whose failure mode is a **disclosure** rather than a disappointment.

---

## Lane C — Protect the gate before breadth

**Milestone [#98](https://github.com/AtlasDevHQ/atlas/milestone/98) — The Extraction Cascade · 10 issues, all filed**

Cost and volume control ahead of M3 source breadth widening. [#5334](https://github.com/AtlasDevHQ/atlas/issues/5334) is the anchor and is blocked by everything else. Its grill, [#5343](https://github.com/AtlasDevHQ/atlas/issues/5343), is the only open `wayfinder:map`.

| Order | Issue | Note |
|---|---|---|
| 1 | [#5339](https://github.com/AtlasDevHQ/atlas/issues/5339) | The two training prohibitions. Docs only, cheapest item in the arc |
| 1 | [#5352](https://github.com/AtlasDevHQ/atlas/issues/5352) + [#5353](https://github.com/AtlasDevHQ/atlas/issues/5353) | Same call site — do together. ⚠️ The issues' *"~99% of the cost saving"* claim did not survive contact — see below |
| 1 | [#5335](https://github.com/AtlasDevHQ/atlas/issues/5335) | Gate-decision export. Unblocked, and supplies #5338's held-out set |
| 1 | [#5354](https://github.com/AtlasDevHQ/atlas/issues/5354) | Quoted-reply stripping. Unblocked; payoff arrives with M3 email volume |
| 2 | [#5336](https://github.com/AtlasDevHQ/atlas/issues/5336) | Stage 0 unblocked; stage 1 waits on #5335. **The first item in this lane that is a GATE lever rather than a cost lever** |
| 2 | [#5338](https://github.com/AtlasDevHQ/atlas/issues/5338) | The failing-capable measurement. Needs #5335 |
| 3 | [#5337](https://github.com/AtlasDevHQ/atlas/issues/5337) | Distilled CPU-local extractor. Needs #5338's baseline first — **and #5336's volume cut, which may remove the reason to build it** |
| 4 | [#5334](https://github.com/AtlasDevHQ/atlas/issues/5334) | The anchor |

### ⚠️ What the first order-1 batch actually taught, and what it changes below

#5339, #5352 and #5353 shipped together (PR [#5379](https://github.com/AtlasDevHQ/atlas/pull/5379)). Three corrections to the argument above, none of them status:

**The *"~99% of the cost saving"* claim was wrong, and wrong in the direction that matters.** The tier (#5353) is the ~5× step; batch (#5352) is a ~2× on top of it. And **batch does not run on the hosted deployment at all** — the AI Gateway's Anthropic-compatible surface is `POST /v1/messages` and `POST /v1/messages/count_tokens`, with no batches endpoint, and `getDefaultProvider()` resolves `gateway` on SaaS. So the delivered saving in that batch is the tier alone. *"Cheapest to build first"* selected the item that turned out to be inert; the ordering heuristic is what needs revisiting, not just the row.

**Left off deliberately rather than worked around.** Batch is a waypoint, not a destination: #5337 removes the per-token bill it halves, and Bedrock's batch API is a different shape — a new client, not a flag. **Deletion is the expected end state.** If #5336 or #5337 lands and nothing has switched batch on by then, delete `extract-batch.ts`, migration 0207 and the ledger rather than carry them. (No date, per this document's rule — the trigger is the sequence.)

**Run the numbers to steady state and cost stops being the interesting problem.** #5352's table is a 2M-message backfill; steady state at ~100k episodes/month is ~5% of it, single-digit dollars a month per workspace after the tier change. Cost matters for the **onboarding spike** — one-time, per customer, bounded. It is not what decides whether the eight conditions hold.

**The recurring constraint is the gate, and nothing shipped so far touches it.** This lane is named *protect the gate before breadth*, and tier/batch/policy are all cost or governance. PRD condition 4 asks that reviewing stay *"a bounded, comprehensible task — not an inbox that grows faster than anyone can read it"*, and every cost lever makes it **cheaper to run more extraction**, which makes the queue **bigger**. #5336 is the first item here that reduces what reaches a human at all — which is why its order-2 position is the thing to question, not its content.

**#5336 is also how you find out whether #5337 is worth building.** If triage cuts volume ~10×, the remaining backfill spend is small enough that a distilled CPU-local extractor saves very little — while costing a corpus, a training pipeline and an eval harness, with [ADR-0044](../adr/0044-fact-content-never-enters-model-weights.md) now making corpus acquisition an explicit prerequisite rather than *"use our episodes"*. Sequencing #5336 ahead of #5337 is cheaper than committing to #5337 and learning the same thing afterwards.

**The combination to avoid** is M3 source breadth ([#5354](https://github.com/AtlasDevHQ/atlas/issues/5354)'s payoff, and the rest of M3) landing before #5336. That is the one that fills a queue nobody can drain.

---

## Lane D — The Layer 2 rename

**UNFILED — and constrained by sequence rather than by schedule.**

[ADR-0038](../adr/0038-the-atlas-is-the-product-the-brain-is-the-category.md) Layer 2 renames the `searchBrain` tool name and the wire enum values. Layer 1 shipped; Layer 3 (schema) is explicitly never renamed.

The ADR fixes the timing and the reasoning is forced, not preferred:

- `v1.0.0` is reserved for frozen REST + MCP + plugin SDK contracts ([ADR-0008](../adr/0008-versioning-and-release-tags.md)). Once that tag is cut the rename stops being available — **not by a date, but because the contract is frozen from then on.** `v1.0.0` is itself unscheduled, so this is an ordering relationship between two undated events, not a countdown.
- It must ride a milestone that already changes the tool — **never a standalone rename PR.**

⚠️ **The milestone it was meant to ride was retrieval depth, and retrieval depth left the cut on 2026-08-13.** Layer 2 is now an orphaned dependency with no carrier and no issue. Either a future tool-touching milestone adopts it explicitly, or ADR-0038's timing argument needs an amendment saying what replaced it.

---

## Lane E — M6 Write-back (T9)

**No milestone, no issues, no date.**

`proposeFact` · lazy session-episode materialization · corroboration reuse · opt-in off-by-default autonomous draft-only suggester. ADR-0036 calls it *"the compounding self-improvement loop"* — the thing that makes the Atlas improve from use rather than only from ingestion.

Needs its own kickoff grill before scoping, on the precedent of #4755, #5004 and #5343.

⚠️ [#5332](https://github.com/AtlasDevHQ/atlas/issues/5332) in Lane A is a write-back defect found early — corroboration has no source arm, so a person agreeing with a warehouse row produces no reviewable draft. **Their testimony is swallowed.** That is M6's mechanism failing before M6 has been scoped, which is an argument for grilling this lane sooner rather than later.

---

## Lane F — M7 /ee governance & scale (T8)

**No milestone, no issues. Last by construction, and that ordering is load-bearing.**

Advanced approval (quorum/SoD/SLA/masking) · advanced ACL / label taxonomy / SCIM audience-sync · managed embedding endpoint · fact residency · audit-retention.

ADR-0036's governing test: **no brain capability may ever migrate to `/ee`.** Only convenience, governance and scale are commercial. The complete self-hostable Atlas ships before any monetization convenience exists — which is also finish condition 8, so Lane B and this lane check each other.

---

## Residue — filed, unscheduled

| Issue | Note |
|---|---|
| [#5198](https://github.com/AtlasDevHQ/atlas/issues/5198) | T7 retrieval depth. Descheduled; **re-justify against the eight conditions before scheduling**. Greenfield — `fusion.ts`/`search.ts` name the seam, contain no embedding code |
| [#5349](https://github.com/AtlasDevHQ/atlas/issues/5349) | An enrolled pair with all cells absent emits nothing and is reported nowhere |
| [#4999](https://github.com/AtlasDevHQ/atlas/issues/4999) | Atlas-published Zoom + Microsoft apps, so Cloud customers need not register their own |
| [#5113](https://github.com/AtlasDevHQ/atlas/issues/5113) | Reclassify two brain tables to `exported` for residency |

## Residue — UNFILED

| Gap | Why it is not nothing |
|---|---|
| ~~**The tier display names**~~ | **Now carried by [#5375](https://github.com/AtlasDevHQ/atlas/issues/5375)** as a finding to take into the run, not a fix to ship ahead of it. ADR-0038 proposes *Surveyed / Attested / On the record*; they exist only in `docs/` — **zero rendered labels in `packages/web/src`** (verified 2026-08-21). Renaming before testing would turn condition 3 into a check of a guess |
| **The coverage-surface design brief** | Deferred in near-identical words by both ADR-0038 and the PRD — *"the design is a separate brief."* Never written. [ADR-0041](../adr/0041-the-coverage-surface-counts-what-it-can-see.md) decided the page's *content* rules and permanently refused the single number, but not what it looks like. [#5357](https://github.com/AtlasDevHQ/atlas/issues/5357) is where that gap first drew blood |

---

## Suggested order, and the argument for it

1. **Lane A** — wrong data on prod outranks everything.
2. **Lane B, conditions 1, 3 and 7** — cheap, unproven, and they gate what the rest is worth. Run in parallel with A; they are demonstrations, not builds, so they contend for different hours. [#5376](https://github.com/AtlasDevHQ/atlas/issues/5376) (revocation) moves up from step 4 on its failure mode alone.
3. **Lane C** — cost control before M3 breadth widens the intake. ⚠️ **Within it, take [#5335](https://github.com/AtlasDevHQ/atlas/issues/5335) → [#5338](https://github.com/AtlasDevHQ/atlas/issues/5338) → [#5336](https://github.com/AtlasDevHQ/atlas/issues/5336) ahead of the rest of order-1.** #5335/#5338 first because every default in this lane is currently unjustified — #5353 shipped with *"the gate-agreement number is deferred"* written into `providers.ts` for want of a number to cite, and #5336's recall target and #5337's go/no-go will each want the same one. #5336 next because it is the only **gate** lever here and because it is how you learn whether #5337 is worth building at all. See Lane C's own note on why the *"cheapest first"* heuristic mis-selected on the first pass.
4. **Lane B, condition 8** — [#5377](https://github.com/AtlasDevHQ/atlas/issues/5377) is natively blocked by the other three, since it re-runs them and needs their baselines to compare against. It also wants Lane F's boundary still intact.
5. **Lane E grill** — sooner if #5332 recurs; M6 mechanism is already leaking into Lane A.
6. **Lane D** — whenever a tool-touching milestone appears. If none has appeared by the time `v1.0.0` is being considered, that is the moment to decide it deliberately: carry the rename then, or amend ADR-0038 to say what replaced its timing argument. Cutting the tag without deciding is the one outcome to avoid.
7. **Lane F** — last by construction.

**This preserves ADR-0036's ordering principle** — *trust before breadth before monetization* — and applies the PRD's one test for re-cutting: *a milestone that advances none of the eight finish conditions is a milestone worth questioning.* Lanes A and C advance none directly; both are defect and cost lanes that protect conditions already held. That is a reason to keep them short, not a reason to skip them.

## What this document does not decide

- **Whether Lane B's four demonstrations are one milestone or four.** They share a shape (run it, record what failed) and nothing else.
- **The M6 cut.** That is a grill's output, not a plan's.
- **Anything Lane D's carrier milestone should contain** beyond the rename itself.
- **Any part of the coverage surface design.** Still a separate brief, still unwritten.
