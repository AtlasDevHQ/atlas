# Plugin lifecycle

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Plugin lifecycle` section verbatim — only the relative links are repathed for the new depth — and it is no longer there.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


- **Plugin Catalog** — the runtime registry of plugins / integrations available on a deployment. Backed by the `plugin_catalog` table. Seeded from `atlas.config.ts` at boot (see [ADR-0002](../../adr/0002-catalog-seeded-from-config-at-boot.md)). Holds `min_plan`, `enabled`, `config_schema` per entry. Ops can flip `enabled` for emergency disable. **Operator-curated only**: every runtime path that creates or mutates catalog rows is operator-authored, enforced at the write seam by `assertOperatorCatalogWrite` (`lib/plugins/catalog-provenance.ts`, #4174; INSERT/UPDATE sites drift-pinned by its test) — third-party/community plugin submission is gated on plugin-execution isolation (#4099).
- **Workspace Install** — a `workspace_plugins` row indicating a specific Workspace has installed a specific catalog entry. Per-(Workspace × catalog_id). Holds the per-Workspace install metadata: who installed, when, per-Workspace config. Does **not** hold credentials — those live in store-of-record per plugin type (e.g. `chat_cache` for chat platforms per [ADR-0003](../../adr/0003-two-store-chat-install-metadata-credentials.md)).
- **Eager plugin** — a plugin that needs boot-time registration to do its job. The chat plugin is canonical: must instantiate Adapter classes and subscribe to listener events before the first request arrives. Eager plugins live in `atlas.config.ts:plugins[]` and seed catalog rows.
- **Lazy plugin** — a plugin consulted per-request, instantiable on demand. Salesforce, Jira, query-time integrations. Lives only in `plugin_catalog`; loaded by the agent loop on first per-Workspace use. Not present in `atlas.config.ts:plugins[]`.
