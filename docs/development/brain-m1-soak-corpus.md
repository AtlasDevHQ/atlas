# Brain M1 staging soak — question corpus

Matched **seed → expected fact → question** triples for exercising the M1 wedge loop on staging before `v0.2.0` is cut. Companion to [brain-slack-history.md](./brain-slack-history.md), which documents the connector itself.

Every seed is a message to post **top-level** (never in a thread) in a Slack channel the bot has been invited to. Post them as a human user, not via an app — a `bot_id` message is skipped by design.

## Before you start

| Prereq | Why |
|---|---|
| Staging Slack manifest carries `channels:history`, `groups:history`, `users:read`, `users:read.email` + re-installed | Without the history pair the connector 400s at install; without `users:read.email` every audience silently revokes |
| Bot invited to one **public** channel (`#atlas-eng` below) and one **private** (`#atlas-founders`) | The public/private split is what exercises `[org]` vs `audience:chat-channel:slack:<id>` |
| Two Atlas accounts whose emails match Slack members — **A** in the private channel, **B** not | ACL tests need a reader who should be denied |
| `ATLAS_BRAIN_EXTRACTION_ENABLED=true` | Set on `api-staging` 2026-07-26 |

Interleave the negatives with the positives when posting. A block of 15 clean facts followed by a block of 12 noise messages is not what a real channel looks like, and the ordering is free realism.

**Install it first.** Admin → **Knowledge Base → New collection** → *Company Brain (Slack history)*, entering the channel IDs. **Not** Admin → Integrations — that page renders only `chat` and `action` pillar rows, so this connector never appears there. Without an install row nothing reads the channels, and posting seeds is a no-op.

**Loop:** post → *Sync now* on `/admin/knowledge` (expect **0 documents** — episodes aren't documents) → wait ≤5 min for the extraction fiber → review `/admin/brain-facts` → publish → ask the questions.

> **Caveat on seed content.** These claims are drawn from `CLAUDE.md`, which makes retrieval realistic but means a correct answer may be model recall rather than a brain hit. R1/R2 are the control. For a stronger one, swap two or three §A seeds for facts that are true but unguessable (an internal ticket number, a specific vendor).

---

## A. Public channel positives — `#atlas-eng`

These should each yield at least one draft fact carrying an `[org]` grant.

| # | Seed message (post verbatim) | Expected fact (subject / predicate / object) | Question |
|---|---|---|---|
| S1 | `Writing this down so it stops being tribal knowledge: the prod branch is advanced only by /release. Nothing else pushes to it.` | prod branch / is advanced only by / /release · **single** | How does the prod branch get updated? |
| S2 | `Decision from standup: Atlas uses bun as its package manager and runtime. We are not supporting npm or yarn.` | Atlas / uses as package manager and runtime / bun · **single** | What package manager does Atlas use? |
| S3 | `For the record, the Atlas SaaS runs in three regions: us, eu, and apac.` | Atlas SaaS / runs in regions / us, eu, and apac | What regions does the Atlas SaaS run in? |
| S4 | `Reminder for anyone touching the query path: Atlas SQL validation is SELECT-only. No DML, no DDL, no semicolon chaining.` | Atlas SQL validation / is / SELECT-only · **single** | What kind of SQL can Atlas run? |
| S5 | `We host on Railway. The project is called satisfied-creation.` | Atlas / hosts on / Railway · **single**<br>(likely a 2nd fact for the project name) | Where is Atlas hosted? |
| S6 | `Confirmed: Atlas has no free tier. Paid plans only, starting at Starter.` | Atlas / has / no free tier · **single** | Does Atlas have a free tier? |
| S7 | `The npm scope for our published packages is @useatlas.` | our published packages / use npm scope / @useatlas · **single** | What npm scope does Atlas publish under? |
| S8 | `Slack is the only chat adapter live in production right now. The other seven are wired but not launched.` | Slack / is / the only chat adapter live in production · **single** | Which chat integrations are live? |
| S9 | `Auth is Better Auth. We are not rolling our own session handling.` | Atlas auth / is / Better Auth · **single** | What does Atlas use for authentication? |
| S10 | `The explore tool runs in Vercel Sandbox with networkPolicy deny-all. That is the isolation boundary.` | explore tool / runs in / Vercel Sandbox · **single** | How is the explore tool isolated? |
| S11 | `ADR-0024 decided that the process is the region — each region is its own process with its own database.` | ADR-0024 / decided / the process is the region · **single** | What does ADR-0024 decide? |
| S12 | `Our docs site runs on Fumadocs and deploys to docs.useatlas.dev.` | our docs site / runs on / Fumadocs · **single** | What powers the Atlas docs site? |
| S13 | `Dashboards are draft-first. Edits stay in draft until someone publishes them.` | Dashboards / are / draft-first · **single** | How does dashboard editing work? |
| S14 | `Policy, not a preference: we never merge a fork PR without a human security review, however green the checks are.` | fork PR / requires / a human security review · **single** | What is the policy on fork PRs? |
| S15 | `The internal DB is Postgres. Analytics datasources are separate and always read-only.` | internal DB / is / Postgres · **single** | What database does Atlas use internally? |

**Check while reviewing:** every one of these should read as a claim still worth knowing next month. Any draft that is really a restatement of *when* something happened is a false positive — note it.

---

## B. Negatives — must extract **nothing**

Post these in `#atlas-eng` too. Each should produce an **episode** but **no fact candidate**. This is the half of the system most likely to be wrong, and an over-eager extractor is worse than a quiet one: it fills a review queue nobody can drain.

| # | Seed message | Why it must yield nothing |
|---|---|---|
| N1 | `morning all` | greeting |
| N2 | `anyone know why CI is slow today?` | question |
| N3 | `honestly I think the admin console could look a lot nicer` | opinion |
| N4 | `lol the bot just answered its own question` | joke |
| N5 | `deploying now` | one-off status noise |
| N6 | `brb, lunch` | small talk |
| N7 | `can someone review 4821 when they get a sec?` | request, not a claim |
| N8 | `+1` | agreement token |
| N9 | `the build is red again` | transient state, not durable |
| N10 | `I'm leaning toward holding v0.2.0 until next week, but no decision yet` | **hard negative** — states explicitly that no decision exists. An extractor that mints "v0.2.0 / is held until / next week" has inferred a decision the message denies |
| N11 | `wait, is that the staging box or prod?` | question |
| N12 | `that graph looks off to me but I haven't dug in` | hedged opinion |

**Score this section explicitly.** Facts extracted here ÷ 12 is your false-positive rate. N10 is the one to watch — it's the case where the message contains decision-shaped words but asserts the opposite.

---

## C. Corroboration and contradiction

| # | Seed message | Expected behaviour |
|---|---|---|
| C1 | Re-post **S2 verbatim**, same wording, an hour later | New episode, **byte-exact same SPO** → corroborates the existing belief rather than minting a second one. Two separate drafts here is the dedupe failing |
| C2 | `Atlas's package manager is bun.` | Same *claim* as S2, different words → **expected to mint a separate belief**. Known M1 limitation (the entity resolver ships as a passthrough), so record it and do not file it as a bug |
| C3 | Post **S1 verbatim into the private channel too**, a few minutes after the public copy | **Cross-grant corroboration.** Byte-exact same SPO, two different grants → the second episode corroborates rather than creating, and only ONE fact survives. At ingest the fact keeps its **first-seen** grant; at publish it is promoted with the **union** of its own grant and those of its `provenance` evidence. `brain_edges` holds *both* episodes throughout |
| X1 | `Correction: the prod branch is now advanced by the deploy bot, not /release.` | Conflicts with **S1** on a **single**-cardinality predicate → should surface as a contradiction counterpart in the review UI, not silently overwrite S1 |

X1 is the highest-value single message in this corpus. Silent overwrite of a conflicting single-cardinality claim would be a real defect and is exactly what the review surface exists to catch.

C3 was added after the 2026-07-26 soak found it by accident (a double-post). It matters because a real company Slack repeats the same claim across channels constantly. The original M1 behaviour was **first-seen grant wins**, so a publicly-restated claim stayed locked to the private audience it was first seen in — fail-closed, but it made public information invisible. [#4823](https://github.com/AtlasDevHQ/atlas/issues/4823) fixed that at the publish seam (merged `d195a83fb`), so a claim first seen in `#atlas-founders` and restated in `#atlas-eng` now publishes as `{audience:chat-channel:slack:<id>, org}`.

**Run C3 in two stages — the stages have different expected answers, and collapsing them hides the bug.** Before publishing, the draft must still carry only the private grant (widening at ingest would be an unattended ACL mutation). After publishing, it must carry both.

```sql
-- STAGE 1, before publish: exactly one fact, still narrowly granted?
select subject, predicate, object, visible_to, status from brain_facts where object = '/release';
-- STAGE 2, after publish: same single row, now the UNION of both grants?
select subject, predicate, object, visible_to, status from brain_facts where object = '/release';
-- both episodes recorded as evidence, at both stages?
select ep.visible_to from brain_edges e join brain_episodes ep on ep.id = e.to_episode_id
 where e.from_fact_id = (select id from brain_facts where object = '/release');
```

> **Provenance attribution is now NARROWED on a widened fact ([#4836](https://github.com/AtlasDevHQ/atlas/issues/4836)) — this is the check to run, not a caveat to work around.** Widening carries the fact's provenance with it, so a fact widened out of a private channel *would* disclose its **first** episode's `sourceId` (a Slack `source_id` is `<channelId>:<ts>`), `actor` and `occurredAt` — *who said it first, where, and when*, i.e. private-channel membership. #4836 withholds exactly that triple from any reader who reaches the fact only because it was widened, and leaves it intact for anyone entitled to the fact's grant **before** widening. The episode body was never at risk either way: `brain_episodes` is ACL-gated in its own right. ADR-0036 §T5, `Amendment (2026-07-27, #4836)`, supersedes the accepted-price paragraph in the `#4823` amendment above it.
>
> **So C3 is now runnable on a PRIVATE claim, and that is the interesting direction.** The old guidance ("use S1, a public claim restated privately") existed only to avoid the disclosure; it now under-tests the fix. Run C3 both ways:
>
> | C3 variant | Reader | Expected |
> |---|---|---|
> | S1 public → restated privately | anyone | full attribution — the original grant was `org`, so nobody gained access by widening |
> | P-style private → restated publicly | **B** (not in `#atlas-founders`) | claim visible, `provenance.attribution` = `{ "visible": false }`; the queue shows **Attribution restricted** |
> | same | **A** (in `#atlas-founders`) | claim visible **with** full `actor` / `sourceId` / `occurredAt` |
>
> Both reader rows are needed: withholding from everybody would pass the first and is a regression, not a fix. Check the agent path too — `searchBrain` feeds chat answers, so ask a question that returns the widened fact as **B** and confirm the answer names no author and no channel.
>
> ```sql
> -- Did publish record the pre-widening grant? NULL means "never widened".
> select subject, visible_to, pre_widening_visible_to, status
>   from brain_facts where object = '/release';
> ```

---

## D. Private channel + ACL — `#atlas-founders`

| # | Seed message | Grant |
|---|---|---|
| P1 | `Our Series A target is 6M at a 30M post.` | `audience:chat-channel:slack:<id>` |
| P2 | `We're holding the v0.2.0 launch until Aug 3 so it doesn't collide with the YC deadline.` | same |
| P3 | `Pricing decision: Business tier lands at 499 a month and we are not discounting it for launch.` | same |

Then, with both accounts:

| Q | Asked by **A** (in channel) | Asked by **B** (not in channel) |
|---|---|---|
| What is our Series A target? | returns P1 | **returns nothing** |
| When is the v0.2.0 launch? | returns P2 | **returns nothing** |
| What does the Business tier cost? | returns P3 | **returns nothing** |

**Then the revocation test — the payoff.** Remove **A** from `#atlas-founders`, wait one audience-sync interval (30 min default), re-ask as **A**. All three must stop returning. This is the live-revocation path the entire `audience:` grant design exists to support, and the thing least likely to have been proven by the local suite.

A "returns nothing" that is actually the whole queue being empty proves nothing — confirm **B** can still see the `#atlas-eng` facts in the same session.

### D2. Queue-vs-count divergence — the cheapest ACL check in this document

Signed in as **B** (or any reader outside the private channel), compare two numbers:

- `/admin/brain-facts` — the review queue, **ACL-scoped to the reader**
- `/api/v1/mode` → `draftCounts.brainFacts` — **every draft in the workspace, unscoped by design**

| Observed | Meaning |
|---|---|
| equal, both = workspace total | ACL **not** applied to the review queue — private facts leaking to a non-member |
| equal, both = reader's subset | the unscoped count inherited the reader's ACL — an admin cannot distinguish a clean queue from a hidden backlog |
| **queue < count**, delta = private facts | ✅ both seams correct **and independent** |

Only the third is correct, and the check is non-vacuous in both directions at once: the queue proves it filters, the count proves it doesn't. The 2026-07-26 soak read **26 / 32** with 6 private facts — a pass.

This also answers "shouldn't an admin see everything?" — no. `role:platform_admin` is refused by the grant grammar (`acl.ts`), and a platform role resolves to `role: null`, conferring no brain grant, so Atlas cannot become a way to read a Slack channel you were never in. Reviewing private-channel facts is federated to that channel's members by design. The unscoped count is the deliberate escape hatch: an admin learns that facts exist they cannot see — a number, never content.

---

## E. Ingest skip paths — must never become episodes

| # | Action | Expected |
|---|---|---|
| K1 | Have any Slack **app** post a factual claim in `#atlas-eng` | `bot_id` → skipped, **counted** in the pass warnings. Atlas's own answers carry a `bot_id`, so this is what stops the brain citing itself |
| K2 | Post a **file/image with no text** | empty `text` → skipped and counted (`chk_brain_episodes_body_xor_locator` refuses `''`) |
| K3 | Post `Our SOC 2 auditor is Prescient Assurance.` as a **thread reply** | **Not ingested at all** — M1 never calls `conversations.replies`. Asking "who is our SOC 2 auditor?" must return nothing. Documented gap, not a bug, and it does **not** appear in skip tallies because it is never read |
| K4 | Post a factual claim in a channel the bot is **not** in | never ingested |
| K5 | Try to add a **1:1 DM** (`D…`) at install | refused on the form |

K3 is the one that will look like a retrieval bug during the soak. Expect it.

---

## F. Retrieval-only checks

| # | Question | Expected |
|---|---|---|
| R1 | What is our AWS bill? | nothing — never seeded. A confident answer here means the agent is answering from the model, not the brain |
| R2 | Who is our biggest customer? | nothing — never seeded |
| R3 | Re-ask **any** question from §A after **retracting** its fact at `/admin/brain-facts` | **must not return.** `searchBrain` has to AND `invalidated_at IS NULL` itself on top of the status and ACL clauses — a retracted fact still returning is a real defect |
| R4 | Ask something matching only an episode body, not a published fact (e.g. a distinctive phrase from N9) | should come back as **tier-3 evidence**, not tier-2 |
| R5 | Any §A question, **before** publishing | nothing — drafts must not be readable through `searchBrain` |

R3 and R5 are the two that would let unreviewed or withdrawn claims reach a user. Worth doing carefully even if everything else passes.

---

## Scorecard

| Section | Metric | Target | Actual |
|---|---|---|---|
| A | facts extracted / 15 seeds | ≥ 13 | |
| A | facts that are genuinely durable | all | |
| B | **false positives / 12** | 0–1 | |
| C1 | duplicate beliefs from verbatim repost | 0 | |
| C2 | separate belief from paraphrase | 1 (expected limitation) | |
| C3 | one fact survives cross-grant; both edges recorded | yes; narrow at draft, **union** at publish (#4823) | |
| C3 | `pre_widening_visible_to` records the narrow grant at publish | non-NULL on the widened fact, NULL elsewhere (#4836) | |
| C3 | attribution withheld from a reader gained by widening, kept for the original audience | both, in `/admin/brain-facts` **and** a `searchBrain` answer (#4836) | |
| X1 | contradiction surfaced, S1 not overwritten | yes | |
| D | B denied on all 3 private facts | yes | |
| D | revocation within one interval | yes | |
| D2 | queue < unscoped count, delta = private facts | yes | |
| E | K1/K2 skipped **and counted** | yes | |
| F | R3 retracted fact withheld | yes | |
| F | R5 draft not readable | yes | |

**Ship-blocking:** any failure in D, R3, or R5 — those are access-control and review-gate failures. Everything else is quality signal for M2.
