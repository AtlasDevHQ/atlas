# Atlas Domain Context

Canonical terminology for Atlas. This document is a glossary, not a spec — implementation details belong in code, ADRs, or `architecture-wins.md`.

When you find yourself reaching for one of these words, use the canonical form. When you see a term used loosely in conversation or code, sharpen it back to one of these.

> **This file is the UN-SPLIT REMAINDER, not the whole domain.** Atlas uses the
> multi-context layout ([CONTEXT-MAP.md](CONTEXT-MAP.md)); eighteen of its eighteen contexts
> have been extracted and are **not** in this file (#5302):
>
> | Context | Now lives in |
> | --- | --- |
> | Company Atlas | [docs/contexts/company-atlas/CONTEXT.md](docs/contexts/company-atlas/CONTEXT.md) |
> | Deployment posture | [docs/contexts/deployment-posture/CONTEXT.md](docs/contexts/deployment-posture/CONTEXT.md) — ⚠️ marked stale 2026-08-17 |
> | Notebooks (retired) | [docs/contexts/notebooks/CONTEXT.md](docs/contexts/notebooks/CONTEXT.md) — history only |
> | Pillars | [docs/contexts/pillars/CONTEXT.md](docs/contexts/pillars/CONTEXT.md) |
> | Chat Platform mechanics | [docs/contexts/chat-platform-mechanics/CONTEXT.md](docs/contexts/chat-platform-mechanics/CONTEXT.md) |
> | Knowledge Base mechanics | [docs/contexts/knowledge-base-mechanics/CONTEXT.md](docs/contexts/knowledge-base-mechanics/CONTEXT.md) |
> | Plugin lifecycle | [docs/contexts/plugin-lifecycle/CONTEXT.md](docs/contexts/plugin-lifecycle/CONTEXT.md) |
> | Install models | [docs/contexts/install-models/CONTEXT.md](docs/contexts/install-models/CONTEXT.md) |
> | Operator vs Customer | [docs/contexts/operator-vs-customer/CONTEXT.md](docs/contexts/operator-vs-customer/CONTEXT.md) |
> | Conversation scope | [docs/contexts/conversation-scope/CONTEXT.md](docs/contexts/conversation-scope/CONTEXT.md) |
> | Semantic layer scoping | [docs/contexts/semantic-layer-scoping/CONTEXT.md](docs/contexts/semantic-layer-scoping/CONTEXT.md) |
> | Semantic improvement | [docs/contexts/semantic-improvement/CONTEXT.md](docs/contexts/semantic-improvement/CONTEXT.md) |
> | Learned query patterns | [docs/contexts/learned-query-patterns/CONTEXT.md](docs/contexts/learned-query-patterns/CONTEXT.md) |
> | Chat turn presentation | [docs/contexts/chat-turn-presentation/CONTEXT.md](docs/contexts/chat-turn-presentation/CONTEXT.md) |
> | Dashboard editing | [docs/contexts/dashboard-editing/CONTEXT.md](docs/contexts/dashboard-editing/CONTEXT.md) |
> | MCP & agent governance | [docs/contexts/mcp-agent-governance/CONTEXT.md](docs/contexts/mcp-agent-governance/CONTEXT.md) |
> | Query Cache | [docs/contexts/query-cache/CONTEXT.md](docs/contexts/query-cache/CONTEXT.md) |
> | Lead source (CRM acquisition) | [docs/contexts/lead-source/CONTEXT.md](docs/contexts/lead-source/CONTEXT.md) |
>
> They were moved, not copied: no section below duplicates them. The remaining zero
> sections are still governed here, and the map says so per row.
