# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring
the codebase. **This repo is multi-context** (chosen 2026-08-17).

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it names every context and points at the
  `CONTEXT.md` that covers it. Read each one relevant to your topic.
- **`docs/adr/`** at the repo root — system-wide decisions (41 ADRs today). Read the ones
  touching the area you're about to work in.
- Context-scoped ADRs where a context has extracted its own (docs/contexts/\*/docs/adr/).

If any of these don't exist, **proceed silently**. Don't flag their absence or suggest
creating them upfront; `/domain-modeling` (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get
resolved.

⚠️ **Read `CONTEXT-MAP.md` before assuming a context has its own file.** The map is
mid-migration: the layout is multi-context, but most contexts are still covered by the root
`CONTEXT.md` and have not been extracted yet. The map states which is which, per context,
and it is authoritative. Do not infer a `packages/<name>/CONTEXT.md` from the layout — check
the map, because a path that looks like it should exist and doesn't is how a reader stops
searching.

Concretely, today: **three of the eighteen contexts have their own file** under
`docs/contexts/` — Company Atlas, Deployment posture, Notebooks (#5302) — and the root
`CONTEXT.md` still governs the other fifteen. The map's *Governed by* column is the
per-context answer; this sentence is a summary and the map wins.

## File structure

**Contexts here are domain concerns, not workspace packages.** That is worth stating,
because the monorepo layout invites the wrong guess: Atlas is a bun workspace
(`packages/*`, `apps/*`, `plugins/*`, `ee/`), but the existing `CONTEXT.md` is already
organised by bounded context — *Company Atlas*, *Chat Platform mechanics*, *Knowledge Base
mechanics*, *Semantic layer scoping*, *Dashboard editing*, *MCP & agent governance* — and
most of those cut across several packages. The Company Atlas context alone spans
`packages/api/src/lib/brain/**`, `packages/web`'s `/admin/brain`, and migrations.

Split along those seams, not along `packages/*`:

```
/
├── CONTEXT-MAP.md                     ← names every context, points at its CONTEXT.md
├── CONTEXT.md                         ← the un-split remainder; still covers every
│                                        context not yet extracted
├── docs/adr/                          ← system-wide decisions (41 today)
└── docs/contexts/
    ├── company-atlas/CONTEXT.md       ← extracted 2026-08-17
    ├── deployment-posture/CONTEXT.md  ← extracted 2026-08-17 (marked stale)
    └── notebooks/CONTEXT.md           ← extracted 2026-08-17 (history only)
```

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a hypothesis,
a test name), use the term as defined in the governing `CONTEXT.md`. Don't drift to synonyms
the glossary explicitly avoids.

⚠️ Atlas carries **two deliberate vocabularies** and they are not drift. The product noun is
*Atlas*; the storage/internal noun is still *brain* (`brain_facts`, `lib/brain/**`,
`/admin/brain`, `ATLAS_BRAIN_*`, the `searchBrain` tool). Rule of thumb: **if a customer
reads it, it says Atlas; if only we read it, it still says brain.** See ADR-0038 before
"fixing" either one.

If a concept you need isn't in the glossary, that's a signal — either you're inventing
language the project doesn't use (reconsider), or there's a real gap (note it for
`/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it rather than silently overriding:

> _Contradicts ADR-0007 — but worth reopening because…_
