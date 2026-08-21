# The Coverage Surface counts what it can see, and refuses the single number

Status: accepted (2026-08-14, milestone [#96](https://github.com/AtlasDevHQ/atlas/milestone/96) grill — the denominator grill the milestone was gated on)

PRD condition 6 requires one page from which an admin states what Atlas knows, how much it covers, and what it does not know — every part correct, at 4% as clearly as at 80%. The recorded blocker was the denominator: `oversight.ts` computes numerators only, and *"coverage of the company"* has no universe anywhere in the tree. This ADR decides what the denominator is, what it can never be, and the honesty rules the page lives under.

## The denominator is evidence-side

A "part of the company" on this surface is a **survey unit**: an enumerable atom of the company's *record-producing surface* — a chat channel, a mailbox, an enrolled (entity, dimension) pair. The map's structure follows the class taxonomy the ingest contract already owns (ADR-0040), not an organizational model.

The organization-side reading ("sales is well surveyed, engineering is thin") is **refused unless a human authors the mapping**. Atlas has no org chart; deriving one from channel names or SSO groups is a guess, and *it will not guess* is the PRD's first commitment. The subject-side reading is admitted exactly where a real denominator exists: the warehouse, whose semantic layer enumerates entities and whose enrollment (ADR-0039) names the surveyed subset.

**One atom per class, and the wire enforces it.** The atom is singular per class: `BrainCoverageRatioSchema.unit` is a closed enum carrying exactly one origin per class (`semantic-layer-enrollment` for the warehouse), which is what makes a blend *unspellable* rather than merely discouraged. A second atom for one class is therefore not a layout choice — it requires a fifth entry in the tuple that exists to prevent one. Recorded 2026-08-20 ([#5357](https://github.com/AtlasDevHQ/atlas/issues/5357)), where grouping the warehouse list by entity was proposed to make a 281-row card readable; see *Alternatives rejected*.

## Three states, and the third is a mark

Every survey unit is in exactly one state:

1. **Surveyed** — inside the perimeter, evidence actually observed. Green is evidence, never configuration (ADR-0040 rule 3).
2. **Enumerated** — the granted credentials can see it exists; nobody has put it in the perimeter.
3. **Unenumerable** — beyond granted scopes, or beyond connected sources entirely. The map edge. Shown as a **mark, never a number**: any denominator that includes it is fabricated.

Consequences, accepted deliberately:

- **Every denominator is credential-relative.** No count on this page ever has "the company" as its universe; the honest phrasing is *"of what Atlas's credentials can see."* The vendor-level company question ("do they use Teams too?") is answered only by the map-edge mark or by a human saying so.
- **Widening scopes grows the denominator**, so connecting more can make a ratio go *down*. That is correct behavior; the UI must not smooth it.

## No single number, permanently

There is no company-wide coverage percentage, score, or gauge — refused, not deferred:

- The layers are incommensurable (channels, mailboxes, entity-dimensions); any blend requires invented weights — editorial fiction wearing precision.
- A headline number creates perverse mechanics both ways: excluding units from the perimeter *raises* the score; widening scopes *lowers* it. A gauge would punish honesty and reward blindness.

Ratios exist only where numerator and denominator share one real unit ("8 of 23 enumerable channels"). The top of the page is the **composed statement** condition 6 demands — classes connected, per-class ratios, map edges — a paragraph, not a KPI. The pressure for one number will arrive (a dashboard ring, a sales deck); this section is the citable refusal.

## Counts always; labels by two clauses

The oversight rule — *an admin learns that facts exist they cannot see: a number, never content* — meets the denominator here, because the most useful state-2 display ("#incidents exists and is unsurveyed") names a channel no deliberate act ever touched. The resolution splits the rule:

- **Counts are always disclosable.** A denominator count carries no claim content and no audience content. This *extends* the #4825 unscoped-count sanction from fact aggregates to survey units — recorded here because that decision lives in `docs/development/brain-slack-history.md` scoped to facts, and must not be stretched silently.
- **A label appears only under one of two clauses:** the existing **deliberate act** clause (membership, exclusion, enrollment, install-form entry — unchanged from `classifyToken`), or **vendor-public existence** — the unit's existence is unconditionally visible to every member of the vendor workspace (a public Slack channel's name, by Slack's own definition). Vendor-public is a **per-class property declared in the class contract** (ADR-0040's declaration site), defaulting to *not* public — fail-closed, because the clause leans on each vendor's notion of "public."
- **Everything else is counted, never named**: mailboxes (naming a mailbox is naming a person), recording owners, individual persons. The email class's state-2 display is "N mailboxes enumerated, M surveyed" with no list.

Warehouse entities are freely namable — the admin authored the semantic layer they come from.

## Stale is a measured lag; thin is not a verdict

- **Stale** means *the source has moved since we last looked*: vendor activity metadata shows source movement newer than our newest observed evidence by more than the class's sync cadence — a divergence whose only constant is the cadence the class contract already owns. Whether a class *can* compute staleness is a per-class contract property beside the vendor-public flag.
- **Where activity metadata doesn't exist, or the pipe is sick, the unit is "unverified since \<date of last successful cycle\>"** — never "stale," which would guess in both directions.
- **Quiet ≠ stale**: a source that hasn't moved is current, however old its newest evidence.
- **"Thin" has no computed badge.** Counts are shown honestly; a thinness threshold would be Atlas deciding how much evidence a channel ought to produce. The judgment is the reader's.
- **No staleness knob** — not env, not the settings registry. A tunable threshold lets an admin define staleness away, and cadence-based lag needs no tuning.

## The surface

- **The Coverage Surface is the evolved `/admin/brain` overview**, not a new page — condition 6 demands one page, and building coverage beside an overview splits the statement across two. The existing backlog counts stay, reframed as the **authority arm's** half (observed, awaiting review) beside the **availability arm's** half (surveyed at all) — ADR-0040's two-arm vocabulary as page structure.
- **Admin-gated, same perimeter as the rest of `/admin/brain`; no new permission flag.** The unscoped counts exist under a sanction argued for admins specifically, and a new flag is implicitly denied to every already-seeded workspace's built-in roles (the #5188 regression class). Member-visible coverage would be a separate decision with its own disclosure argument.
- **A sibling module composing oversight, never folded into it.** `lib/brain/coverage.ts` reads oversight's numerators and adds denominators and staleness; the dependency is one-way. Oversight's remit (the ACL-asymmetry disclosure) and its counts-not-content discipline are shared, not merged.
- **Denominators come from scheduled cycles writing dated snapshots** (the `registerPeriodicFiber` pattern), read by the page and stamped "as of \<date\>" — never live vendor calls on page view. The page's correctness claim must not couple its availability to five vendors' rate limits, and the date is part of the statement.

## Correctness is the product

- **Oversight's fabrication discipline applies wholesale.** A silent zero here is a false statement, not an error state. Degradation travels to the wire; the page renders "cannot establish" arms; a failed snapshot load is "enumeration unavailable since \<date\>", never zero; the false-all-clear direction throws.
- **Totality at compile time**: the coverage representation is keyed `Record<EpisodeSourceClass, …>`, so a class added without a coverage answer is a compile error, not a silently missing row.
- **Adversarial fixtures by charter**: test vendor rosters are authored independently of the snapshots the page reads, and the named mutations each redden a specific assertion — remove an enumerated unit (loud understatement), backdate an observation past cadence (stale fires), plant vendor activity newer than our newest episode (lag is measured), sicken a pipe ("unverified since" replaces "stale"). A fixture where roster and snapshot come from one literal cannot falsify.
- **The milestone closes on a verified prod statement, not on merge** (the #5197 precedent): an admin reads the page on a real workspace and states what Atlas knows, covers, and does not know; each component claim is checked by hand against ground truth. Done means every part of the spoken statement checks out — at whatever low percentage it is actually at.

## Consequences

- The PRD's condition 6 and capability 7 get one clarifying edit each — "how much" is a composed statement, never a single percentage; "thin" is the reader's judgment from honest counts — so a future reader does not re-derive the blended score from the phrasing.
- Someone will propose the score. It will arrive as a dashboard ring, a marketing number, or "just an approximate blend." Each is the same proposal: a company-wide denominator that does not exist. The answer is this ADR.
- Classes without activity metadata will never show "stale," and the page will say "unverified" more often than a dashboard designer would like. That is the design working.

## Alternatives rejected

- **An org-chart denominator** (departments/teams, derived from channels or SSO) — a guess wearing a UI; violates *it will not guess*. Admissible only as a human-authored mapping, which is future work with its own surface.
- **A blended coverage score** — invented weights over incommensurable units; punishes scope-widening, rewards perimeter-narrowing.
- **A denominator that numbers the unenumerable** ("we estimate 40% of channels are invisible") — fabrication by construction; the map edge is a mark.
- **Live vendor enumeration on page view** — couples the page's availability to vendor rate limits; a dated snapshot is more honest anyway.
- **Thresholds for stale/thin** (fixed or knob-backed) — judgments wearing measurements' clothes; the only defensible constant is the class's own cadence.
- **A new workspace-permission flag for the page** — widens the #4825 sanction implicitly and denies itself to already-seeded built-in roles (#5188 class).
- **Folding coverage into `oversight.ts`** — merges two remits that share a discipline but answer different questions; the dependency stays one-way.
- **Naming enumerated-unsurveyed private units** (mailboxes, persons, private channels) — a new disclosure the numerator side already refused (`user:*` withheld).
- **A per-entity ratio for the warehouse class** (`organization — 4 of 6 surveyed`, grouping the unit list by entity) — proposed in [#5357](https://github.com/AtlasDevHQ/atlas/issues/5357) to make a 281-pair card readable. Refused on three grounds, in order of finality. It makes `entity` a **second enumerable atom for one class**, which the paragraph above says the wire cannot spell. The deliberate act that moves a pair from enumerated to surveyed is **enrollment, which is per-pair** (`inPerimeter = enrolled.has(unitId)`, per unit) — no entity is ever enrolled as a unit, so a per-entity ratio is a denominator over a set no admin acts on as a set. And it cannot be computed client-side at all: the roster orders `(state = 'surveyed') DESC, unit_label ASC` and the response caps at 200, so the clip falls on an **alphabetical** boundary — per-entity denominators would silently truncate at the cut and drop late-alphabet entities entirely. The readability problem is real, and is answered by bounding the *listing* (see `CONTEXT.md` → "clipped listing"), which introduces no denominator at all.

See also: [docs/prd/company-atlas.md](../prd/company-atlas.md) (condition 6, capability 7) · [ADR-0040](./0040-the-class-major-ingest-contract.md) (the class contract this declares properties in; green-is-evidence) · [ADR-0039](./0039-the-warehouse-producer-emits-only-what-a-human-enrolled.md) (the warehouse's surveyed subset) · [ADR-0036](./0036-atlas-as-company-brain.md) (the ACL asymmetry; the trust tiers) · `CONTEXT.md` → "Coverage Surface".
