# The Company Atlas — completion plan

Status: draft (2026-08-21), reconciled 2026-08-24. **Perishable, like the PRD's snapshot.**

The destination is [`company-atlas.md`](./company-atlas.md): eight conditions that hold **for a real customer, in production, with no engineer present.** This document is the *path* to them.

## What this document is, and is not

It holds the **path** — lanes, their order, and the argument for that order. It deliberately does **not** hold status.

- **Status lives in `.claude/research/ROADMAP.md`, in GitHub, and — since 2026-08-24 — on the [Finish Conditions board](https://github.com/orgs/AtlasDevHQ/projects/3), which is keyed by *condition* where the ROADMAP is keyed by *date*.** Every row below points at an issue number or is marked **UNFILED**. When a lane's issues close, the lane closes; nothing here needs editing to stay true. This document is keyed by neither: it is keyed by **lane**, which is why it needs a reconciliation pass when the other three move and it does not.
- This exists because neither existing doc holds the path. The PRD states the destination and hands the cut back to [ADR-0036](../adr/0036-atlas-as-company-brain.md) §T10 — and **§T10's cut is now stale**: retrieval depth left it, M6 and M7 were never scheduled, and two milestones were added that carry no M-number.
- A row marked **UNFILED** is the only claim here that decays badly. Those are the ones to file first. *(Both UNFILED residue rows were filed on 2026-08-24 — [#5375](https://github.com/AtlasDevHQ/atlas/issues/5375) and [#5422](https://github.com/AtlasDevHQ/atlas/issues/5422). Lane D and Lane E's grill followed on 2026-08-26 — [#5469](https://github.com/AtlasDevHQ/atlas/issues/5469) and [#5468](https://github.com/AtlasDevHQ/atlas/issues/5468). **No UNFILED rows remain.** The rule worked four times out of four.)*
- **There are no dates in this document, and that is deliberate.** Nothing here is scheduled against a calendar. The order below is driven by dependency and by risk already live in production — never by a deadline. Where a constraint appears (Lane D), it is a **sequencing** constraint: this must happen before that, whenever that happens.

## Where the arc actually is

Five of seven cut milestones are closed (#91–#95). Two more were **not in the cut** — both exist because prod reads found defects that green tests could not — and of those, [#99](https://github.com/AtlasDevHQ/atlas/milestone/99) closed 2026-08-24 and [#98](https://github.com/AtlasDevHQ/atlas/milestone/98) is open. The one *unbuilt* finish condition (6) shipped 2026-08-20.

**The mechanism is nearly done and the proof is barely started.** That asymmetry is what this plan is ordered around, and 2026-08-24 sharpened it rather than easing it: Lane A closed on the same day Lane B grew from four conditions to eight and acquired a milestone. Every one of the eight conditions is now tracked by an issue — which was not true when this document was written — and exactly **one** of the nine issues tracking them is a build. The remaining distance to the destination is mostly demonstration, and demonstration is the kind of work that has never been scheduled here.

---

## Lane A — Stop serving wrong data ✅ **CLOSED 2026-08-24**

**Milestone [#99](https://github.com/AtlasDevHQ/atlas/milestone/99) — The Producer Stops Publishing · closed, 10 issues** — the 8 filed when this plan was written, plus [#5388](https://github.com/AtlasDevHQ/atlas/issues/5388) and [#5403](https://github.com/AtlasDevHQ/atlas/issues/5403) found in flight.

It ran first because it was the only lane with **known-wrong rows served on prod**. [ADR-0042](../adr/0042-warehouse-material-is-an-observation-never-a-published-belief.md): warehouse material is an observation, never a published belief.

The argument is kept as written rather than deleted, because **the argument is what moves Lane B to the front now**: no remaining lane has rows that are wrong on prod, so nothing else outranks the demonstrations on that basis.

| Order | Issue | Note |
|---|---|---|
| 1 | [#5340](https://github.com/AtlasDevHQ/atlas/issues/5340) | The shared observation predicate. Unblocked. Its whole value is landing **before** the three copies it prevents get written |
| 1 | [#5329](https://github.com/AtlasDevHQ/atlas/issues/5329) | Producer reads churned rows. Unblocked, independent of the publish/serve arc |
| 2 | [#5341](https://github.com/AtlasDevHQ/atlas/issues/5341), [#5342](https://github.com/AtlasDevHQ/atlas/issues/5342), [#5332](https://github.com/AtlasDevHQ/atlas/issues/5332) | All consume #5340 |
| 2 | [#5344](https://github.com/AtlasDevHQ/atlas/issues/5344) | Consumes #5329 |
| 3 | [#5331](https://github.com/AtlasDevHQ/atlas/issues/5331) | Retract the two stranded prod rows. Gated on #5342 so the population is closed first |

**Closed on:** [#5345](https://github.com/AtlasDevHQ/atlas/issues/5345), 2026-08-24 — five statements verified against prod in all three regions, per #5216's precedent. **Not on merge.** That is the second milestone in this arc to close on a prod read rather than a green build, after #5216; it is becoming the house pattern for a lane whose defects were all invisible to green tests.

⚠️ **The cadence hazard is cleared, and what replaced it is a decision nobody owns.** #5329 carried a live warning that turning on `ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED` before #5329/#5344 landed would put a churned-row producer on a clock, unattended. Both have landed, so the trap is gone — and the flag is now a deliberate choice rather than a hazard. **A cleared blocker is not a made decision.** Whether the cadence goes on, and what watches it when it does, is not tracked by this plan or by #99.

---

## Lane B — Prove the trust claim

**Milestone [#100](https://github.com/AtlasDevHQ/atlas/milestone/100) — The Eight Conditions, Demonstrated · 9 issues, all filed.** Four demonstrations filed 2026-08-21 ([#5374](https://github.com/AtlasDevHQ/atlas/issues/5374), [#5375](https://github.com/AtlasDevHQ/atlas/issues/5375), [#5376](https://github.com/AtlasDevHQ/atlas/issues/5376), [#5377](https://github.com/AtlasDevHQ/atlas/issues/5377)); the four remaining conditions and the lane's one build filed 2026-08-24 ([#5424](https://github.com/AtlasDevHQ/atlas/issues/5424), [#5425](https://github.com/AtlasDevHQ/atlas/issues/5425), [#5426](https://github.com/AtlasDevHQ/atlas/issues/5426), [#5427](https://github.com/AtlasDevHQ/atlas/issues/5427), [#5422](https://github.com/AtlasDevHQ/atlas/issues/5422)).

This was the largest gap in the plan and the one with nothing pointing at it. ADR-0036's T1 finding is that **the adoption gap is trust, not benchmark score**. Conditions 1, 3, 7 and 8 are the trust demonstrations proper, and all four are *built but never demonstrated* — and on 2026-08-24 the lane widened to carry all eight, because the same was true of 2, 4, 5 and 6 and nothing tracked them either.

| Condition | PRD status | What would close it | Tracked by |
|---|---|---|---|
| 1 — Cold start works | Not yet | A customer connects one source Monday; by Friday a colleague gets an approved-claim answer, **no engineer involved** | [#5374](https://github.com/AtlasDevHQ/atlas/issues/5374) |
| 2 — Human name on every claim | Close | Pick a claim at random and point at the person who made it authoritative, its source, its date — with **no exception** for claims that arrived by import, correction or migration, which are the open edges | [#5424](https://github.com/AtlasDevHQ/atlas/issues/5424) |
| 3 — Tiers unmistakable | Partly | Show an untrained person two answers; they distinguish data from approved-message without being taught the vocabulary | [#5375](https://github.com/AtlasDevHQ/atlas/issues/5375) · build: [#5422](https://github.com/AtlasDevHQ/atlas/issues/5422) |
| 4 — Disagreement survives | Yes, where recognized | Two people contradict each other in writing; a week later both still stand, attributed, neither picked — **and nobody intervened to keep it that way** | [#5425](https://github.com/AtlasDevHQ/atlas/issues/5425) |
| 5 — Past is legible | Yes at the record level | Someone who is **not an admin** gets today's answer, the previous answer, and who changed it when | [#5426](https://github.com/AtlasDevHQ/atlas/issues/5426) |
| 6 — Limits visible and honest | **Shipped 2026-08-20** | The coverage statement still holds on a prod read, and the PRD snapshot that still calls this the largest gap in the list is corrected | [#5427](https://github.com/AtlasDevHQ/atlas/issues/5427) |
| 7 — Revocation is real | Yes, least-demonstrated | Someone loses source access; within one sync cycle their scoped claims stop being visible, no manual step | [#5376](https://github.com/AtlasDevHQ/atlas/issues/5376) |
| 8 — Self-hoster has all of it | By construction | Conditions 1–7 re-run on a self-hosted install, no license key, no Atlas account | [#5377](https://github.com/AtlasDevHQ/atlas/issues/5377) — blocked by the seven above |

**Eight conditions, nine issues, and only one of them is a build.** [#5422](https://github.com/AtlasDevHQ/atlas/issues/5422) — the Coverage Plate — is the sole construction item in this lane. It sits against condition 3 rather than 6 on purpose: condition 6's *semantics* shipped, and what is missing is whether a person can tell the tiers apart on sight, which is condition 3's test. Everything else here is run-and-record. That ratio is the plan's central claim made concrete — **the mechanism is nearly done and the proof is barely started.**

The PRD calls **1 and 3 "cheap to test"** and says the milestone that held them ([#96](https://github.com/AtlasDevHQ/atlas/milestone/96)) did **not** close them — *"the next milestone that claims them has to say so explicitly rather than inherit them from this line."* ~~No milestone has.~~ **[#100](https://github.com/AtlasDevHQ/atlas/milestone/100) does, as of 2026-08-24** — see below.

**Why this lane runs early, not last.** Every other lane is mechanism. If a cold start fails for reasons no ticket predicted, that finding should arrive before M6 builds on top of it — and conditions 1 and 3 are cheap enough that deferring them buys nothing.

⚠️ These are **demonstrations, not builds** — with one deliberate exception, [#5422](https://github.com/AtlasDevHQ/atlas/issues/5422). Each demonstration either holds or produces a defect list. A lane that cannot fail is not worth running, so each must be run against a real workspace with the engineer's hands off. Every issue carries the same closing rule: **a failed condition still closes the issue, on the record** — a held-open issue is not how a failed demonstration is tracked, and fixes are filed rather than folded in flight.

**The milestone claim has now been made, deliberately — which is what the unmilestoned filing was for.** The ROADMAP's rule is that *"the next milestone that claims them has to say so explicitly rather than inherit them from this line."* Filing the first four unmilestoned on 2026-08-21 left that claim available to be exercised rather than inherited; [#100](https://github.com/AtlasDevHQ/atlas/milestone/100) exercises it, by naming all eight conditions. That is precisely what the [Coverage Surface milestone](https://github.com/AtlasDevHQ/atlas/milestone/96) did not do when it *held* conditions 1 and 3 and then closed on the other half. **The gap that opened there is now closed structurally, not just refilled.**

[#5376](https://github.com/AtlasDevHQ/atlas/issues/5376) is still the one to run first if only one gets run: it is the only finish condition whose failure mode is a **disclosure** rather than a disappointment. [#5427](https://github.com/AtlasDevHQ/atlas/issues/5427) is the one to run second, on cost rather than severity — it re-checks a surface that shipped four days ago and corrects a PRD snapshot that is actively wrong in the misleading direction, saying condition 6 is the largest gap in the list when it is the most recently closed.

### ⚠️ Condition 1 needs a customer, and nothing else in this plan does

The PRD's bar is *all eight hold for a **real customer**, in production, with no engineer present.* Seven of the eight can be demonstrated against a workspace we control. **Condition 1 cannot.** It is written as *a new customer connects one source on Monday* and *someone in that company* asking on Friday — a run staged on our own workspace answers a different question, in exactly the way [#5374](https://github.com/AtlasDevHQ/atlas/issues/5374) warns a hands-on run does. Condition 8 re-runs 1–7, so it inherits the dependency.

This is the only prerequisite in the entire plan that is **not an engineering task**, and until now it appeared nowhere — not in the PRD, not in #5374's own body, not in the lane order below. Whoever picks up #5374 meets it in the first five minutes.

Two consequences, both sequencing rather than schedule:

- **The other seven do not wait on it.** Conditions 2–8 are runnable against a workspace we control; only #5374 is gated. Blocking the lane on the customer would stall seven demonstrations for one, which is the opposite of why this lane runs early.
- **"Finished" is not reachable by engineering alone.** The reachable ceiling is *seven of eight demonstrated, one waiting on a customer* — and that is a good state to be in, not a failure. Naming it here is the point: it should be met deliberately, not discovered.

**This document does not decide where the customer comes from.** It records that the question is open, that it is the last one, and that no amount of work in Lanes C–F moves it.

---

## Lane C — Protect the gate before breadth

**Milestone [#98](https://github.com/AtlasDevHQ/atlas/milestone/98) — The Extraction Cascade · 11 issues, all filed** — the 10 in the original cut, plus [#5381](https://github.com/AtlasDevHQ/atlas/issues/5381), which files the ADR-0044 corpus prerequisite this document flagged as untracked.

Cost and volume control ahead of M3 source breadth widening. [#5334](https://github.com/AtlasDevHQ/atlas/issues/5334) is the anchor and is blocked by everything else. Its grill, [#5343](https://github.com/AtlasDevHQ/atlas/issues/5343), is the only open `wayfinder:map`.

| Order | Issue | Note |
|---|---|---|
| 1 | [#5339](https://github.com/AtlasDevHQ/atlas/issues/5339) | The two training prohibitions. Docs only, cheapest item in the arc |
| 1 | [#5352](https://github.com/AtlasDevHQ/atlas/issues/5352) + [#5353](https://github.com/AtlasDevHQ/atlas/issues/5353) | Same call site — do together. ⚠️ The issues' *"~99% of the cost saving"* claim did not survive contact — see below |
| 1 | [#5335](https://github.com/AtlasDevHQ/atlas/issues/5335) | Gate-decision export. Unblocked, and supplies #5338's held-out set |
| 1 | [#5354](https://github.com/AtlasDevHQ/atlas/issues/5354) | Quoted-reply stripping. **Shipped 2026-08-24** (PR #5419). Its deferred half — disclaimer footers — is [#5420](https://github.com/AtlasDevHQ/atlas/issues/5420), filed the same day and **unmilestoned**; it belongs to this lane and is not currently claimed by it |
| 1 | [#5381](https://github.com/AtlasDevHQ/atlas/issues/5381) | ADR-0044 corpus acquisition. Ordered 1 not because it is urgent but because it is **procurement, not code** — the only item in this lane whose duration does not shrink with effort applied to it. Start it in parallel with everything else |
| 2 | [#5336](https://github.com/AtlasDevHQ/atlas/issues/5336) | Stage 0 unblocked; stage 1 waits on #5335. **The first item in this lane that is a GATE lever rather than a cost lever** |
| 2 | [#5338](https://github.com/AtlasDevHQ/atlas/issues/5338) | The failing-capable measurement. Needs #5335 |
| 3 | [#5337](https://github.com/AtlasDevHQ/atlas/issues/5337) | Distilled CPU-local extractor. Needs #5338's baseline first. **Committed — the question is timing, not whether**, which changes what the items above are for |
| 4 | [#5334](https://github.com/AtlasDevHQ/atlas/issues/5334) | The anchor |

### ⚠️ What the first order-1 batch actually taught, and what it changes below

#5339, #5352 and #5353 shipped together (PR [#5379](https://github.com/AtlasDevHQ/atlas/pull/5379)). Three corrections to the argument above, none of them status:

**The *"~99% of the cost saving"* claim was wrong, and wrong in the direction that matters.** The tier (#5353) is the ~5× step; batch (#5352) is a ~2× on top of it. And **batch does not run on the hosted deployment at all** — the AI Gateway's Anthropic-compatible surface is `POST /v1/messages` and `POST /v1/messages/count_tokens`, with no batches endpoint, and `getDefaultProvider()` resolves `gateway` on SaaS. So the delivered saving in that batch is the tier alone. *"Cheapest to build first"* selected the item that turned out to be inert; the ordering heuristic is what needs revisiting, not just the row.

**Left off deliberately rather than worked around.** Batch is a waypoint, not a destination: #5337 removes the per-token bill it halves, and Bedrock's batch API is a different shape — a new client, not a flag. **Deletion is the expected end state.** If #5336 or #5337 lands and nothing has switched batch on by then, delete `extract-batch.ts`, migration 0207 and the ledger rather than carry them. (No date, per this document's rule — the trigger is the sequence.)

**Run the numbers to steady state and cost stops being the interesting problem.** #5352's table is a 2M-message backfill; steady state at ~100k episodes/month is ~5% of it, single-digit dollars a month per workspace after the tier change. Cost matters for the **onboarding spike** — one-time, per customer, bounded. It is not what decides whether the eight conditions hold.

**The recurring constraint is the gate, and nothing shipped so far touches it.** This lane is named *protect the gate before breadth*, and tier/batch/policy are all cost or governance. PRD condition 4 asks that reviewing stay *"a bounded, comprehensible task — not an inbox that grows faster than anyone can read it"*, and every cost lever makes it **cheaper to run more extraction**, which makes the queue **bigger**. #5336 is the first item here that reduces what reaches a human at all — which is why its order-2 position is the thing to question, not its content.

**#5337 is committed; the open question is only when.** So #5335, #5338 and #5336 are not a go/no-go on it — they are what make it *buildable and judgeable*. #5338 supplies the baseline a distilled model has to beat (and there is no other source for one). #5336 cuts the volume the local model must carry, which is a sizing input rather than a veto. And [ADR-0044](../adr/0044-fact-content-never-enters-model-weights.md) makes corpus acquisition an explicit prerequisite rather than *"use our episodes"* — that is the long-pole item in #5337 and the one most worth starting early, because it is procurement rather than code.

**The combination to avoid** is M3 source breadth ([#5354](https://github.com/AtlasDevHQ/atlas/issues/5354)'s payoff, and the rest of M3) landing before #5336. That is the one that fills a queue nobody can drain.

---

## Lane D — The Layer 2 rename

**[#5469](https://github.com/AtlasDevHQ/atlas/issues/5469) — filed 2026-08-26. Constrained by sequence rather than by schedule.**

[ADR-0038](../adr/0038-the-atlas-is-the-product-the-brain-is-the-category.md) Layer 2 renames the `searchBrain` tool name and the wire enum values. Layer 1 shipped; Layer 3 (schema) is explicitly never renamed.

The ADR fixes the timing and the reasoning is forced, not preferred:

- `v1.0.0` is reserved for frozen REST + MCP + plugin SDK contracts ([ADR-0008](../adr/0008-versioning-and-release-tags.md)). Once that tag is cut the rename stops being available — **not by a date, but because the contract is frozen from then on.** `v1.0.0` is itself unscheduled, so this is an ordering relationship between two undated events, not a countdown.
- It must ride a milestone that already changes the tool — **never a standalone rename PR.**

⚠️ **The milestone it was meant to ride was retrieval depth, and retrieval depth left the cut on 2026-08-13.** Layer 2 is now an orphaned dependency with no carrier and no issue. Either a future tool-touching milestone adopts it explicitly, or ADR-0038's timing argument needs an amendment saying what replaced it.

**Two candidate carriers now exist that did not on 2026-08-21.** [#100](https://github.com/AtlasDevHQ/atlas/milestone/100) touches the labels a person reads at #5375, and [#101](https://github.com/AtlasDevHQ/atlas/milestone/101) will add `proposeFact`. Neither has adopted the rename, and **neither should acquire it by proximity** — the ADR's rule is that it rides a milestone *that already changes the tool*, and that is a claim a milestone makes for itself, not one this document can make on its behalf.

⭐ **#101 DECLINED it on 2026-08-27, explicitly** — [#5468](https://github.com/AtlasDevHQ/atlas/issues/5468), the M6 kickoff grill, which the ADR's rule required to claim or decline for itself rather than acquire by proximity. The grounds are the grill's own inventory. The premise for claiming was the sentence above — *"#101 will add `proposeFact`"* — and `proposeFact` **does not exist in `packages/`**, with a live alternative reading that `correct_fact` already *is* the agent write and the verb would never be built. That reading was rejected ([ADR-0036 §T9's 2026-08-27 amendment](../adr/0036-atlas-as-company-brain.md#write-back--self-improvement-loop-t9)), so `proposeFact` is still M6's to build — but a milestone may not claim a carrier-only rename on the strength of a verb whose existence it settled in the same breath, and #5468's route puts that verb behind the naming decision the grill itself had to make first. **One candidate carrier remains — [#100](https://github.com/AtlasDevHQ/atlas/milestone/100) — and the decision stays open at [#5469](https://github.com/AtlasDevHQ/atlas/issues/5469) with its expiry unchanged.**

**This is now the cheapest open decision in the plan and the only one with an expiry.** It costs a paragraph in whichever milestone takes it. It stops being available the moment `v1.0.0` freezes the contracts — and `v1.0.0` is undated, which makes it easy to keep deferring right up until the deferral is permanent.

---

## Lane E — M6 Write-back (T9)

**Milestone [#101](https://github.com/AtlasDevHQ/atlas/milestone/101) — Brain M6: Write-back · created 2026-08-24. No issues, no date. Its kickoff grill is [#5468](https://github.com/AtlasDevHQ/atlas/issues/5468), filed 2026-08-26.**

`proposeFact` · lazy session-episode materialization · corroboration reuse · opt-in off-by-default autonomous draft-only suggester. ADR-0036 calls it *"the compounding self-improvement loop"* — the thing that makes the Atlas improve from use rather than only from ingestion.

Needs its own kickoff grill before scoping, on the precedent of #4755, #5004 and #5343 — now [#5468](https://github.com/AtlasDevHQ/atlas/issues/5468).

⚠️ **The grill's first job turned out to be an inventory, not a design.** `proposeFact` does not exist anywhere in `packages/` — and an agent write onto the fact graph shipped anyway under a different verb: `tools/correct-fact.ts` is a registered agent tool and `brain/correction.ts` enters through `reconcileFacts`, the exact seam T9 says write-back reuses. That is the third writer T9 describes, arriving as part of condition 5 rather than as part of M6, and under a name the ADR does not use. The #5332 signal below is the same shape one lock over.

**The grill answered on 2026-08-27, and its output is a route rather than a spec.** The inventory lives lock-by-lock in [ADR-0036 §T9's amendment](../adr/0036-atlas-as-company-brain.md#write-back--self-improvement-loop-t9), where the next reader of the five locks will meet it. The naming question is settled: **`proposeFact` is a new verb beside `correct_fact`**, because the two differ on target, exit and gate, and their authority gate and review gate are substitutes for one another — so collapsing them fails in both directions. **Three of the five locks need no M6 work at all** (lock 2 is unbuilt and clean, lock 4 is held by construction, lock 5 is satisfied but for one residue), and that is what sizes the milestone.

**The milestone-worth-questioning argument, stated rather than assumed.** M6 advances **none** of the eight finish conditions directly, and this plan requires the argument to be made either way. It is **kept**, and the inventory changes the grounds it is kept on: M6's value is *not* primarily the new capability. It is that an agent write onto the fact graph is **already live, already serving, and was never scoped** — with lock 1's review-gate half decided by default rather than by decision. That is governance debt on shipped code, which is the same class of argument that kept Lanes A and C, neither of which advances a condition either. It also argues for a **small** M6: name the write that exists, add the one verb that closes the loop together with its review gate, clear lock 5's residue, and stop.

**Lane D was declined here, not deferred** — see Lane D above. The route is filed as children of #5468, in dependency order; **nothing entered [#101](https://github.com/AtlasDevHQ/atlas/milestone/101) before the grill closed.**

⚠️ **An empty milestone reads as a scoped one.** #101 is a name and a claim on the arc, not a cut. Nothing should be filed into it ahead of that grill — otherwise the grill ratifies whatever happened to be filed first, which is the exact failure the precedent exists to prevent.

⚠️ [#5332](https://github.com/AtlasDevHQ/atlas/issues/5332) in Lane A is a write-back defect found early — corroboration has no source arm, so a person agreeing with a warehouse row produces no reviewable draft. **Their testimony is swallowed.** That is M6's mechanism failing before M6 has been scoped, which is an argument for grilling this lane sooner rather than later.

**#5332 closed 2026-08-22 under Lane A, and the fix does not retire the signal.** What was found is that an M6 mechanism was already live, already wrong, and already serving — before anyone scoped M6. That is evidence about how much of the write-back surface exists unexamined, not about one lookup missing a `status` filter. Closing the defect answers the row; the grill is what answers the question the row raised.

---

## Lane F — M7 /ee governance & scale (T8)

**Milestone [#102](https://github.com/AtlasDevHQ/atlas/milestone/102) — Brain M7: /ee Governance & Scale · created 2026-08-24. No issues. Last by construction, and that ordering is load-bearing.**

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

## Residue — UNFILED (empty as of 2026-08-26; both rows carried, struck through as the record)

| Gap | Why it is not nothing |
|---|---|
| ~~**The tier display names**~~ | **Now carried by [#5375](https://github.com/AtlasDevHQ/atlas/issues/5375)** as a finding to take into the run, not a fix to ship ahead of it. ADR-0038 proposes *Surveyed / Attested / On the record*; they exist only in `docs/` — **zero rendered labels in `packages/web/src`** (verified 2026-08-21). Renaming before testing would turn condition 3 into a check of a guess |
| ~~**The coverage-surface design brief**~~ | **Now carried by [#5422](https://github.com/AtlasDevHQ/atlas/issues/5422)**, filed 2026-08-24 into Lane B. Deferred in near-identical words by both ADR-0038 and the PRD — *"the design is a separate brief"* — and never written, while the design itself was **lost twice** for want of a row to survive in. [ADR-0041](../adr/0041-the-coverage-surface-counts-what-it-can-see.md) decided the page's *content* rules and permanently refused the single number, but not what it looks like; #5422 is the visual half, and it carries the mockup rather than pointing at a milestone that closed on something else. [#5357](https://github.com/AtlasDevHQ/atlas/issues/5357) is where the gap first drew blood |

---

## Suggested order, and the argument for it

> ~~**Lane A** — wrong data on prod outranks everything.~~ **Done 2026-08-24.** It held the top slot on the only basis that outranks demonstration, and no remaining lane has that basis. Everything below moves up one.

1. **Lane B, conditions 7 → 6 → 2, 3, 4, 5** — cheap, unproven, and they gate what the rest is worth. Now first, which needs no new argument: the lane's own case was *"cheap, unproven, gate what the rest is worth"*, and it was second only because prod was serving wrong rows.
   - [#5376](https://github.com/AtlasDevHQ/atlas/issues/5376) (revocation) first on failure mode: **disclosure, not disappointment.**
   - [#5427](https://github.com/AtlasDevHQ/atlas/issues/5427) (limits) second on cost: it re-checks a surface that shipped 2026-08-20 and corrects a PRD snapshot that is wrong in the misleading direction.
   - [#5422](https://github.com/AtlasDevHQ/atlas/issues/5422) (the Coverage Plate) is the lane's only **build** and does not contend for the same hours as the demonstrations — it can run alongside them.
   - [#5374](https://github.com/AtlasDevHQ/atlas/issues/5374) (cold start) last of the eight, because it is the only one gated on a customer. See the warning in Lane B.
2. **Lane C** — cost control before M3 breadth widens the intake. ⚠️ **Within it, take [#5335](https://github.com/AtlasDevHQ/atlas/issues/5335) → [#5338](https://github.com/AtlasDevHQ/atlas/issues/5338) → [#5336](https://github.com/AtlasDevHQ/atlas/issues/5336) ahead of the rest of order-1.** #5335/#5338 first because every default in this lane is currently unjustified — #5353 shipped with *"the gate-agreement number is deferred"* written into `providers.ts` for want of a number to cite, and #5336's recall target and #5337's accept/reject bar will each want the same one. #5336 next because it is the only **gate** lever here, and because the volume it removes is a sizing input for #5337 rather than a verdict on it. See Lane C's own note on why the *"cheapest first"* heuristic mis-selected on the first pass.
   - ⚠️ **[#5381](https://github.com/AtlasDevHQ/atlas/issues/5381) starts in parallel with all of the above, not after it.** It is procurement, and procurement does not compress under effort — it is the one item here that gets shorter only by starting earlier.
3. **Lane D — the decision, not the work.** Promoted from step 6, and it is not a reversal of that placement's logic: the *rename* still waits for a carrier, but **choosing the carrier no longer does**, because two candidate milestones now exist and neither existed on 2026-08-21. It costs a paragraph, and it is the only item in this document with an expiry. Cutting `v1.0.0` without having decided is still the one outcome to avoid. **Half-answered on 2026-08-27: [#101](https://github.com/AtlasDevHQ/atlas/milestone/101) declined, leaving [#100](https://github.com/AtlasDevHQ/atlas/milestone/100) as the sole candidate. A decline narrows the choice; it does not make it, so this step stays open at [#5469](https://github.com/AtlasDevHQ/atlas/issues/5469) — and with one carrier left, the expiry now bites harder, not less.**
4. **Lane B, condition 8** — [#5377](https://github.com/AtlasDevHQ/atlas/issues/5377) is natively blocked by the other seven, since it re-runs them and needs their baselines to compare against. It also wants Lane F's boundary still intact.
5. ~~**Lane E grill**~~ — **done 2026-08-27 ([#5468](https://github.com/AtlasDevHQ/atlas/issues/5468)), and it ran ahead of this position deliberately**, on the #5332 signal's argument that live unexamined mechanism does not wait its turn. Its inventory half never contended for Lane B/C's hours. What replaces it at this step is **M6 itself**, sized small by what the inventory found: nothing entered #101 before the grill closed, and three of T9's five locks need no work at all.
6. **Lane F** — last by construction.

**This preserves ADR-0036's ordering principle** — *trust before breadth before monetization* — and applies the PRD's one test for re-cutting: *a milestone that advances none of the eight finish conditions is a milestone worth questioning.* Lane A (now closed) and Lane C advance none directly; both are defect and cost lanes that protect conditions already held. That is a reason to keep them short, not a reason to skip them.

**What the reconciliation changed about the shape of this plan.** With Lane A closed, the critical path is a lane made almost entirely of demonstrations, and Lane C is the only substantial construction left before M6. That is the arc arriving where ADR-0036 said it would — *the ordering is the strategy*, and the strategy was trust first. It also means the plan's remaining risk has moved: it is no longer *"will the mechanism work"* but *"will anyone be shown that it does"*, and the answer to the second is partly outside engineering's hands.

## What this document does not decide

- ~~**Whether Lane B's four demonstrations are one milestone or four.**~~ **Decided 2026-08-24: one milestone, [#100](https://github.com/AtlasDevHQ/atlas/milestone/100), carrying all eight demonstrations and one build.** They share a shape (run it, record what failed) and nothing else — but the ROADMAP's rule required a milestone to claim the conditions *by name*, and eight separate milestones would have made that claim eight times without ever making it once.
- **Where the customer for condition 1 comes from.** Named as an open question in Lane B, deliberately undecided here. It is the only prerequisite in this plan that no lane can produce.
- **The M6 cut.** That is a grill's output, not a plan's.
- **Anything Lane D's carrier milestone should contain** beyond the rename itself.
- ~~**Any part of the coverage surface design.**~~ **Now [#5422](https://github.com/AtlasDevHQ/atlas/issues/5422)**, which carries the mockup and its own disclaimer. What this document still does not decide is anything *about* that design — only that it finally has a row it cannot fall out of.
