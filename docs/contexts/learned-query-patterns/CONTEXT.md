# Learned query patterns

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Learned query patterns` section, moved unchanged except that
> relative links are repathed for the new depth. It is no longer in the root file.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


The capture-and-payoff loop through which SQL query shapes observed in live execution become reusable knowledge for the agent: successful queries are captured as pending patterns, promotion (human or machine) makes them injectable, and relevant approved patterns are injected into future agent prompts. Vocabulary pinned by the learned-patterns elevation grill (2026-07-10, audit `.claude/research/learned-patterns-audit-2026-07-10.md`).

- **Query pattern** — the durable unit of learned query knowledge: a normalized SQL shape captured from a successful live execution, scoped to one workspace and one connection group. Lifecycle `pending → approved | rejected`. The learned-patterns surface shows query patterns **only** — Amendments are a different concept that historically shares the storage table, reviewed exclusively on the improve surface (#4569).
  _Avoid_: "learned pattern" and "query pattern" as different things (one concept; "learned" describes how it was born); treating an Amendment as a kind of pattern or vice versa.

- **Approval (of a query pattern)** — a human grant of **injection eligibility**: "this pattern is correct — inject it whenever it's relevant." An approved-by-human pattern is always eligible regardless of confidence; relevance still decides which eligible patterns enter a given turn. Approval never rewrites confidence.
  _Avoid_: stamping a floor confidence on approve (overloads the evidence meter with a trust signal); an approval whose effect the admin cannot observe.

- **Confidence** — the machine's evidence meter for a query pattern, derived from observed repetition. It gates **machine** promotion and ranks retrieval; it is never written by human decisions and never encodes trust. Human approval and machine confidence are the two independent roads to injection eligibility.
  _Avoid_: reading confidence as correctness or human endorsement; any human action that mutates it.

- **Auto-promotion** — the machine road to injection eligibility: a **workspace-scoped, per-workspace opt-in, off by default** — the same SaaS-first posture as autonomous improvement, with self-hosted's single workspace as the degenerate case. Capture is always-on everywhere (it is free and deterministic); auto-promotion is the workspace's one trust dial. Decay is its counterpart and never touches human approvals.
  _Avoid_: a platform-scoped or env-only promotion switch (a tenant-behavior knob belongs in the workspace settings registry); "the loop is self-maintaining" on a workspace that hasn't opted in.

- **Injection** — the payoff act: eligible, relevant query patterns rendered into an agent turn's prompt. Every injection is **attributed** — which patterns entered which turn is recorded — so a pattern's usage is observable evidence, in the cockpit and for any future feedback design. Crediting adapted queries back to their source pattern, and demoting patterns on bad outcomes, are explicitly deferred until attribution data exists.
  _Avoid_: unattributed injection (an approval whose effect nobody can observe); inferring usefulness from confidence.

- **Pattern identity** — what makes two observations the *same* query pattern: (workspace, connection group, normalized SQL fingerprint), enforced by the database. A repeat observation increments the existing pattern — it can never mint a second row. A seen-once pattern is captured but sits below the default review queue and below every promotion gate until it repeats.
  _Avoid_: application-side read-then-insert as the only dedup; timestamp uniquifiers; a review queue full of seen-once noise.

- **Eligible set** — the workspace-and-group's injectable patterns, from which relevance picks per turn: every human-approved pattern unconditionally, plus machine-promoted patterns by confidence. Ordered human-approved first (they never fall off any cap), then confidence, then last-observed as the saturation tiebreak. Full-text retrieval is the recorded scaling exit, adopted on evidence (library size, attribution showing relevant-but-unfetched misses), not preemptively.
  _Avoid_: any pre-relevance truncation that can drop a human-approved pattern; an unspecified order among confidence ties.
