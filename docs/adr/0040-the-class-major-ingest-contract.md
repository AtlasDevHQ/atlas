# The class-major ingest contract: connecting is the one act, the class decides the rest

Status: accepted (2026-08-14, [#5200](https://github.com/AtlasDevHQ/atlas/issues/5200) grill — decision tickets [#5201](https://github.com/AtlasDevHQ/atlas/issues/5201)–[#5208](https://github.com/AtlasDevHQ/atlas/issues/5208) carry the full per-branch arguments)

When a person connects a source at its pillar, what the Atlas does with it is a property of the source's **class** — fixed by the class, inherited whole by every vendor in it, and not an admin choice. Different mechanisms per class; one act by the user. This was already the tree's under-executed commitment (`EPISODE_SOURCE_SPECS`'s class axis, ADR-0036 §T6's "class-major, plugin-shaped", ADR-0028's no-ingest warehouse tier); what was missing was the contract, and the cost of its absence was not hypothetical: Slack installed twice, and the second install nobody made is why M1's brain ingested nothing for four green days ([#5203](https://github.com/AtlasDevHQ/atlas/issues/5203) retired the double-install; this ADR generalizes what that fix proved).

## The two arms

Every class has two arms, and they never merge:

- **The availability arm** — automatic, fired by the pillar install, zero configuration. For episode classes: the stream starts, extraction runs, grants derive. For the warehouse: live tier-1 through the semantic layer, already the strongest connect-and-it-works in the product.
- **The authority arm** — deliberate, human, never automatic. For episode classes: the review gate. For the warehouse: enrollment plus the review gate ([ADR-0039](./0039-the-warehouse-producer-emits-only-what-a-human-enrolled.md), whose arithmetic this ADR leaves untouched).

**The contract automates availability and never automates authority.** Under that statement ADR-0039 is not an exception to "connect and it works" — it is the warehouse's spelling of the rule every class obeys. "The Atlas can use this source" (availability, instant on connect) and "the Atlas has materialized claims from it" (authority, enrolled and reviewed) are different verbs; conflating them is the only reading under which the two documents ever contradicted. Auto-enroll-on-connect stays refused for the same reason there is no auto-publish of extracted chat claims: it is the authority arm firing automatically.

## The contract, per class (T1)

| Class | On connect (at its pillar) | Extraction | ACL derivation | Perimeter |
|---|---|---|---|---|
| chat | episode stream starts (webhook + poll) | automatic | channel roster, live | bot membership minus admin exclusion list |
| transcript | episode stream starts | automatic | participant list — frozen roster, live resolution | granted recording scopes |
| email | episode stream starts | automatic | recipient lower bound, under-grant by design | mailbox list |
| warehouse | nothing to ingest — live tier-1 already works | never | semantic layer / whitelist authority | the whitelist |
| human | not connectable | never (#4915) | the person's own statement | — |

A vendor declares its class and inherits the class's trigger whole. Vendor variation is confined to **mechanics** — source-id grammar, scopes, API shape, install topology. A vendor that cannot fulfill its class's contract is refused or **visibly degraded** at install, never quietly narrowed. The admin's remaining authority is the **perimeter** — which spaces the Atlas may read and how much history (see backfill below) — a data-governance boundary, not a trigger choice.

**Declaration site:** a class-keyed sibling of `lib/brain/sources.ts` — a `Record<EpisodeSourceClass, ClassContract>` — not an extension of `EPISODE_SOURCE_SPECS`, whose keys are vendor-grained and would hand every vendor a slot to restate the trigger in, and whose blast radius (tier-1 refusal, the publish tier guard) must stay separate from contract policy. Record totality makes "class added without a contract" a compile error. **Future classes (docs/wiki/code/drive) get their contract as prose here and in ADR-0036's frame now, and in code the day the class arrives** — the dead-vocabulary rule (`sources.ts:179`) stands, and the Record forces the contract into the same one-line PR that adds the class.

**Enforcement — what makes M1's bug structurally impossible:**

1. **The trigger fires from the pillar install spine, not connector code.** Connector authors implement mechanics only; ingest-nothing-by-omission cannot be authored because the omission is not in the author's file.
2. **A per-class conformance harness** every connector must pass: completed pillar-install fixture → episodes with the right `source`, id grammar, and grant shape.
3. **Green is evidence, never configuration.** A source's status may be green only on a cycle that ran against this install and surfaced its count — zero included, honestly displayed. "Configured" is not a verdict; "observed" is.

## The taxonomy (T2): classes aren't pillars — installs are

The class axis is the Atlas's *evidence taxonomy*; the pillar axis is the *install-and-credential taxonomy*, and they never aligned 1:1 (chat episodes ride a Chat Platform install that exists for conversing). A pillar install triggers every class stream its granted credentials can produce.

**The Knowledge pillar's charter widens: from "descriptive document corpora" to "content corpora Atlas reads."** What a corpus lands — documents, episodes, or both — is decided by the class contract. Zoom transcripts and Outlook mail stay at `/admin/knowledge` but stop being smuggled; an episode-landing collection shows an episode count, not an eternally-zero document count. No fifth pillar (a pillar existing only to feed the Atlas would rebuild brain-as-pillar through the front door), no `plugin_catalog` CHECK migration, no Chat Platform widening (ADR-0006 scopes it to surfaces Atlas *converses on* — a distinction #5164 recorded as legally load-bearing). The pillar keeps its name (ADR-0038 pattern: stable nouns, copy explains). **Cost models split:** document-landing installs count against plan-capped collection slots; episode-landing installs stop consuming slots — their cost is extraction spend, bounded below.

**Two landings, one install (T7).** When the docs class arrives, a connected corpus lands documents *and* episodes as two parallel landings from the same source — neither derived from the other. ADR-0028 §1 is **confirmed verbatim**: a knowledge document is never extracted into a fact; the extraction cycle drains `brain_episodes` and nothing else. A doc-derived claim's provenance and ACL are the *source system's* (vendor + page identity; the page's effective audience), never the collection's Atlas-side config. Confluence connecting twice is thereby unrepresentable before M3's first docs connector, not after. **The episode landing belongs to connected corpora only**: a manually uploaded OKF bundle stays document-only — episodes record observed evidence from source systems, an upload is first-party curation, and the honest path for a person's own claims is `correct_fact` (the `human` class). Anything else turns "write a markdown file" into a claim-injection lane wearing evidence provenance.

## The cost bound (T5): steady state automatic, backfill priced at connect

- **Steady state** — new episodes flow and extract from the moment of connect. Contract, no opt-out.
- **Backfill** — reprocessing history is a separate, bounded, **priced choice inside the connect flow** ("last 30 days: ~N episodes, est. $X" — counts are enumerable from vendor APIs before any model call). Declining leaves the source fully working going forward. History depth is a perimeter question with a price tag, not trigger discretion. M1 was silence nobody chose; an unbounded backfill is spend nobody chose — the contract makes both impossible.
- **The bound: a per-workspace daily extraction budget, defer-not-drop.** Episodes are never discarded; the drain rate is what's bounded — the platform-wide fiber skips over-budget workspaces until the window resets, so four sources connected the same day compete inside one budget. Spend-against-budget and queue depth surface on `/admin/brain` *before* the cap bites. Self-hosted: generous default, settings-registry knob. SaaS metered on Atlas's key: a plan entitlement on the existing overage machinery.
- **Sampling: rejected.** "The Atlas learned from your Slack" must not carry an invisible asterisk about which conversations were skipped. PRD condition 5 is implemented by the perimeter and the backfill choice — scope a human can see — never by silent thinning.

## The ACL posture (T6): audience derivation is a prerequisite, not a switch

Connecting a private-capable source triggers episodes + extraction + audience derivation as one bundle; a state where ingest runs and audience sync doesn't is no longer representable. Three fail-closed postures:

1. **No fact without a derivable grant — defer, don't withhold.** An episode whose audience cannot currently be derived waits in the queue; it drains when both under budget *and* grant-derivable. "Extract now, grant later" is the machinery that produced facts granted to nobody. Deferral is over-restriction in time — the direction PRD condition 7 blesses.
2. **Missing scopes: visibly degrade to public-only.** Public spaces (workspace-scoped grant) ingest normally; private spaces are excluded from the perimeter — not ingested-and-hidden — with the missing scopes named on the install surface and "extend scopes" as the unlock.
3. **Sync health is install health.** *Suppressed ≠ denied* stays fail-closed but stops being silent: a failing audience cycle reds the install under the evidence rule, and grant-sweep orphan counts surface beside queue depth.

Over-disclosure now requires a wrong derivation — a real bug — never a missing switch, an absent scope, or a stale roster.

## The knobs (T4): the `ATLAS_BRAIN_*` env namespace goes to zero

Five die into the contract (`EXTRACTION_ENABLED` — whose default is re-decided as *no default, no knob*; the three `*_BACKFILL_DAYS` — becoming the at-connect priced choice; `AUDIENCE_SYNC_ENABLED` — becoming the prerequisite). `CHAT_WEBHOOK_ENABLED` becomes **capability detection**: webhook ingestion runs when the deploy's endpoint is reachable, and a poll-only deploy that structurally misses thread replies is a visible degrade, never an env var silently changing what a workspace's Atlas remembers. Three survive as operational tuning **in the settings registry, not env** (audience sync interval, staleness threshold, grant-sweep cadence — each with a stated reason a person would change it). The alias auto-approve pair rehomes as **workspace-scoped policy, off by default, fail-closed on settings-load failure** — a tenant trust dial on the learned-patterns precedent, and a human *delegating* a slice of the authority arm by explicit standing consent, which is not automation by default.

The general rule, maintainer-stated: env vars are a last resort — a good default first, the settings registry if a knob must exist, env only for boot and deploy-infrastructure facts.

## Consequences

- **ADR-0006 is amended** (Knowledge pillar charter; note added there). **ADR-0028 §1 and ADR-0039 are confirmed unchanged** — this ADR cites ADR-0039 inside the warehouse contract entry precisely so a future reader meets enrollment in the contract rather than "fixing" it as a violation.
- **Reshapes M3 (source breadth), not M5.** The warehouse class is the one where connect-and-it-works already holds; milestone #95 proceeds untouched.
- **Someone will propose making a class's trigger configurable.** It will arrive as a customer request ("can we connect Slack but not ingest it?"), a caution ("default extraction off until they opt in"), or a vendor shortcut (a connector shipping its own enable flag). Each is the pre-contract world back again: a configurable trigger is an undecided class contract, and M1's four green days are what an undecided contract costs. The perimeter is the pressure valve — scope is governable; the trigger is not.

## Alternatives rejected

- **Per-vendor triggers** — hands every connector author the contract pen; the M1 bug class ships again with the next vendor.
- **A fifth pillar for communication sources** — rebuilds brain-as-pillar; CHECK migration and admin surface for nothing.
- **Widening Chat Platform to swallow transcripts/mail** — Atlas does not converse in a Zoom recording; #5164 made the posts-into distinction legally load-bearing.
- **Backfill automatic with a cap** — spend nobody chose, arriving on connect; the cap converts a surprise bill into a smaller surprise bill.
- **Sampling as the cost bound** — silently falsifies "learned from your Slack".
- **Ingest-and-withhold for underivable audiences** — refills the queue-nobody-can-read that #4772 existed to end.
- **Refusing a class outright on missing scopes** — punishes public-channel value to protect private data that is never touched.
- **Episodes from uploaded bundles** — a claim-injection lane wearing evidence provenance; `correct_fact` is the honest path.

See also: [ADR-0036](./0036-atlas-as-company-brain.md) §T6 (the class-major frame this executes) · [ADR-0039](./0039-the-warehouse-producer-emits-only-what-a-human-enrolled.md) (the warehouse authority arm) · [ADR-0028](./0028-knowledge-base-fourth-pillar.md) §1 (confirmed) · `CONTEXT.md` → "Ingest contract" · [docs/prd/company-atlas.md](../prd/company-atlas.md) (conditions 5 and 7).
