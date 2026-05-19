# ADR-0002: Plugin Catalog is seeded from `atlas.config.ts` at boot (S3)

**Status:** Accepted
**Date:** 2026-05-19
**Context milestone:** Multi-Adapter SaaS Readiness (forthcoming)
**Depends on:** [ADR-0001](./0001-saas-uses-one-app-registration-per-platform.md)

## Context

SaaS needs a runtime-queryable surface that answers two questions:

- Customer admin UI: "What Platforms / integrations can this Workspace install?"
- Listener / agent loop: "What does this Workspace have actually installed?"

Today, `atlas.config.ts:plugins[]` is the only declaration of what an Atlas deployment knows how to do. It's a TypeScript array constructed at boot. The customer UI has no clean way to read it; the listener has no canonical join point against it.

Meanwhile, `plugin_catalog` + `workspace_plugins` tables exist in the schema (with `catalog_id`, `min_plan`, `enabled`, `config` JSONB) but are not consistently populated by the chat plugin's wiring path. Two parallel wiring concepts compete.

Three options were considered for resolving this:

- **S1 — Code-static, no catalog truth.** Keep `atlas.config.ts:plugins[]` as the only declaration. Admin UI introspects plugin instances at runtime. Customers cannot see plan-gated lists; ops cannot emergency-disable a Platform without a deploy.
- **S2 — DB-canonical, code-empty.** `plugin_catalog` is the source of truth. New Platform = insert catalog row + set env vars + deploy. Atlas reads catalog at boot to know what to instantiate. SaaS multi-region introduces a manual-seed-per-region burden; bootstrap problem on first deploy of a new region.
- **S3 — Config-driven, idempotently seeded into catalog.** `atlas.config.ts` is authoritative at deploy time. On boot, a seed pass upserts `plugin_catalog` rows from the configured capabilities. Catalog becomes the canonical runtime read surface; code remains the canonical authoring surface.

## Decision

**S3.** `atlas.config.ts` declares operator-level capability (Platforms supported, integrations available, tools enabled). On each boot, an idempotent seed pass writes / updates `plugin_catalog` rows to match. After seed, `plugin_catalog` is the single source of truth for runtime reads — admin UI, listener gating, billing tier checks all query the catalog.

Ops retains an escape hatch: `UPDATE plugin_catalog SET enabled = false WHERE slug = 'x'` flips a Platform off globally without a deploy. This is allowed to drift from `atlas.config.ts` deliberately (e.g. emergency disable); the next deploy's seed will reset it if the operator hasn't updated config.

## Plugin lifecycle: eager vs lazy

The catalog covers both kinds; their `atlas.config.ts` presence differs:

- **Eager plugins** — need boot-time registration (event-loop subscribers, webhook handlers, scheduler hooks). The chat plugin is the canonical eager plugin: it must instantiate adapters at boot to receive Slack events. Eager plugins live in `atlas.config.ts:plugins[]` AND seed catalog rows.
- **Lazy plugins** — consulted per-request at runtime (Salesforce queries, Jira lookups, query-time integrations). They live in `plugin_catalog` only; the agent loop loads them on first per-workspace use. `atlas.config.ts:plugins[]` does not need an entry.

The seed pass handles both: eager-plugin rows are written based on the plugin's own self-declaration; lazy-plugin rows can be defined in a separate `atlas.config.ts:integrations[]` block (or similar) that describes capabilities without wiring lifecycles.

## Alternatives considered

### S1 — Code-static (rejected)

Cannot answer "what's available in this Workspace's plan" without runtime plugin introspection, which is brittle and couples the admin UI to plugin internals. Emergency-disable requires a deploy. No clean future path to community/third-party marketplace.

### S2 — DB-canonical (rejected)

Manual catalog seeding per region creates drift between us/eu/apac. Bootstrap problem: a new region deploys with an empty catalog and zero functionality until someone runs a seed script. Loses code-as-config ergonomics for operators. Justifiable only if a future requirement demands runtime catalog mutation that doesn't have a code analog — none today.

## Consequences

**For SaaS:**
- Multi-region consistency: same code → same seed → identical catalog across us/eu/apac
- Plan gating native: `plugin_catalog.min_plan` checked at customer-install time
- Emergency disable: ops flips `plugin_catalog.enabled` per region without a deploy
- Future marketplace runway: catalog can hold rows not backed by `atlas.config.ts` code

**For self-host:**
- Small `atlas.config.ts` → small catalog → operator's own workspace installs from it like a customer would on SaaS
- Same primitive serves both deploy modes; no bifurcation

**For chat specifically:**
- The chat plugin stays in `atlas.config.ts:plugins[]` (eager, registers listener)
- Its `adapters: { slack: {...} }` shape changes: instead of per-platform config nested inside, the plugin reads supported Platforms from the catalog at boot
- Customer activation goes through `workspace_plugins` (not the `adapters` config), with Workspace Connections (bot tokens) in `chat_cache` per ADR-0003

**For integration plugins (Salesforce, Jira, etc.):**
- They leave `atlas.config.ts:plugins[]` entirely (lazy)
- Defined in a new `atlas.config.ts:integrations[]` (or similar) declaration that seeds catalog rows
- Workspaces install from the catalog; agent loop loads on first per-workspace use

## References

- `plugin_catalog` and `workspace_plugins` schema: `packages/api/src/lib/db/schema.ts`
- Chat plugin entry: `plugins/chat/src/index.ts`
- Existing chat install token store: `chat_cache` (post-#2634)
- See `CONTEXT.md` for canonical terminology
