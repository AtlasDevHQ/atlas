# Context Map

Atlas uses the **multi-context** domain-doc layout (adopted 2026-08-17). This file names
every bounded context and points at the `CONTEXT.md` that governs it. Consumer rules:
[docs/agents/domain.md](docs/agents/domain.md).

## Status: the layout is adopted, the split is not done

⚠️ **Read this before following any path below.** Exactly one context file exists today —
[`CONTEXT.md`](CONTEXT.md) at the repo root, ~85 KB across 18 sections. It governs **every**
context in the table. No `docs/contexts/**/CONTEXT.md` has been extracted yet, and this map
deliberately does not pretend otherwise: it lists no path that does not exist.

A map naming files that were never written would be the same defect this repo spent
2026-08-17 removing from its agent docs — a pointer that reads as authoritative, sends you
nowhere, and stops you searching. When a context is extracted, move its row's *Governed by*
cell to the new path in the same commit that creates it.

Tracking issue for the split: **[#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)**.

## Contexts

Derived from `CONTEXT.md`'s own section structure — these are the seams the domain doc
already uses, not a new taxonomy imposed on it. Note they cut **across** workspace packages;
the Company Atlas context alone spans `packages/api/src/lib/brain/**`, `/admin/brain` in
`packages/web`, and its migrations.

| Context | Governed by | Notes |
| --- | --- | --- |
| Pillars (the product's four-pillar frame) | `CONTEXT.md` § Pillars | the frame the rest hangs off |
| Company Atlas | `CONTEXT.md` § Company Atlas | ADR-0038; stored as `brain_*`, see the two-vocabulary rule |
| Chat Platform mechanics | `CONTEXT.md` § Chat Platform mechanics | eight adapters |
| Chat turn presentation | `CONTEXT.md` § Chat turn presentation | |
| Conversation scope | `CONTEXT.md` § Conversation scope | |
| Knowledge Base mechanics | `CONTEXT.md` § Knowledge Base mechanics | ADR-0028 |
| Semantic layer scoping | `CONTEXT.md` § Semantic layer scoping | |
| Semantic improvement | `CONTEXT.md` § Semantic improvement | |
| Learned query patterns | `CONTEXT.md` § Learned query patterns | |
| Query Cache | `CONTEXT.md` § Query Cache | |
| Dashboard editing | `CONTEXT.md` § Dashboard editing | ADR-0029, draft-first |
| MCP & agent governance | `CONTEXT.md` § MCP & agent governance | ADR-0016, ADR-0018 |
| Plugin lifecycle | `CONTEXT.md` § Plugin lifecycle | |
| Install models | `CONTEXT.md` § Install models | |
| Deployment posture | `CONTEXT.md` § Deployment posture | dated 2026-05-19 — verify before trusting |
| Operator vs Customer | `CONTEXT.md` § Operator vs Customer | |
| Lead source (CRM acquisition) | `CONTEXT.md` § Lead source | |
| Notebooks | `CONTEXT.md` § Notebooks (retired) | **retired** — read only for history |

System-wide decisions stay in [`docs/adr/`](docs/adr/) (41 ADRs). A context gets its own
`docs/adr/` only once it has a decision that is genuinely local to it.
