# The Company Keystone is asked for, never researched

Status: accepted (2026-08-19, same grill as [ADR-0042](./0042-warehouse-material-is-an-observation-never-a-published-belief.md) — this is the half about what the fact store is *for*)

- **Amends:** [ADR-0040](./0040-the-class-major-ingest-contract.md) — the `human` row of the class contract table (*"not connectable · extraction: never"*).
- **Amends:** the `HUMAN_SOURCE` doc in `lib/brain/sources.ts`, which states as a class property what is really a per-writer choice.
- **Extends:** [ADR-0041](./0041-the-coverage-surface-counts-what-it-can-see.md) with one legitimate denominator it did not anticipate.

ADR-0042 decided that derivable, volatile material is queried and never stored as belief. That sharpens the question of what the fact store *is* for: non-derivable, durable material — decisions, rationale, ownership, policy. The largest body of it is the most obvious thing about a company and the thing nothing in the corpus produces: **what the company is and does.** Nobody says it in Slack, because everyone already knows. It is not a warehouse column. We decided: **Atlas asks.** A guided interview — the **Company Keystone** — in which an Atlas agent asks, the person answers in their own words, and those answers become reviewed facts through the ordinary gate. **Web research drives the questions and never mints a claim.**

## It is not a third store

Keystone material is durable and non-derivable, which by ADR-0042's own split puts it squarely in the fact store. It needs no new home and no new table. What it lacked was never a store — it was an **ingest path**.

The tempting shortcut is a fifth correction verb (`assert`): a human-authoritative entry point that promotes immediately, on the model of `correct_fact`, whose author *is* the reviewer. **Rejected.** The onboarding agent composes the claims; the human supplies prose. An agent-composed claim reaching `published` with no human naming it makes the onboarding agent a second promotion writer with no reviewer — the exact shape `scripts/check-brain-fact-promotion.sh` exists to refuse — and a guaranteed exception to PRD finish condition 2, which admits none.

## The path already exists and is unclaimed

`DRAIN_EPISODES_SQL` (`lib/brain/extract.ts`) has **no source filter**. `human` episodes stay out of extraction because `correct_fact` **pre-stamps `extracted_at`** at write time. That is a per-writer choice, not a class prohibition, and the keystone writer chooses the other way:

1. The agent asks; the person answers in prose.
2. Each answer lands as a `human`-source episode, **not** pre-stamped.
3. Extraction drains it; drafts land in `brain_facts` as they do for any episode.
4. **The wizard's confirmation screen — *"here's what I understood, is this right?"* — is the review gate**, wearing a friendlier skin. Same table, same promotion adapter, same audit row, same grant widening.

The pre-stamp's stated reason survives intact and simply does not apply here. `correct_fact` pre-stamps *"so a human's statement is not re-derived into a second, machine-produced claim"* — the human there has already authored a structured claim, so extraction would duplicate it. A keystone answer is prose; there is no claim yet, so extraction is not a re-derivation but the only derivation.

**What this buys is the cold start.** PRD condition 1 is *"a new customer connects one source on Monday; by Friday someone asks a question and gets an answer built from a claim that a colleague of theirs approved."* Today that Friday depends on somebody happening to say something extractable in Slack. Routed this way it happens **in the onboarding session, on Monday, by construction** — the person approves claims about their own company minutes after connecting. The review gate stops being a chore asked of a stranger and becomes the last step of a conversation they are already in. That is the strongest argument for building this, and it is stronger than *"the Atlas should know what the company does."*

## Web research is a question driver, never evidence

The agent reads the company's public material **to know what to ask** and to pre-fill a proposal: *"your site says you sell to data teams — is that still right, and how would you put it?"* The person's **answer** is the episode. The page is never evidence for anything.

The rejected shape — research-as-evidence, where the agent composes claims from public material and the human bulk-approves — fails on four counts at once. It needs a new `web` member in `EPISODE_SOURCE_SPECS`; it needs a trust-tier answer for material that is neither warehouse nor testimony by anyone at the company; it needs an ACL answer; and under PRD condition 2 *"point at the person who made it authoritative"* resolves to **nobody**. The failure mode is specific: a company's public copy is the most confidently-worded stale thing about it. Atlas ingesting its customer's marketing page and serving it back as company knowledge is the inverse of *"the Atlas knows things your database doesn't."*

Research-as-prompt keeps every benefit — the agent does the legwork, the person is not staring at a blank form — and mints no new source class, no new tier, no new ACL surface, and no exception.

## Keystone is a coverage class, and the one place a real denominator exists

ADR-0041 refuses a company-wide coverage percentage because *no denominator exists to be correct about*. A fixed interview script is a denominator that **does** exist: fourteen questions, nine answered, is a true percentage and not a guess wearing a UI.

Recorded explicitly so it does not read as a violation: **the denominator is legitimate because Atlas authored it, not because Atlas measured the company.** That is the same move `coverageLabelPolicy` already makes for warehouse units under the deliberate-act clause — the thing being counted is a thing we defined. The survey unit is **one keystone question**, and this gives condition 6 a sentence it currently cannot say: *"Atlas does not know what your company sells"* as a countable, actionable gap rather than an absence nobody can see.

## It is re-asked on a schedule

Keystone answers are durable, not permanent — pricing, positioning, ICP and headcount all drift. Unlike a Slack claim, **nobody ever re-says them**, so `last_observed_at` decays monotonically forever with no possible re-observation.

So the keystone class gets a scheduled re-interview over the decayed subset (the `registerPeriodicFiber` pattern): *"5 keystone answers are over a year old — two minutes to confirm."* This is the **first consumer of the decay signal** ([#4914](https://github.com/AtlasDevHQ/atlas/issues/4914)), and it is consistent with decay being advisory: nothing auto-acts on it; the fiber asks a human to act, which is the affordance decay was built to enable and has so far had no consumer for.

**The commitment this implies is worth naming.** The Company Keystone is not an onboarding screen. It is a **standing conversation Atlas returns to**, and building it as a one-time wizard would have to be undone the first time a price changes.

## Consequences

- **`human` becomes a two-writer source**, with opposite extraction behaviour per writer. `sources.ts`'s doc must say the pre-stamp is `correct_fact`'s choice and why, rather than describing the class. ADR-0040's class table row changes from *"extraction: never (#4915)"* to *"per writer"*.
- **Extracted keystone claims are LLM-derived**, so they carry the same tier-2 trust as any extracted claim and the same review requirement. The person's prose is the episode; the triple is machine-produced. Nothing here promotes without the gate.
- **The onboarding session becomes a review surface**, so the review queue's refusal reasons (`classifyFactForPromotion`) reach a first-run user who has never seen `/admin/brain`. Refusal copy written for an admin console is now read by someone on day one.
- **Someone will propose skipping the confirmation screen** to shorten onboarding — *"they just told us, why ask twice?"* That is the `assert` verb again with the human step moved somewhere it stops being one. The test is whether a person saw the claim as it will be stored.

## Alternatives rejected

- **A fifth correction verb (`assert`)** — a human-authoritative create alongside `supersede`. Rejected above: a second promotion writer with no reviewer, and a condition-2 exception.
- **Research-as-evidence** — rejected above; no tier answers for it.
- **A hand-authored form** — the person types claims directly. No new machinery at all, and it is what the user rejected on contact with reality: a blank form asking someone to enumerate what their company is produces nothing. The agent's job is to make the question easy, not to make the answer up.
- **Keystone as knowledge documents** — a KB collection holding a company overview. Rejected because ADR-0028's seam is explicit that *a knowledge document is never extracted into a fact*: the material would reach answers at retrieval time, tier-labelled as a document, and would never become a claim anyone approved. That is the opposite of condition 1.

See also: [ADR-0042](./0042-warehouse-material-is-an-observation-never-a-published-belief.md) (what the fact store is not for) · [ADR-0040](./0040-the-class-major-ingest-contract.md) (the class contract this amends) · [ADR-0041](./0041-the-coverage-surface-counts-what-it-can-see.md) (the denominator rule this extends) · [`docs/prd/company-atlas.md`](../prd/company-atlas.md) (conditions 1, 2 and 6).
