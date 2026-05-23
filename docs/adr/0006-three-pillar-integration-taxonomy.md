# ADR-0006: Three-pillar taxonomy for external integrations

**Status:** Accepted
**Date:** 2026-05-23
**Context milestone:** 1.5.3 — Multi-Platform Install Models
**Depends on:** [ADR-0002](./0002-catalog-seeded-from-config-at-boot.md), [ADR-0003](./0003-two-store-chat-install-metadata-credentials.md)

## Context

Atlas reaches the outside world in three operationally distinct ways, but the codebase and admin UX historically treated them as two buckets:

- **`/admin/connections`** — datasources Atlas reads from (Postgres, MySQL, Snowflake, ClickHouse, BigQuery, DuckDB, Salesforce)
- **`/admin/integrations`** — everything else: chat platforms (Slack, Teams, Discord, …), action targets (GitHub, Linear, Email, Webhooks)

Salesforce lived in both: it's a queryable datasource (SOQL) *and* it has an OAuth install handler in the integrations machinery (`packages/api/src/lib/integrations/install/salesforce-oauth-handler.ts`). The `DB_TYPES` list put it on `/admin/connections`; the catalog-section comment in `packages/web/src/app/admin/integrations/catalog-section.tsx:9` referenced it as an OAuth integration. The install plumbing only worked through the integrations flow; the connections page entry was a stub.

CONTEXT.md's existing **Platform** definition overloaded the term — it covered chat platforms (Slack, Teams, …) *and* action targets (GitHub, Linear), even though GitHub isn't a chat surface and users don't talk to Atlas through it. The catalog's `IntegrationsCatalogEntry.type` already half-acknowledged this by typing entries as `"chat" | "integration"`, but the user-facing taxonomy didn't follow through.

GitHub and Linear introduce a further wrinkle: both are Action Targets *and* potential Datasources (the agent could query "show me PRs waiting longest for review" against the same GitHub install that creates issues). The mutual-exclusivity assumption embedded in "one slug, one pillar" doesn't survive contact with these systems.

## Decision

**Three pillars, mutually exclusive at the catalog-row level. Systems that span pillars carry multiple catalog rows.**

| Pillar | Definition | UI surface | Examples |
|---|---|---|---|
| **Datasource** | Atlas reads tabular data from it (SQL/SOQL/equivalent) | `/admin/connections` | Postgres, MySQL, Snowflake, ClickHouse, BigQuery, DuckDB, Salesforce |
| **Chat Platform** | Customer talks to Atlas through it | `/admin/integrations` (chat section) | Slack, Teams, Discord, Google Chat, Telegram, WhatsApp |
| **Action Target** | Atlas writes to / acts on it | `/admin/integrations` (actions section) | GitHub, Linear, Email, Webhooks |

Two rules ride alongside the taxonomy:

1. **One user-facing surface per pillar.** A given catalog row appears on exactly one admin page, determined by its pillar. The install **handler** (OAuth / Form / Static-bot per ADR-0003-adjacent install-models doc) is orthogonal — a Datasource can use OAuth (Salesforce), a Chat Platform can use Static-bot (Telegram). Pillar determines *where it appears*; handler determines *how credentials are obtained*. Conflating the two would put OAuth Datasources on the integrations page just because OAuth catalog cards live there today — that's an install-mechanism leak into user-facing taxonomy.

2. **Multi-pillar systems carry multiple catalog rows.** GitHub-as-Action-Target ships as catalog slug `github` (Action Target pillar). A future GitHub-as-Datasource ships as `github-data` (Datasource pillar). Each row has its own install, its own credentials, its own disconnect. This extends the existing pattern from CONTEXT.md's "Multi-mode integrations" section (Linear-OAuth vs Linear-APIkey as separate rows): the rule generalizes to one catalog row per `(system, pillar, install_mode)`.

## Alternatives considered

### Two pillars (rejected)

Collapse Chat Platform + Action Target into one "Integrations" pillar. This matches the user's initial framing and matches the current `/admin/integrations` page scope. Rejected because:

- The install lifecycle is the same, but the *user mental model* differs: customers think of chat platforms as "where I use Atlas" and action targets as "what Atlas does for me." Forcing a single section blurs this and crowds the page.
- The catalog already types entries as `"chat" | "integration"`, so the split exists at the data layer; refusing to surface it in UI is the inconsistency.
- "Integration" as the umbrella term for B+C is overloaded with the *file path* `/admin/integrations` and CONTEXT.md's historical use — the word can't both name the umbrella and one of the halves cleanly.

### Strict mutual exclusivity, one pillar per system (rejected)

GitHub = Action Target, period. If you want to query GitHub data, sync it to Postgres first. Cleaner glossary, but forecloses a real feature direction (the agent querying issue trackers / repos / tickets for analytics) and ignores that Salesforce already proves the OAuth-Datasource pattern works.

### Multi-pillar via single catalog row with `pillars[]` array (rejected)

One GitHub catalog row, `pillars: ["action", "datasource"]`, single install grants both capabilities. Pro: single OAuth dance, single credential set. Rejected on **least-privilege grounds**: customers who want Atlas to query their GitHub data are not necessarily the same customers who want Atlas to write to GitHub. Bundling forces a permission superset. Also breaks the one-surface-per-pillar rule by forcing every admin page to handle "this entry is also relevant to other pages," which makes disconnect semantics murky (does removing from Connections also remove from Integrations?).

## Consequences

**For the catalog:**

- `IntegrationsCatalogEntry.type` semantically grows from `"chat" | "integration"` to `"datasource" | "chat" | "action"` (or equivalent — wire-level rename can come with [ADR-0007](./0007-unified-install-pipeline.md))
- A `pillar` field becomes a first-class catalog column (see ADR-0007 for the schema shape)
- Pre-existing slugs (`slack`, `github`, `linear`, etc.) stay unchanged. When a future Datasource version of GitHub lands, it gets a new slug (`github-data`) rather than the existing row being repurposed.

**For admin UX:**

- `/admin/connections` is the home of Datasources. Salesforce moves there exclusively (its catalog row's UI rendering, not its install handler); the integrations-catalog stub disappears.
- `/admin/integrations` splits visibly into Chat and Action sections — the data shape is already there in the catalog's existing type field.
- The legacy per-platform chrome on `/admin/integrations` (Slack/Teams/Discord/… cards rendered below `<CatalogSection />`) retires; install + disconnect lift onto catalog cards per the stated TODO at `packages/web/src/app/admin/integrations/page.tsx:24`.

**For the glossary:**

- `CONTEXT.md` retires the overloaded **Platform** definition in favor of narrowed **Chat Platform**. **Datasource** and **Action Target** become first-class terms. The new "Pillars" section is the canonical home for the three-way split.
- `Workspace Connection` (the chat OAuth handshake) stays chat-pillar specific. Action Target installs are described as **Workspace Installs**, not Workspace Connections — credentials live in `integration_credentials`, not `chat_cache`.

**For future systems:**

- Onboarding a new third-party system starts with the pillar question, not the install-handler question. "Is this something Atlas reads from, something customers talk to Atlas through, or something Atlas acts on?" Answer determines admin surface; install model is a follow-on.
- Multi-pillar systems are explicitly supported — `github-data`, `linear-data` are future catalog slugs that don't require revisiting this ADR.

## References

- Pillar definitions: `CONTEXT.md` → "Pillars" section
- One-surface-per-pillar rule: `CONTEXT.md` → "One user-facing surface per pillar"
- Multi-pillar pattern: `CONTEXT.md` → "Multi-pillar systems"
- Catalog wire shape today: `packages/api/src/api/routes/integrations.ts`, `packages/web/src/ui/lib/admin-schemas.ts` (`IntegrationsCatalogEntry`)
- See [ADR-0007](./0007-unified-install-pipeline.md) for the install-pipeline unification that makes this taxonomy enforceable at the schema layer.
