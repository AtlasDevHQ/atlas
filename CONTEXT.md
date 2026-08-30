# Atlas Domain Context

Canonical terminology for Atlas. This document is a glossary, not a spec — implementation details belong in code, ADRs, or `architecture-wins.md`.

When you find yourself reaching for one of these words, use the canonical form. When you see a term used loosely in conversation or code, sharpen it back to one of these.

> **The split is COMPLETE — no context prose lives in this file.** Atlas uses the
> multi-context layout, and all eighteen of its bounded contexts now have their own file
> under [docs/contexts/](docs/contexts/) (#5302).
> **[CONTEXT-MAP.md](CONTEXT-MAP.md) is the entry point**: it names every context, points at
> the file that governs it, and carries the per-context notes — which one is stale, which is
> history-only.
>
> Every section was **moved, never copied**, so each term has exactly one home. If you
> arrived here from a reference to `CONTEXT.md § <section>`, that section is a
> `docs/contexts/<name>/CONTEXT.md` today and the map says which one.
>
> This file is kept as the front door rather than deleted: the two paragraphs above are the
> vocabulary rule for **all** eighteen contexts, not for any one of them. Consumer rules for
> agents: [docs/agents/domain.md](docs/agents/domain.md).
