# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring
the codebase. **This repo is multi-context** (chosen 2026-08-17).

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it names every context and points at the
  `CONTEXT.md` that covers it. Read each one relevant to your topic.
- **`docs/adr/`** at the repo root — system-wide decisions (44 ADRs today). Read the ones
  touching the area you're about to work in.
- Context-scoped ADRs where a context has extracted its own (`docs/contexts/<name>/docs/adr/`).

If any of these don't exist, **proceed silently**. Don't flag their absence or suggest
creating them upfront; `/domain-modeling` (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get
resolved.

⚠️ **Read `CONTEXT-MAP.md` to find the file a context lives in.** Do not infer a
`packages/<name>/CONTEXT.md` from the layout — contexts are domain concerns, not packages,
and a path that looks like it should exist and doesn't is how a reader stops searching.

Concretely, today: **the split is complete** — all eighteen contexts have their own file at
`docs/contexts/<name>/CONTEXT.md` (#5302), and the root `CONTEXT.md` holds no context prose.
It is kept as the front door: the vocabulary rule that applies to every context, plus a
pointer back to the map. The map's *Governed by* column is still where you look, because it
also carries what each context IS — *Deployment posture* is marked stale, *Notebooks* is
history only. This sentence is a summary and the map wins.

## File structure

**Contexts here are domain concerns, not workspace packages.** That is worth stating,
because the monorepo layout invites the wrong guess: Atlas is a bun workspace
(`packages/*`, `apps/*`, `plugins/*`, `ee/`), but the root `CONTEXT.md` was already
organised by bounded context — *Company Atlas*, *Chat Platform mechanics*, *Knowledge Base
mechanics*, *Semantic layer scoping*, *Dashboard editing*, *MCP & agent governance* — and
most of those cut across several packages. The Company Atlas context alone spans
`packages/api/src/lib/brain/**`, `packages/web`'s `/admin/brain`, and migrations.

The split followed those seams, not `packages/*`:

```
/
├── CONTEXT-MAP.md                     ← names every context, points at its CONTEXT.md
├── CONTEXT.md                         ← front door only: the vocabulary rule and a pointer
│                                        to the map. No context prose lives here.
├── docs/adr/                          ← system-wide decisions (44 today)
└── docs/contexts/                     ← one directory per context, eighteen of them
    ├── company-atlas/CONTEXT.md       ← extracted 2026-08-17
    ├── deployment-posture/CONTEXT.md  ← extracted 2026-08-17 (marked stale)
    ├── notebooks/CONTEXT.md           ← extracted 2026-08-17 (history only)
    └── …                              ← the other fifteen, extracted 2026-08-30
```

**A new context is a new directory here plus a new row in the map, in the same commit.** The
root `CONTEXT.md` is not a place to add context prose any more.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a hypothesis,
a test name), use the term as defined in that context's `docs/contexts/<name>/CONTEXT.md`.
Don't drift to synonyms the glossary explicitly avoids.

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
