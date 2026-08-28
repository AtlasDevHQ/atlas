# Acquiring the extractor training corpus

**Status: draft — research for [issue 5381](https://github.com/AtlasDevHQ/atlas/issues/5381), written 2026-08-28.**
The [ADR-0044](../../docs/adr/0044-fact-content-never-enters-model-weights.md) prerequisite for the distilled extractor ([issue 5337](https://github.com/AtlasDevHQ/atlas/issues/5337)): ADR-0044's Consequences section makes corpus acquisition *"an explicit prerequisite … since 'just use our episodes' is closed."* This document names the candidate corpora with their licence terms verified against primary sources, frames the two decisions only a human can make, and states what the corpus may and may not be used for. It decides neither human question.

Every licence claim below carries its source URL and the load-bearing quoted phrase, retrieved 2026-08-28 unless noted. Where a term is ambiguous it is called ambiguous; nothing is papered over, and corpora whose terms refuse the use are listed and ruled out rather than silently omitted.

---

## Candidate corpora

The target distribution, per ADR-0044's table: *"real assertions about ownership, status, decisions and deprecations, in messy async text."* Columns: may the raw text be **stored in our own infrastructure**, and may **derived model weights ship commercially**.

| Corpus | Profile match | Licence basis | Store in our infra? | Commercial derived weights? | Source + load-bearing term |
|---|---|---|---|---|---|
| **Apache mailing-list archives** (lists.apache.org) | Strong — async project mail: ownership, status, decisions, deprecations | ASF public-archives policy + Apache License 2.0 §1's Contribution definition | **Yes** — ASF itself notes *"numerous third parties independently archive nearly all of our public mailing lists"* | **Yes, on the ALv2 theory** (attribution/notice obligations only; see ambiguity note 1) | [apache.org/foundation/public-archives.html](https://www.apache.org/foundation/public-archives.html): posts are *"deemed to be published by the sender of that communication and made public without conditions"*. [ALv2 §1](https://www.apache.org/licenses/LICENSE-2.0): "submitted" includes *"communication on electronic mailing lists … managed by, or on behalf of, the Licensor … but excluding communication that is conspicuously marked … as 'Not a Contribution.'"* |
| **ASF projects' GitHub issue/PR threads** (github.com/apache/\*) | Strongest — exactly the GitHub thread shape ADR-0044 calls *"structurally closest"* | Same ALv2 §1 theory: "submitted" also covers *"issue tracking systems that are managed by, or on behalf of, the Licensor"* | **Yes, on that theory** — and collection via the GitHub API sidesteps the scraping clause: the AUP states *"Scraping does not refer to the collection of information through our API"* | **Yes, on that theory** (ambiguity note 1) | ALv2 §1 as above; [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies) for the API carve-out |
| **GitHub threads at large** (GH Archive / GitHub-wide) | Strongest structurally | **None that covers the use.** GH Archive states no dataset licence at all (verified: [gharchive.org](https://www.gharchive.org/) carries no licence statement). GitHub ToS D.5 licenses other users to *"use, display, perform and reproduce (by forking) Your Content through the Service as permitted by GitHub's functionality"* — reproduction **through the Service**, not in our bucket. The AUP research allowance is conditioned: *"use public, non-personal information from the Service for research purposes, only if any publications resulting from that research are open access"* — a condition shipped commercial weights do not meet | **Not licensed** — issue text is its authors' copyright; no grant reaches off-platform storage | **No written basis** | [GitHub ToS](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) §D.5; [AUP](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies) |
| **LKML via lore.kernel.org** | Strong — same profile as Apache lists | **Ambiguous.** Archives are clone-by-design (public-inbox, *"available to anyone via a simple git clone"* — [kernel.org/lore.html](https://www.kernel.org/lore.html)), but kernel.org's own footer states *"Comments and public postings are copyrighted by their creators"* and no written reuse grant covers the discussion **prose**. Patches are GPLv2 via the DCO; the prose around them — the part this corpus wants — is not | **Yes in practice** (cloning is the designed access path), **unlicensed in writing** | **No written basis** — implied-licence/fair-use arguments only | [kernel.org/lore.html](https://www.kernel.org/lore.html); [korg.docs.kernel.org/lore.html](https://korg.docs.kernel.org/lore.html) |
| **Ubuntu IRC logs / Ubuntu Dialogue Corpus** | Good for **chat shape** (ADR-0044: *"Ubuntu Dialogue for chat shape"*) — not for Slack idiom | Community statement of public domain: the [IRC Guidelines](https://wiki.ubuntu.com/IRC/Guidelines) say *"the contents of all channels are considered to be in the public domain"*; the [IRC Terms of Service](https://wiki.ubuntu.com/IRC/TermsOfService) have participants agree *"to have anything you send to the channel publicly stored or processed on http://irclogs.ubuntu.com/, or other external sites."* ⚠️ **No formal dedication (CC0 or similar) was found**: [irclogs.ubuntu.com](https://irclogs.ubuntu.com/) itself carries no licence statement, and downstream repackagings (e.g. Common Pile's `ubuntu_irc` card) assert public domain **without citing an authority** | **Yes** — "other external sites" is explicit | **Probably yes** — informal-PD basis, flagged as such | URLs as quoted; the Lowe et al. corpus construction is [arXiv:1506.08909](https://arxiv.org/abs/1506.08909) |
| **Stack Exchange data dumps** | Moderate (Q&A, not async decision threads) | **Ruled out at the acquisition point.** Content is CC BY-SA 4.0, but since 2024 the dump download sits behind a login and an agreement not to use the content for LLM training — reported with the company's own words, *"We are asking politely that you not"* — and CC BY-SA's ShareAlike interacting with shipped commercial weights is additionally unsettled (ambiguity note 2) | Dump agreement refuses the use | **Refused by the access agreement; SA question unsettled besides** | [devclass.com 2024-07-30](https://devclass.com/2024/07/30/stack-exchange-restricts-access-to-dump-of-user-contributed-data-as-critics-complain-license-permits-reuse-for-any-purpose/) |
| **AMI Meeting Corpus** | Future — transcripts source class per ADR-0044 (*"AMI/ICSI once transcripts are a source class"*) | **CC BY 4.0**: *"The AMI corpus and its annotations are released under the Creative Commons Attribution 4.0 license agreement"* | **Yes** | **Yes, with attribution** (ambiguity note 2 on where attribution must ride) | [groups.inf.ed.ac.uk/ami/corpus/license.shtml](https://groups.inf.ed.ac.uk/ami/corpus/license.shtml) |
| **ICSI Meeting Corpus** | Future — same class | **CC BY 4.0**: *"The ICSI corpus and its annotations are released under the Creative Commons Attribution 4.0 license agreement"* | **Yes** | **Yes, with attribution** | [groups.inf.ed.ac.uk/ami/icsi/license.shtml](https://groups.inf.ed.ac.uk/ami/icsi/license.shtml) |
| **Enron corpus** | Real corporate mail — and **prohibited as training data by ADR-0044** regardless of licence | Made public by FERC during a federal investigation; CMU distributes with a request, not a licence: *"please be sensitive to the privacy of the people involved"* | Local developer machines only (see restatement below) | **N/A — never training data** | [cs.cmu.edu/~enron](https://www.cs.cmu.edu/~enron/) |
| **Our own workspace Slack** | The **distribution anchor** — ADR-0044: *"our own Slack teaches what Slack is"* | First-party; requires the explicit recorded consent decision in card 1 below | Pending card 1 | Pending card 1 | ADR-0044 §"What we train on instead" |

**Recommended set:** Apache mailing lists + `apache/*` GitHub issue/PR threads as primary; Ubuntu IRC/Dialogue for chat shape; AMI/ICSI held for the transcript source class; own Slack pending card 1. **Ruled out:** Stack Exchange (access agreement refuses LLM training), GitHub-wide/GH Archive (no licence reaches off-platform commercial training use), LKML prose (no written grant — revisit only with counsel).

### Ambiguity notes — stated, not settled

1. **The ALv2 "Contribution" theory is a reading, not settled law.** ALv2 §1 licenses what is *"intentionally submitted to Licensor for inclusion in the Work"*, with "submitted" defined to include mailing-list and issue-tracker communication *"for the purpose of discussing and improving the Work."* Off-topic list chatter arguably falls outside "for inclusion in the Work"; the ASF's separate *"made public without conditions"* sentence is a publication statement, not a formal copyright grant. This is the strongest written basis any conversational corpus offers — and it is still an argument, and card 2 should treat it as one.
2. **Attribution-family CC licences vs. shipped weights is an unsettled question industry-wide.** Whether trained weights are "Adapted Material" that must carry attribution (CC BY) or be ShareAlike-licensed (CC BY-SA) has no authoritative answer we could cite; nothing found in this research settles it. Mitigation for CC BY (AMI/ICSI): carry corpus attribution in the model card and distribution NOTICE regardless, which satisfies the obligation on either reading. For CC BY-SA (Stack Exchange) the SA arm has no such cheap containment — one more reason that row stays ruled out.

---

## Decision card 1 — our own workspace Slack (human decision; not made here)

ADR-0044: *"Ours to consent to, and the consent is real rather than construed"* — and the completion plan's Lane C carries the same requirement as *"an explicit recorded human consent decision, not an inference."*

**What exactly would be used:** message text from our own workspace's Slack channels — the same episodes our own install already ingests — as training **inputs**, with teacher-generated SPO labels over them. Scope dimensions the decision must fix: which channels (public only, or named private ones), what date range, and whether messages from departed members are included.

**The consent question, out loud:** *Does every person whose messages fall in the chosen scope agree, explicitly and on the record, that those messages may be used as training inputs for a distilled extractor whose weights ship commercially — knowing that models memorise training data and that a shipped checkpoint is outside the reach of `purge-scope.ts`?* (That last clause is ADR-0044's own framing of why weights are different from storage; consent given without it is not informed.)

| Option | What it buys | What it costs |
|---|---|---|
| **A. Full consent** — all public channels, every member signs, a dated record kept | The whole distribution anchor: *"the `^^^ this`, the bare `k`, the thread-reply shapes GitHub does not have"* | An all-hands ask; a consent register to maintain; a rule for offboarding (does consent survive departure? decide it now, because unlearning later is exactly what weights cannot do) |
| **B. Scoped consent** — named channels + date range, per-person opt-out | Most of the anchor at a smaller ask | Curation work; a thinner corpus; the same register and offboarding rule |
| **C. Decline** | No consent machinery at all | The anchor is lost. Ubuntu IRC covers generic chat shape but not Slack idiom; the student model meets Slack's register for the first time in production. ADR-0044 permits this outcome — the base model must work without opt-in data — but the eval on Slack-shaped input should then be expected to lag |

**Where the decision is recorded:** as a dated note on [issue 5381](https://github.com/AtlasDevHQ/atlas/issues/5381) or an ADR-0044 amendment — a written record either way, because the ADR's Consequences section names our own workspace *"a first-party data asset with a consent obligation to itself."*

## Decision card 2 — final corpus sign-off (human decision; not made here)

**The question:** *Is the recommended set — Apache lists, `apache/*` GitHub threads, Ubuntu IRC/Dialogue, AMI/ICSI later, own Slack per card 1 — with the two ambiguity notes above read and accepted, the set we train on and ship weights from?*

| Option | What it buys | What it costs |
|---|---|---|
| **A. Sign off the recommended set as-is** | Acquisition starts now; every row has a written basis, quoted above | Accepts ambiguity notes 1 and 2 as residual risk on a reading of ALv2 and an informal PD statement |
| **B. Sign off minus the informal rows** (drop Ubuntu IRC) | Only formally-licensed or ALv2-covered text remains | Loses the chat-shape corpus; if card 1 also lands on option C, no conversational-chat register is left at all |
| **C. Counsel review first** | A professional read on notes 1 and 2 before any download | Time — and note 2 is unsettled industry-wide, so counsel can bound the risk, not eliminate it; procurement stalls meanwhile, and this lane is the one item that *"does not compress by writing faster"* |
| **D. Expand (add LKML prose)** | More volume in the strongest profile | Adds the one row with **no** written grant; effectively forces option C |

---

## What the corpus may and may not be used for

Traceable line-by-line to ADR-0044.

**Permitted:**
- Training **task-behaviour** models on the acquired public + consented first-party corpus: triage classification ([issue 5336](https://github.com/AtlasDevHQ/atlas/issues/5336)) and episode→SPO extraction ([issue 5337](https://github.com/AtlasDevHQ/atlas/issues/5337)) — ADR-0044's supported list, verbatim: *"fine-tuning task behaviour … on public and first-party data."*
- **Teacher labels over real inputs** — *"Synthetic labels over real episodes is distillation and is fine."*
- Offline evaluation against the held-out split below.

**Prohibited:**
- **Customer episodes anywhere in training** (Prohibition 2), including "task-behaviour only" framings — *"Models memorise training data. 'Low probability of verbatim leakage' is not the standard commitment 7 sets."*
- **Fact content into weights**; **per-workspace adapters** (Prohibition 1 and its §"Per-workspace local adapters are refused too").
- **Synthetic inputs as a substitute** — *"invented messages … miss exactly the messy cases that matter"*, and the failure is the invisible kind (fog item 1 on [issue 5343](https://github.com/AtlasDevHQ/atlas/issues/5343)).
- **Training an entity-resolution / similarity model** on this corpus — ADR-0044: *"Entity resolution is not on the supported list."*
- **Enron in training, and Enron in this repository** — restated below.
- **Held-out data reaching any training run** — the train/measure rule below.
- **Committing any corpus text to this repository**, which is public and AGPL; acquisition lands in private storage per the path plan.

---

## Teacher-labelling spec

- **Teacher:** a frontier-class extraction model — functionally, the same class the production extractor resolves today — run against the **deployed contract verbatim**: `EXTRACTION_SYSTEM_PROMPT` as the system turn, `extractionPrompt`/`extractionExcerpt` shaping (including the `MAX_BODY_CHARS` cap and strip-then-truncate order), and `ExtractionSchema` (as `EXTRACTION_JSON_SCHEMA` on a batch wire) as the output shape — all from `packages/api/src/lib/brain/extract-contract.ts`. The student must learn the contract the product runs, not a variant of it; any drift between labelling prompt and production prompt is a silent domain shift.
- **Provenance per label batch, recorded in a manifest** beside the labels (JSONL, one row per batch): teacher model id, run date, sha256 of the system prompt and of the JSON schema, corpus snapshot id, and per-episode the source corpus + document id. This mirrors the production convention — `toFactCandidates` already stamps `detail: { extractor, model }` into every candidate *"because a later pass with a better model has to be tellable from this one."* The same reasoning binds a training label: a later re-labelling with a better teacher must be distinguishable from this one, batch by batch.
- **Batch economics:** a teacher run is offline tooling against a direct provider key, so a provider batch endpoint is usable here even though the hosted deployment's gateway has none (the Lane C finding on [issue 5352](https://github.com/AtlasDevHQ/atlas/issues/5352)).
- **Empty labels are labels.** The production prompt says *"an empty list is the correct and common answer"* — the no-fact episodes and their empty labels stay in the training set at natural incidence, because the filter behaviour is most of what the student is for.

## The held-out split

Per ADR-0044 §"The train/measure split": *"Train on public and first-party data. Measure on real data."*

1. **Reserve before training, at thread level.** Before any training run, a held-out slice of the labelled corpus — 2,000–5,000 episodes — is split off **by thread/conversation, never by message** (sibling messages of a training thread leak its content), sealed under a separate storage prefix, and never read by a training job. The split manifest (ids + sha256) is written at reservation time so "was this in training?" is answerable later by hash, not memory.
2. **The real-data eval set is separate again**: [issue 5338](https://github.com/AtlasDevHQ/atlas/issues/5338)'s held-out set of real gate decisions, exported by [issue 5335](https://github.com/AtlasDevHQ/atlas/issues/5335)'s `gate-export` operator subcommand — *"read once and discarded"*, never stored with the corpus and never labelled by the teacher.

## Enron, restated at the point of use

ADR-0044's resolution, verbatim: *"Enron as a local development fixture — yes. Enron as extractor training data — no. And under no circumstances committed to this repository, which is public: committing real people's private mail republishes it under AGPL."* Consequences for this plan: Enron does **not** enter the corpus bucket at all — the fixture use is *"nothing leaves the developer's machine"*, so each developer pulls it from [CMU](https://www.cs.cmu.edu/~enron/) directly, uses it locally to discover shapes, and commits only small hand-written fixtures encoding those shapes.

## Storage and path plan (the corpus is NOT in this repo)

- **Location:** a private object-storage bucket (working name `atlas-training-corpora`) in an account separate from customer-serving infrastructure — no tenant `DATABASE_URL`, no path through the product's residency regions, because this data is ours-and-public, not a customer's.
- **Layout:** `corpus/<name>/<snapshot-date>/raw/`, `…/labels/<batch-id>/`, `heldout/<name>/<snapshot-date>/`, each with a manifest (file list + sha256 + source URL + retrieval date + the licence quote for the snapshot). Snapshots are immutable; a re-crawl is a new snapshot, never an overwrite — the licence position of a corpus is dated evidence and must stay reconstructable.
- **This repository** carries only this document, the acquisition scripts if any are written, and the manifests' hashes if useful — never corpus text, never labels.

## Sizing — how much labelled data "done" needs

**Range: 30k–100k teacher-labelled episodes for training** (empty-label episodes counted in, at natural incidence), **plus the 2k–5k reserved held-out episodes**. Start acquisition targeting ~50k labelled and let the measured gap against the [issue 5338](https://github.com/AtlasDevHQ/atlas/issues/5338) baseline decide whether the top of the range is needed. Grounds:

- **UniversalNER** ([arXiv:2308.03279](https://arxiv.org/abs/2308.03279)) is the closest published analogue — open-schema entity extraction distilled from a frontier teacher (ChatGPT) into small students: **45,889 teacher-labelled passages** (240,725 entities, 13,020 types — figures per [this review](https://andlukyane.com/blog/paper-review-universalner); the paper PDF did not extract cleanly here, so the counts are second-sourced) produced 7B/13B students that beat their teacher on NER benchmarks. Our schema is far narrower than open NER, which pushes the need down; our students are smaller (1–4B), which pushes it up — smaller students generally need no less data.
- **Distilling Step-by-Step** ([arXiv:2305.02301](https://arxiv.org/abs/2305.02301)): a *"finetuned 770M T5 model outperforms the few-shot prompted 540B PaLM model using only 80% of available data"* — evidence that sub-1B students reach frontier few-shot quality on task-specific work with tens of thousands of examples when the labels carry teacher signal.
- **Why not less:** the dominant class is the empty label, and ADR-0044's fog warning is that clean-distribution evals look fine while missing messy cases — coverage of the messy no-fact/some-fact boundary across four registers (list mail, GitHub threads, IRC/chat, Slack) is what the volume buys. A 10k corpus drawn mostly from one register would eval well and generalize badly, which is the invisible failure [issue 5343](https://github.com/AtlasDevHQ/atlas/issues/5343) fog item 1 describes.
- **Teacher cost sanity check:** ~50k episodes at ~1k input tokens each is ~50M teacher input tokens plus small structured outputs — an offline, bounded, one-time cost, small beside the corpus-consent work (unverified estimate; priced when the teacher model is fixed).

## Open questions

1. **Card 1 and card 2** — the two human decisions above; nothing in this lane moves until card 2, and the Slack arm until card 1.
2. **Does counsel need to bless the ALv2 Contribution reading** (ambiguity note 1) before download, or is it accepted as recorded? Card 2 option C prices this.
3. **CC-attribution mechanics for shipped weights** (ambiguity note 2) — where the AMI/ICSI attribution rides (model card, NOTICE file, both) can be decided cheaply now; whether it is *required* stays unsettled industry-wide.
4. **Offboarding rule for Slack consent** — if card 1 lands A or B: does a departure revoke consent for future training runs? (It cannot revoke shipped weights — that is the informed-consent clause — so the rule only governs re-training.)
5. **`apache/*` scope cut** — which projects, and whether to require the repo to carry a `LICENSE` naming ALv2 (they do by policy; verify per repo at crawl time and record it in the snapshot manifest).
6. **LKML** — revisit only if volume in the mail register proves short *and* counsel is engaged anyway (card 2 option D).
