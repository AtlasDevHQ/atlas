# Context Map

Atlas uses the **multi-context** domain-doc layout (adopted 2026-08-17). This file names
every bounded context and points at the `CONTEXT.md` that governs it. Consumer rules:
[docs/agents/domain.md](docs/agents/domain.md).

## Status: the split is underway — 3 of 18 extracted

⚠️ **Read the *Governed by* column before following any path below.** It says, per context,
whether that context has its own file yet. Three do; the other fifteen are still sections of
the root [`CONTEXT.md`](CONTEXT.md), which shrank from ~85 KB to ~67 KB when they left.

This map lists no path that does not exist. A map naming files that were never written would
be the same defect this repo spent 2026-08-17 removing from its agent docs — a pointer that
reads as authoritative, sends you nowhere, and stops you searching. **When a context is
extracted, its row moves in the same commit that creates its file**; nothing here may point
at the root file for prose that has left it.

Tracking issue for the split: **[#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)**.
It is deliberately incremental — each extraction is a chance to re-verify prose nobody has
read in months, and the first three did exactly that: *Deployment posture* went out marked
**stale** (its "no external customers" window predates the 2026-07-24 public-launch tag) and
*Notebooks* went out fenced as history.

## Contexts

Derived from `CONTEXT.md`'s own section structure — these are the seams the domain doc
already uses, not a new taxonomy imposed on it. Note they cut **across** workspace packages;
the Company Atlas context alone spans `packages/api/src/lib/brain/**`, `/admin/brain` in
`packages/web`, and its migrations.

| Context | Governed by | Notes |
| --- | --- | --- |
| Pillars (the product's four-pillar frame) | `CONTEXT.md` § Pillars | the frame the rest hangs off |
| Company Atlas | [`docs/contexts/company-atlas/CONTEXT.md`](docs/contexts/company-atlas/CONTEXT.md) | ADR-0038; stored as `brain_*`, see the two-vocabulary rule |
| Chat Platform mechanics | `CONTEXT.md` § Chat Platform mechanics | eight chat-platform adapters |
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
| Deployment posture | [`docs/contexts/deployment-posture/CONTEXT.md`](docs/contexts/deployment-posture/CONTEXT.md) | 🔒 **window CLOSED 2026-08-18** — expand-contract is the default; no standing authorization to break anything |
| Operator vs Customer | `CONTEXT.md` § Operator vs Customer | |
| Lead source (CRM acquisition) | `CONTEXT.md` § Lead source | |
| Notebooks | [`docs/contexts/notebooks/CONTEXT.md`](docs/contexts/notebooks/CONTEXT.md) | 🪦 **retired** — kept so the words don't dangle; read only for history |

System-wide decisions stay in [`docs/adr/`](docs/adr/) (41 ADRs). A context gets its own
`docs/adr/` only once it has a decision that is genuinely local to it.
