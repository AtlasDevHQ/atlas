# Context Map

Atlas uses the **multi-context** domain-doc layout (adopted 2026-08-17). This file names
every bounded context and points at the `CONTEXT.md` that governs it. Consumer rules:
[docs/agents/domain.md](docs/agents/domain.md).

## Status: the split is COMPLETE — 18 of 18 extracted

⚠️ **Every row below points at a real file now — but still read the *Governed by* and
*Notes* columns**, because they say what each context IS: one is marked stale, one is history
only. All eighteen were extracted between 2026-08-17 and 2026-08-30; the root
[`CONTEXT.md`](CONTEXT.md) shrank from ~68 KB to ~1 KB and now holds only the vocabulary rule
and a pointer back here.

This map lists no path that does not exist. A map naming files that were never written would
be the same defect this repo spent 2026-08-17 removing from its agent docs — a pointer that
reads as authoritative, sends you nowhere, and stops you searching. **When a context is
extracted, its row moves in the same commit that creates its file**; nothing here may point
at the root file for prose that has left it.

Tracking issue for the split: **[#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)**.
The last context came out 2026-08-30. It was deliberately incremental — one commit per
context, each moving its row here in the same commit — because each extraction is a chance
to re-verify prose nobody has read in months. The first three did exactly that:
*Deployment posture* went out marked **stale** (its "no external customers" window predates
the 2026-07-24 public-launch tag) and *Notebooks* went out fenced as history.

**A new context is added the same way**: write `docs/contexts/<name>/CONTEXT.md` and add its
row below in the same commit. The root `CONTEXT.md` is no longer a place to put context
prose — it is the front door and the vocabulary rule, nothing more.

## Contexts

Derived from the root `CONTEXT.md`'s own section structure as it stood before the split —
these are the seams the domain doc already used, not a new taxonomy imposed on it. Note they
cut **across** workspace packages; the Company Atlas context alone spans
`packages/api/src/lib/brain/**`, `/admin/brain` in `packages/web`, and its migrations.

| Context | Governed by | Notes |
| --- | --- | --- |
| Pillars (the product's four-pillar frame) | [`docs/contexts/pillars/CONTEXT.md`](docs/contexts/pillars/CONTEXT.md) | the frame the rest hangs off |
| Company Atlas | [`docs/contexts/company-atlas/CONTEXT.md`](docs/contexts/company-atlas/CONTEXT.md) | ADR-0038; stored as `brain_*`, see the two-vocabulary rule. ADR-0044 bounds what may be done with the material: fact content never enters model weights, and customer data is never a training corpus |
| Chat Platform mechanics | [`docs/contexts/chat-platform-mechanics/CONTEXT.md`](docs/contexts/chat-platform-mechanics/CONTEXT.md) | eight chat-platform adapters |
| Chat turn presentation | [`docs/contexts/chat-turn-presentation/CONTEXT.md`](docs/contexts/chat-turn-presentation/CONTEXT.md) | |
| Conversation scope | [`docs/contexts/conversation-scope/CONTEXT.md`](docs/contexts/conversation-scope/CONTEXT.md) | |
| Knowledge Base mechanics | [`docs/contexts/knowledge-base-mechanics/CONTEXT.md`](docs/contexts/knowledge-base-mechanics/CONTEXT.md) | ADR-0028 |
| Semantic layer scoping | [`docs/contexts/semantic-layer-scoping/CONTEXT.md`](docs/contexts/semantic-layer-scoping/CONTEXT.md) | |
| Semantic improvement | [`docs/contexts/semantic-improvement/CONTEXT.md`](docs/contexts/semantic-improvement/CONTEXT.md) | |
| Learned query patterns | [`docs/contexts/learned-query-patterns/CONTEXT.md`](docs/contexts/learned-query-patterns/CONTEXT.md) | |
| Query Cache | [`docs/contexts/query-cache/CONTEXT.md`](docs/contexts/query-cache/CONTEXT.md) | |
| Dashboard editing | [`docs/contexts/dashboard-editing/CONTEXT.md`](docs/contexts/dashboard-editing/CONTEXT.md) | ADR-0029, draft-first |
| MCP & agent governance | [`docs/contexts/mcp-agent-governance/CONTEXT.md`](docs/contexts/mcp-agent-governance/CONTEXT.md) | ADR-0016, ADR-0018 |
| Plugin lifecycle | [`docs/contexts/plugin-lifecycle/CONTEXT.md`](docs/contexts/plugin-lifecycle/CONTEXT.md) | |
| Install models | [`docs/contexts/install-models/CONTEXT.md`](docs/contexts/install-models/CONTEXT.md) | |
| Deployment posture | [`docs/contexts/deployment-posture/CONTEXT.md`](docs/contexts/deployment-posture/CONTEXT.md) | 🔒 **window CLOSED 2026-08-18** — expand-contract is the default; no standing authorization to break anything |
| Operator vs Customer | [`docs/contexts/operator-vs-customer/CONTEXT.md`](docs/contexts/operator-vs-customer/CONTEXT.md) | |
| Lead source (CRM acquisition) | [`docs/contexts/lead-source/CONTEXT.md`](docs/contexts/lead-source/CONTEXT.md) | |
| Notebooks | [`docs/contexts/notebooks/CONTEXT.md`](docs/contexts/notebooks/CONTEXT.md) | 🪦 **retired** — kept so the words don't dangle; read only for history |

System-wide decisions stay in [`docs/adr/`](docs/adr/) (44 ADRs). A context gets its own
`docs/adr/` only once it has a decision that is genuinely local to it.
