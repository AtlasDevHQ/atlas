# Deployment posture

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-17 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)).
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).

## The posture, as of 2026-08-18

**The pre-customer clean-break window is CLOSED.** Expand-contract is the default for
schema, contracts and behaviour. There is no standing authorization to break anything.

| | |
| --- | --- |
| **Schema** | Two-phase only. Stop reading/writing in release N, drop in N+1. **Already CI-enforced** — `scripts/check-migration-rename-discipline.sh` rejects a newly-added single-phase `DROP COLUMN`/`RENAME COLUMN`. Recipe: [migrations README](../../../packages/api/src/lib/db/migrations/README.md) |
| **Contracts** | REST, MCP and the plugin SDK change additively. A breaking change needs a version or a shim, and `v1.0.0` is the tag reserved for freezing them ([ADR-0008](../../adr/0008-versioning-and-release-tags.md)) |
| **Deprecation** | Removing a surface people can reach needs a shim and a release of overlap, not a deletion |

Reopening any of these is a **positive, dated act by the maintainer**: edit this file, state
the basis, and say which of the three rows it reopens. Nothing else reopens it — not a
convenient milestone, not "we think nobody uses it".

## Why it closed, and why this is not a judgment call

The window was declared on **2026-05-19** on one basis: *"Atlas SaaS is deployed to two real
Workspaces only… **No external customers.**"* Three things ended it, and only the first is
an opinion.

**1. The tree says the machinery of having customers shipped.** `v0.1.0 — Public Launch` was
tagged **2026-07-24**, two months after the stamp; `v0.2.9` shipped 2026-08-16. Prod runs
three residency regions with open self-serve signup (the `verify-prod-signup` runbook),
Stripe subscriptions with overage metering, and abuse-prevention/SLA surfaces.

**2. Its central grant was already revoked, a month after it was written, and nothing
noticed.** The window granted *"schema migrations can hard-drop"*. On **2026-06-18**
`scripts/check-migration-rename-discipline.sh` landed ([#3686](https://github.com/AtlasDevHQ/atlas/issues/3686))
and CI has rejected single-phase drops on every new migration since. That gate's own header
names migration `0133_approval_origin_rename.sql` as the last clean break it was willing to
authorize — *citing this posture as what authorized it* — and says it exists to "stop the
pattern from RECURRING once customers exist." So an enforced gate and a standing
authorization contradicted each other for two months. **The gate wins, because it is the
thing that actually runs.** Closing the window ratifies what CI already does.

**3. A posture keyed on an unrecorded fact can never be re-verified.** *"No external
customers"* is operational; no file in this repo records it, by design. So no gate can ever
check this section, and it would stay a standing authorization that nothing measures — the
exact defect class [docs/agents/practices.md](../../agents/practices.md) was written about,
sitting in the document that authorizes destructive change. Closed, it becomes a default a
gate already enforces.

**The risk is asymmetric, which settles the residual doubt.** Acting as though the window is
open when it is closed hard-drops a column out from under a real customer — unrecoverable.
Acting as though it is closed when it is open costs one shim you did not need — cheap,
reversible, and CI was going to make you write it anyway.

> ⚠️ **Rows 2 and 3 are a policy choice, not just ratification.** Row 1 (schema) merely
> writes down what `check-migration-rename-discipline.sh` has enforced since 2026-06-18.
> Rows 2 and 3 have no equivalent gate, and closing them is a decision: open self-serve
> signup across three regions means somebody is integrating against those contracts now,
> and `v1.0.0` being *reserved* for contract freeze says they will keep moving — which is an
> argument for shims, not against them. If that friction is not wanted, reopening row 2 or 3
> is an edit to the table above, dated, and does not touch row 1.

## What this means for the six ADRs that cite it

[ADR-0007](../../adr/0007-unified-install-pipeline.md),
[ADR-0015](../../adr/0015-agent-origin-not-surface.md),
[ADR-0022](../../adr/0022-cross-group-reach-llm-composition.md),
[ADR-0024](../../adr/0024-regional-identity-isolation.md),
[ADR-0027](../../adr/0027-executesql-over-rest-security.md) and
[ADR-0035](../../adr/0035-retire-the-notebook-surface.md) each took a clean break on this
posture's authority. **They stand exactly as written.** They are records of decisions
already made, and a decision made under a window that was open at the time does not become
wrong when the window shuts. What changes is only that the authority is no longer available
to *new* work.

ADR-0022 asked for exactly this: *"re-verify the posture still holds at build time."* This
is that re-verification, and the answer is no.

## The superseded text, for the record

The section below is the 2026-05-19 posture verbatim, kept because six ADRs cite it and a
reader arriving from one needs to see what they were granted. **It is history. Nothing in it
is currently in force.**

> Atlas SaaS is deployed to two real Workspaces only: the maintainer's internal team and an internal demo team. **No external customers.** This is the "pre-customer clean-break" window — schema migrations can hard-drop, API contracts can change without versioning, no deprecation shims needed. The precedent is the #2620 / #2626 / #2634 / #2641 sequence, all clean breaks.
>
> The implication for upcoming work, including the Multi-Adapter SaaS Readiness milestone: prefer the architecturally correct shape over the migration-preserving one. The cost of a wrong-shaped contract that ships and then needs a v2 dwarfs the cost of breaking the two internal Workspaces today.
>
> This posture has a deadline: the first external customer onboards. Anything in flight by then has to lock its contracts. Until then, the door is open.
