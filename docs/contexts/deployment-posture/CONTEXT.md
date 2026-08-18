# Deployment posture

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-17 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Deployment posture (as of 2026-05-19)` section verbatim — only the relative links are repathed for the new depth — and it is no longer there.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).

> ## ⚠️ Re-verified 2026-08-17 — and the answer is that this section is STALE
>
> #5302 requires this posture to be re-verified against the tree or marked stale at
> extraction. It cannot be verified from the tree: *"no external customers"* is an
> operational fact about who has signed up, and no file in this repo records it. What the
> tree does show is that the window this section describes has probably closed:
>
> - **`v0.1.0 — Public Launch` was tagged 2026-07-24**, two months after this section's
>   stamp and three weeks before this re-check. `v0.2.9` shipped 2026-08-16.
> - Prod runs three residency regions with open self-serve signup (`/release`, the
>   `verify-prod-signup` runbook), Stripe subscriptions with overage metering, and
>   abuse-prevention/SLA surfaces — the machinery of having customers.
>
> **Treat "pre-customer clean-break" as EXPIRED until the maintainer restates it**, and do
> not authorize a hard-drop migration or an unversioned contract change on the strength of
> this section. Six ADRs lean on it (0007, 0015, 0022, 0024, 0027, 0035) — ADR-0022
> already says *"re-verify the posture still holds at build time"*, which is this check.
> Restating it means editing this file with a new date and the basis for the claim.


Atlas SaaS is deployed to two real Workspaces only: the maintainer's internal team and an internal demo team. **No external customers.** This is the "pre-customer clean-break" window — schema migrations can hard-drop, API contracts can change without versioning, no deprecation shims needed. The precedent is the #2620 / #2626 / #2634 / #2641 sequence, all clean breaks.

The implication for upcoming work, including the Multi-Adapter SaaS Readiness milestone: prefer the architecturally correct shape over the migration-preserving one. The cost of a wrong-shaped contract that ships and then needs a v2 dwarfs the cost of breaking the two internal Workspaces today.

This posture has a deadline: the first external customer onboards. Anything in flight by then has to lock its contracts. Until then, the door is open.
