# Fact content never enters model weights, and customer data is never a training corpus

Status: accepted (2026-08-21, [#5339](https://github.com/AtlasDevHQ/atlas/issues/5339))

- **Constrains:** [#5334](https://github.com/AtlasDevHQ/atlas/issues/5334) — the extraction cascade, and every model-training item under it ([#5336](https://github.com/AtlasDevHQ/atlas/issues/5336), [#5337](https://github.com/AtlasDevHQ/atlas/issues/5337), [#5338](https://github.com/AtlasDevHQ/atlas/issues/5338)).
- **Protects:** [`docs/prd/company-atlas.md`](../prd/company-atlas.md) commitments 1, 2 and 7 and finish conditions 2, 5 and 7.
- **Depends on:** [ADR-0036](./0036-atlas-as-company-brain.md) (the substrate and trust tiers), [ADR-0037](./0037-claim-identity-in-the-brain.md) (claim identity), [ADR-0024](./0024-regional-identity-isolation.md) (the process is the region).

Two proposals will arrive, and both are the obvious thing to build:

> *"We have a fact graph and an OSS model — fine-tune the company's facts into the weights."*

> *"We have thousands of workspaces of episodes. That's our training set."*

Both are refused. This is written **as a prohibition rather than a preference**, in the posture `lib/brain/alias-proposal.ts` already uses (*"stated as a prohibition rather than a preference because it is the obvious thing to build"*) and `lib/brain/reconcile.ts` after it (*"stated as a prohibition because someone will propose read-time matching later"*). The supported answer is the cascade itself: **fine-tune the pipeline, retrieve the facts, and train on data nobody entrusted to us.**

## Prohibition 1 — fact content never enters model weights

Not because generation is unreliable. Because four structural properties the fact store is built on have no representation in a checkpoint.

**Commitment 7 (entitlement).** Every fact carries `visible_to`, derived at ingest, widened at publish by `widenGrantFromEvidence`, with a fail-closed push-down predicate and the `chk_brain_facts_grant_nonempty` CHECK behind it. **Weights have no ACL.** The store's failure bias is over-restriction — a grant that is too narrow shows up as a fact somebody cannot see, which is a complaint. Generation's failure bias is the other way: it completes. There is no version of "the model knows the claim but declines to say it to this reader" that is enforceable at the row level, and row-level is the level the commitment is made at.

**Finish condition 7 (revocation is real) — "within one sync cycle, with no manual step."** Weights cannot unlearn. `lib/db/purge-scope.ts` and `residue-sweep.ts` exist precisely so a deletion is *complete*, and a checkpoint is outside the reach of both. It is also an ADR-0024 problem: the process is the region, but a checkpoint is a **file**, and a file is exactly the artifact that travels.

**Finish condition 2 (a human name on every claim).** Weights carry no `provenance` jsonb and no `source_episode_id`. `chk_brain_facts_provenance_nonempty` becomes decorative the moment an answer comes from the weights instead of from a row — the CHECK still passes on every row, and the answer did not come from a row.

**Finish condition 5 (the past is legible).** `valid_from`/`valid_to` plus `supersedes` edges give an as-of read: *what did we believe in March.* A checkpoint is one frozen snapshot with no time axis, and re-training to move the axis is not a read.

**Commitments 1 and 2 (will not guess; will not decide who is right).** Weights interpolate — that is what they are for. An unsurveyed region of the graph gets a plausible completion rather than *"Atlas does not know"*, and training over both arms of an `in-tension-with` pair resolves the tension **by frequency**, which is the one arbitration the product promises never to perform.

### Per-workspace local adapters are refused too

The tempting narrower version is *"each install fine-tunes on its own data, and the adapter never leaves the install."* It solves **cross-tenant** leakage and nothing else.

Within one workspace `visible_to` still varies per fact — that is the whole point of a grant. An adapter that memorised a private-channel claim can surface it to someone in the same org who was never in that channel. Purge still cannot reach it. Provenance is still absent. It narrows the blast radius from cross-tenant to intra-tenant and leaves **all three** structural objections standing.

## Prohibition 2 — customer data is never a training corpus

The same argument one level up. It gets its own line because the escape hatch is genuinely tempting: a model trained on *task behaviour across tenants* — "what does an assertion look like" — really is safer than a per-workspace knowledge adapter.

Safer is not a guarantee. **Models memorise training data.** "Low probability of verbatim leakage" is not the standard commitment 7 sets, and a workspace's episodes are the specific thing they trusted us to hold. Putting them somewhere `purge-scope.ts` cannot reach is the objection Prohibition 1 already makes; the fact that the path runs through a task model rather than a knowledge model does not change where the bytes end up.

### What we train on instead

| Source | Role |
|---|---|
| **Public conversational corpora** | Primary. GitHub issue/PR threads are structurally closest to the target distribution — real assertions about ownership, status, decisions and deprecations, in messy async text. Public mailing lists (Apache, LKML) are the same profile. Ubuntu Dialogue for chat shape; AMI/ICSI once transcripts are a source class. |
| **Our own workspace** | The distribution anchor. Public corpora teach what an assertion *is*; our own Slack teaches what **Slack** is — the `^^^ this`, the bare `k`, the thread-reply shapes GitHub does not have. Ours to consent to, and the consent is real rather than construed. |
| **Teacher labels over both** | Frontier extraction supplies the SPO labels. Real inputs, model-generated labels, no customer data anywhere in the pipeline. |
| **Opt-in contribution** | Possible later, explicitly, off by default, per-workspace revocable. Not assumed here, and **not required for the base model to work** — if it were, this table would be a plan to ask for it under pressure. |

**Synthetic inputs are not the answer either.** Synthetic *labels* over real episodes is distillation and is fine — that is the teacher row above. Synthetic *inputs* — invented messages — fail because the clean, well-formed text a model generates is nothing like real chat, and a filter trained on it misses exactly the messy cases that matter. Per fog item 1 on [#5343](https://github.com/AtlasDevHQ/atlas/issues/5343), that failure is the **invisible** kind: the eval looks fine because the eval is drawn from the same clean distribution.

## Development fixtures are a different use, and are permitted

A distinction the blanket prohibition would otherwise swallow, and it matters for [#5354](https://github.com/AtlasDevHQ/atlas/issues/5354):

| Use | What it touches | Verdict |
|---|---|---|
| **Training corpus** — teaching a model a distribution | ends up in weights we ship | governed by Prohibition 2 |
| **Development fixture** — testing deterministic code against realistic input | nothing leaves the developer's machine; no shipped artifact carries it | **permitted** |

Parsing, quoted-reply stripping, signature detection, threading, encoding edge cases, truncation behaviour — that is **code correctness**, the same category as testing a PDF parser against public PDFs. And note the inversion, because it reads as a contradiction until it is stated: **synthetic input is wrong for training and correct for parser tests.** A parser either handles a divider or it does not, so what a parser test needs is *shape coverage*, not distributional realism.

### On the Enron corpus specifically

~500k internal emails; the only large public body of real corporate mail; irreplaceable for getting the email connector right, because GitHub threads do not quote inline and mailing lists lack CC semantics and private-disclosure shapes.

It is also public only because a federal investigation seized it. **Nobody in it consented.** For a product whose pitch is *"your proprietary data stays yours"*, that asymmetry should be decided deliberately here rather than discovered later in somebody else's due diligence.

The resolution: **Enron as a local development fixture — yes. Enron as extractor training data — no.** And under no circumstances committed to this repository, which is public: committing real people's private mail republishes it under AGPL. Use it locally to discover the shapes; encode those shapes as small hand-written fixtures, and commit **those**.

## The train/measure split

**Train on public and first-party data. Measure on real data.**

Training data ends up in the weights — that is the leak surface. Evaluation data is read once and discarded. So [#5338](https://github.com/AtlasDevHQ/atlas/issues/5338)'s held-out set may legitimately be real gate decisions — ours, or a customer's with explicit consent — while the training corpus stays entirely non-customer.

It is also a far easier consent conversation, and that is a feature rather than a rationalisation: *"we will measure against 200 of your reviewed claims"* versus *"we will train on your archive."*

## The line, and the test for it

- **Prohibited:** fact content in weights; per-workspace knowledge adapters; customer episodes as a training corpus.
- **Supported:** fine-tuning *task behaviour* — triage classification ([#5336](https://github.com/AtlasDevHQ/atlas/issues/5336)) and episode→SPO extraction ([#5337](https://github.com/AtlasDevHQ/atlas/issues/5337)) — on public and first-party data; and using any lawfully-obtained corpus as a **local development fixture**.

The test: **does the model produce a claim, or does it produce a candidate the record still has to accept?** The second is inside the line. A distilled extractor emits `FactCandidate[]`, which `reconcileFacts` writes as a **draft** and a human still has to publish — every gate in the pipeline is downstream of it and unchanged. A knowledge adapter emits the answer.

### Entity resolution is not on the supported list

Named explicitly, because it is the next thing someone will add to it. `alias-proposal.ts` and `reconcile.ts` already prohibit resemblance-based matching, and the prohibition was **falsified on this repo's own corpus**: `led_by` and `leads` are inverse relations and are the top-ranked pair any similarity detector returns. A fine-tuned model is a similarity detector wearing better clothes; being better at resemblance does not make resemblance the right signal.

## Consequences

- **The cascade's model work is scoped to the pipeline, not the content.** #5336 and #5337 stay in scope exactly as written; nothing under #5334 is blocked by this ADR.
- **A corpus-acquisition step is now a prerequisite** for #5337 rather than an afterthought, since "just use our episodes" is closed. That cost is real and belongs in that ticket.
- **Our own workspace becomes a first-party data asset with a consent obligation to itself** — the Slack we train on is the Slack our own facts come from, and that is the one place where "opt in" is a decision we can actually make.
- **Someone will propose the local-adapter version as a compromise** after the first refusal, because it sounds like it splits the difference. It does not; the intra-tenant reasoning above is the answer, and it is the same answer.

## What would have to change for this to be revisited

Stated so the prohibition is falsifiable rather than permanent by assertion. Both prohibitions rest on capability claims about weights, and both would be reopened by weights that can:

1. **Carry per-row ACLs** that are enforced at generation time, not filtered after it — so `visible_to` survives the trip into the model, and over-restriction stays the failure bias.
2. **Be selectively unlearned** on a bounded schedule, verifiably — so finish condition 7's *"within one sync cycle, with no manual step"* can be said about a checkpoint without lying.

A third property — per-claim provenance surviving into generation — would be needed for the *answer* path specifically, though (1) and (2) are what gate storage at all. Approximate unlearning that reduces recall probability does **not** satisfy (2): the commitment is that the fact is gone, not that it is unlikely.

See also: [ADR-0036](./0036-atlas-as-company-brain.md) (the substrate) · [ADR-0037](./0037-claim-identity-in-the-brain.md) (claim identity, and why cardinality stopped being a model's decision) · [ADR-0024](./0024-regional-identity-isolation.md) (the process is the region; a checkpoint is a file) · [ADR-0043](./0043-the-company-keystone-is-asked-for-never-researched.md) (the same shape one level up: research drives the question, never the claim) · [`docs/prd/company-atlas.md`](../prd/company-atlas.md).
