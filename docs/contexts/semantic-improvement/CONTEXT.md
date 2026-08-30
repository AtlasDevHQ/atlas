# Semantic improvement

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Semantic improvement` section verbatim — only the relative links are repathed for the new depth — and it is no longer there.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


The review loop through which AI-proposed changes to the semantic layer become real: an expert agent (interactive) or the scheduler (autonomous) proposes, an admin reviews, an approval applies.

- **Amendment** — the durable, reviewable unit of proposed semantic-layer change, and the *only* identity a proposed change has — the same one across every path that can create it (admin chat, scheduler, CLI). Lifecycle `pending → approved | rejected`, where **approved means applied**: a stamped-but-unapplied amendment is a bug, not a state.
  _Avoid_: "proposal" as a distinct noun — to propose is to create a *pending* Amendment; there is no second, in-memory thing. "Pattern" (the storage table's historical name).

- **Pending queue** — the org's pending Amendments; the single collection the review panel shows and the pending badge counts, regardless of which path created each Amendment. An Amendment created mid-conversation appears *in* the queue (marked as from this conversation), never in a parallel list.
  _Avoid_: "chat proposals" vs "pending amendments" as two collections — there is one queue with presentation markers.

- **Improvement conversation** — the admin's chat with the expert agent on the improve surface. It is a conversation, not a stored resource: nothing durable hangs off it except the Amendments it creates.
  _Avoid_: "improvement session" — implies a stored, addressable resource; there is none (deleted rather than made durable — any future resumability rides ADR-0020 durable agent sessions, never a bespoke store). The CLI's interactive loop keeps local REPL state; that is not a session either.

- **Rejection memory** — the org's rejected Amendment identities, which suppress re-proposal on every path (chat, scheduler, CLI). Enforced where an Amendment is created — a hit refuses the insert — never by prompt advice alone. A rejection is **permanent until an admin reconsiders it**; it does not age out.
  _Avoid_: time-windowed expiry; treating "the model was told not to" as suppression.

- **Reconsider** — the admin action that lifts a rejection: it returns a rejected Amendment to the Pending queue and removes its identity from rejection memory. The only way a rejected change comes back.
  _Avoid_: "unreject"; silent re-proposal by the agent (rejection memory forbids it by construction).

- **Anchor** — what an Improvement conversation optionally starts from: a **group**, an **entity**, or a **column**. The anchor scopes the agent's briefing and persists as context for the conversation; it is a launcher into the chat, never a cage — the admin can always converse free-form. A sweep ("find improvements") is simply the anchorless start.
  _Avoid_: modeling entry points as separate surfaces or modes — every entry point starts the same conversation with a different anchor.

- **Briefing** — the deterministic context the expert agent is handed at turn one of an Improvement conversation: health score, analyzer findings, audit-pattern summary, rejection memory, the Pending queue, and whatever the Anchor scopes in (a group's entity inventory, an entity's YAML, a column's profile). Served from tracked profiles with a staleness marker — never recomputed against the customer database just to start a chat.
  _Avoid_: making the agent rediscover deterministic facts through tool calls; "context dump" (the briefing is curated, anchor-scoped).

- **Dialect specialist** — engine-specific expertise (Postgres, MySQL, ClickHouse, …) as a composable prompt module keyed by dbType, shipped by the datasource plugin, and resolved into the conversation for the groups in scope. One agent, composed prompt: the specialist module knows the engine; the expert persona owns the semantic layer and Amendments.
  _Avoid_: separate per-engine agents handing off to each other; "the Postgres agent" as a distinct actor (it is a module in the one agent's prompt, in the same way an answer style is).

- **Baseline profile / LLM profile** — the two tracked tiers of knowing a connection. The baseline profile is cheap and deterministic (schema, types, counts, samples) and runs automatically when a profilable connection is created (REST datasources excluded). The LLM profile is the enrichment pass — never automatic, billing-gated, tracked per connection (when, over what).
  _Avoid_: one boolean "profiled"; running LLM enrichment implicitly.

- **Autonomous improvement** — the scheduler-driven mode: Atlas proposes Amendments on its own cadence for a workspace. Per-workspace opt-in, **off by default**, spending that workspace's own budget through the same billing gate as chat (agent origin `scheduler`), with new pending Amendments notified over the proactive seam. Entirely independent of interactive improvement — an admin reviews, converses, and approves without ever enabling autonomy. **Auto-approve is a second, separate opt-in on top of autonomy**, never implied by it.
  _Avoid_: gating the improve surface on the scheduler setting; "the scheduler is self-hosted-only" (it is SaaS-first; self-hosted's single workspace is the degenerate case, not a different model).

- **Live diff** — the diff an admin reviews, always computed against the entity's *current* baseline at render time. The propose-time diff stored on an Amendment is a record of intent, never the thing approved. A baseline that changes mid-review means one more human look at an updated live diff — a continuation of review, not an error.
  _Avoid_: approving the stored diff; auto-rebasing or "compatible change" heuristics (a changed baseline always gets a human look).

### Anti-confusions

- **Amendments refine; enrich grows.** Nothing an Amendment can do adds an entity or expands the queryable table set — that containment is what makes auto-approve and the scheduler safe to contemplate. A column or table with **no** semantic coverage is shown honestly as uncovered and routes to the enrich flow (a human-initiated act with whitelist consequences), never to an "add entity" amendment type.

- **Amendment approval IS the publish gate for that change.** Approving applies to the published entity directly — a recorded content-mode carve-out; the evidence-backed, admin-approved queue is review of publish grade, and routing its output into a second draft→publish wait would park approved changes invisibly. If a draft of the entity exists, the approve applies to the draft too (convergent by upsert-by-identity), so a later publish cannot clobber the approved change; a draft-side miss (the draft removed the target) is visibly skipped, never silent.

- **A glossary term binds to a group, and the glossary is amendable.** The glossary is a group-scoped document in the same semantic store as entities; a glossary Amendment (`add_glossary_term` / `update_glossary_term`) targets that document with the same lifecycle, rejection-memory identity, and eligibility rules as any other Amendment type — no special cases, and never a silent no-op (a type the apply cannot write must not be proposable).

- **Rollback-ability is part of the apply.** Every applied Amendment has a version snapshot to roll back to; a snapshot that cannot be taken fails the apply (the Amendment returns to pending with a visible reason) rather than proceeding without a rollback target.

- **Validation is a seam, not a tool.** An Amendment is validated where it is created (a proposal that fails never enters the Pending queue) and revalidated where it is applied (the post-apply document must parse as an entity; embedded SQL must parse as a query; each type may touch only its declared fields). Gates are code the payload must pass through, never advice the model may follow — there is no optional "validate" step whose verdict floats free.

- **An Amendment has exactly one workspace owner.** Every path that creates one stamps the workspace it belongs to; a NULL-owner row is legacy self-hosted data — tolerated on read there, never produced anew anywhere.
