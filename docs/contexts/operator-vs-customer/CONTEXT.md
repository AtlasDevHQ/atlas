# Operator vs Customer

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Operator vs Customer` section, moved unchanged except that
> relative links are repathed for the new depth. It is no longer in the root file.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


Atlas runs in two deploy modes: **SaaS** (one operator, many customers) and **self-host** (operator and customer are the same party). The terms below refer to the role, not the person — on self-host one person plays both.

- **Operator** — the party who runs the Atlas instance. Owns the deploy, the App Registrations, the catalog seed (`atlas.config.ts`), the infrastructure choices (sandbox priority, scheduler backend, residency regions). Controls what's *possible*.
- **Customer admin** — the party who configures a specific Workspace. Owns Workspace Connections, integration installs, per-Workspace config (channel allowlists, model selection, BYOT credentials, etc.). Controls what's *active* for their Workspace.
- **The seam** — where Operator capability meets Customer activation. Lives at `plugin_catalog` (operator declares) → `workspace_plugins` (customer activates). Any surface that puts Customer concerns into operator-only space (e.g. requiring an `atlas.config.ts` edit to add a Platform per customer) is a **leak** of self-host shape into SaaS shape. See ADRs 0001–0003 for closing the chat-Platform leak.
